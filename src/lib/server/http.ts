/**
 * HTTP plumbing shared by the API routes: CORS, OpenAI-style errors, capped body reads, client IP,
 * per-route rate limiters and the admin-token bypass. Server-only.
 */
import { TokenBucketLimiter, type RateDecision } from "../security/rate-limiter";

/** Payload cap for every POST body (spec §5.4: < 1 MB). */
export const MAX_BODY_BYTES = 1_048_576;

/** Gateway headers a browser client is allowed to read. */
export const EXPOSED_HEADERS = [
  "x-cache",
  "x-route",
  "x-firewall",
  "x-ttft-ms",
  "x-upstream",
  "x-request-id",
  "x-cache-similarity",
  "x-complexity",
  "x-outbound",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "retry-after",
].join(", ");

const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization, x-groq-key, x-gemini-key";

/**
 * CORS for the public OpenAI-compatible surface. Preflights echo the requested header list so the
 * OpenAI SDK's x-stainless-* headers pass from a browser; credentials are never allowed.
 */
export function corsHeaders(request?: Request): Record<string, string> {
  const requested = request?.headers.get("access-control-request-headers");
  const allowHeaders = requested && /^[\w\-, ]{1,1024}$/.test(requested) ? requested : DEFAULT_ALLOWED_HEADERS;
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
}

export type ErrorType = "invalid_request_error" | "rate_limit_error" | "server_error" | "permission_error";

/** OpenAI-shaped error body, so SDK clients raise the right exception class. */
export function errorResponse(
  status: number,
  message: string,
  options: { type?: ErrorType; code?: string; param?: string | null; headers?: Record<string, string>; extra?: Record<string, unknown> } = {},
): Response {
  const type = options.type ?? (status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error");
  return Response.json(
    { error: { message, type, param: options.param ?? null, code: options.code ?? null, ...options.extra } },
    { status, headers: { "Cache-Control": "no-store", ...options.headers } },
  );
}

export type BodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Reads at most `limit` bytes and parses JSON. Rejects early on a declared Content-Length over the cap
 * and stops reading a chunked body the moment it crosses it, so an oversized upload never buffers fully.
 */
export async function readJsonCapped<T = unknown>(
  request: Request,
  options: { limit?: number; headers?: Record<string, string>; allowEmpty?: boolean } = {},
): Promise<BodyResult<T | undefined>> {
  const limit = options.limit ?? MAX_BODY_BYTES;
  const headers = options.headers ?? {};
  const tooLarge = () =>
    errorResponse(413, `Request body exceeds the ${limit.toLocaleString("en-US")}-byte limit.`, { code: "payload_too_large", headers });
  const empty = (): BodyResult<T | undefined> =>
    options.allowEmpty
      ? { ok: true, value: undefined }
      : { ok: false, response: errorResponse(400, "Request body is empty.", { code: "empty_body", headers }) };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, response: tooLarge() };
  if (!request.body) return empty();

  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, response: tooLarge() };
    }
    parts.push(value);
  }
  if (size === 0) return empty();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T };
  } catch {
    return { ok: false, response: errorResponse(400, "Request body is not valid JSON.", { code: "invalid_json", headers }) };
  }
}

/** First hop of x-forwarded-for (Vercel sets it), then x-real-ip; "anonymous" when neither is present. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  return request.headers.get("x-real-ip")?.trim().slice(0, 64) || "anonymous";
}

/** Constant-time string comparison, so the admin token can't be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  const m = auth?.match(/^Bearer\s+(\S{1,512})$/i);
  return m ? m[1] : null;
}

/** A request carrying `Authorization: Bearer $GATEWAY_ADMIN_TOKEN` skips the public rate limit. */
export function isAdmin(request: Request): boolean {
  const admin = process.env.GATEWAY_ADMIN_TOKEN;
  const token = bearerToken(request);
  return Boolean(admin && admin.length >= 16 && token && safeEqual(token, admin));
}

// ---------------------------------------------------------------------------------------------
// Rate limiters (20 req / min / IP per route family). Kept on globalThis so dev-mode HMR and
// multiple route modules in one serverless instance share the same buckets.
// ---------------------------------------------------------------------------------------------

export type LimiterName = "chat" | "burst-sim" | "shadow-evals" | "security-bench";

const LIMITERS_KEY = Symbol.for("caveman-lite.rate-limiters");
type LimiterRegistry = Map<LimiterName, TokenBucketLimiter>;

function registry(): LimiterRegistry {
  const g = globalThis as unknown as Record<symbol, LimiterRegistry | undefined>;
  return (g[LIMITERS_KEY] ??= new Map());
}

export function limiter(name: LimiterName): TokenBucketLimiter {
  const map = registry();
  let l = map.get(name);
  if (!l) {
    l = new TokenBucketLimiter({ capacity: 20 });
    map.set(name, l);
  }
  return l;
}

/** Test hook: forget every bucket (or install limiters with a custom clock). */
export function resetLimiters(factory?: () => TokenBucketLimiter): void {
  const map = registry();
  map.clear();
  if (factory) for (const name of ["chat", "burst-sim", "shadow-evals", "security-bench"] as LimiterName[]) map.set(name, factory());
}

export function rateLimitHeaders(decision: RateDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
  };
  if (!decision.allowed) headers["Retry-After"] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
  return headers;
}

/**
 * Takes one token for the caller's IP. Returns the headers to attach on success, or a ready 429.
 */
export function enforceRateLimit(
  request: Request,
  name: LimiterName,
  extraHeaders: Record<string, string> = {},
): { ok: true; headers: Record<string, string> } | { ok: false; response: Response } {
  if (isAdmin(request)) return { ok: true, headers: {} };
  const decision = limiter(name).take(clientIp(request));
  const headers = rateLimitHeaders(decision);
  if (decision.allowed) return { ok: true, headers };
  return {
    ok: false,
    response: errorResponse(429, `Rate limit reached: ${decision.limit} requests per minute per IP. Retry in ${headers["Retry-After"]}s.`, {
      code: "rate_limit_exceeded",
      headers: { ...extraHeaders, ...headers },
    }),
  };
}
