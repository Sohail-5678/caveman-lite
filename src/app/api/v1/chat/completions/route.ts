/**
 * POST /api/v1/chat/completions — OpenAI-compatible gateway endpoint.
 *
 * rate limit (20/min/IP) → 1 MB body cap → schema check → LiveGateway (firewall, T1/T2 cache, entity guard,
 * singleflight, router, breakers, canary scan) → SSE or JSON in the OpenAI wire format.
 *
 * Every response carries x-cache, x-route, x-firewall and x-ttft-ms. Real Groq/Gemini calls are made when
 * GROQ_API_KEY / GEMINI_API_KEY are set or the caller sends x-groq-key / x-gemini-key; otherwise the
 * deterministic streaming simulator answers and x-upstream says "simulated".
 */
import {
  corsHeaders,
  enforceRateLimit,
  errorResponse,
  MAX_BODY_BYTES,
  readJsonCapped,
} from "@/lib/server/http";
import {
  getLiveGateway,
  parseChatRequest,
  resolveProviderKeys,
  type GatewayOutcome,
  type ParsedChatRequest,
  type ServedOutcome,
} from "@/lib/gateway/live-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FINGERPRINT = "caveman-lite";

function gatewayHeaders(outcome: GatewayOutcome): Record<string, string> {
  const headers: Record<string, string> = {
    "x-request-id": outcome.requestId,
    "x-firewall": outcome.firewall.verdict,
    "x-upstream": outcome.mode,
  };
  if (outcome.kind === "blocked") {
    headers["x-cache"] = "BYPASS";
    return headers;
  }
  headers["x-cache"] = outcome.cache;
  if (outcome.kind === "served") {
    headers["x-route"] = `${outcome.route.tier}/${outcome.route.provider}/${outcome.route.model}`;
    headers["x-ttft-ms"] = outcome.ttftMs.toFixed(1);
    if (outcome.similarity !== null) headers["x-cache-similarity"] = outcome.similarity.toFixed(4);
    if (outcome.complexity !== null) headers["x-complexity"] = outcome.complexity.toFixed(3);
  }
  return headers;
}

function trace(outcome: ServedOutcome, outbound?: string) {
  return {
    request_id: outcome.requestId,
    cache: outcome.cache,
    route: outcome.route,
    upstream: outcome.mode,
    firewall: { verdict: outcome.firewall.verdict, redactions: outcome.firewall.redactions, nonce: outcome.firewall.nonce },
    ttft_ms: Math.round(outcome.ttftMs * 10) / 10,
    similarity: outcome.similarity,
    complexity: outcome.complexity,
    compression_saved: outcome.compressionSaved,
    failover: outcome.failover,
    attempts: outcome.attempts,
    ...(outbound ? { outbound } : {}),
  };
}

function sseResponse(outcome: ServedOutcome, parsed: ParsedChatRequest, headers: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const base = { id: outcome.requestId, object: "chat.completion.chunk", created, model: outcome.route.model, system_fingerprint: FINGERPRINT };
  const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  const iterator = outcome.chunks[Symbol.asyncIterator]();
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }] }));
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await iterator.next();
        if (!next.done) {
          controller.enqueue(frame({ ...base, choices: [{ index: 0, delta: { content: next.value }, logprobs: null, finish_reason: null }] }));
          return;
        }
        finished = true;
        const completion = await outcome.completion;
        controller.enqueue(
          frame({ ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }], caveman: trace(outcome, completion.outbound) }),
        );
        if (parsed.includeUsage) {
          controller.enqueue(
            frame({
              ...base,
              choices: [],
              usage: {
                prompt_tokens: completion.promptTokens,
                completion_tokens: completion.completionTokens,
                total_tokens: completion.promptTokens + completion.completionTokens,
              },
            }),
          );
        }
      } catch (error) {
        // Headers are already sent, so a mid-stream upstream failure is reported in-band.
        finished = true;
        const message = error instanceof Error ? error.message : "upstream stream failed";
        controller.enqueue(frame({ error: { message, type: "server_error", param: null, code: "upstream_stream_error" } }));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
    async cancel() {
      // Client went away. The leader's upstream stream keeps running for any followers and to fill the cache.
      finished = true;
      await iterator.return?.(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function jsonResponse(outcome: ServedOutcome, headers: Record<string, string>): Promise<Response> {
  let completion;
  try {
    completion = await outcome.completion;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream stream failed.";
    return errorResponse(502, message, { code: "upstream_stream_error", headers });
  }
  return Response.json(
    {
      id: outcome.requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: outcome.route.model,
      system_fingerprint: FINGERPRINT,
      choices: [{ index: 0, message: { role: "assistant", content: completion.text, refusal: null }, logprobs: null, finish_reason: "stop" }],
      usage: {
        prompt_tokens: completion.promptTokens,
        completion_tokens: completion.completionTokens,
        total_tokens: completion.promptTokens + completion.completionTokens,
      },
      caveman: trace(outcome, completion.outbound),
    },
    { headers: { ...headers, "x-outbound": completion.outbound, "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const cors = corsHeaders(request);

  const limit = enforceRateLimit(request, "chat", cors);
  if (!limit.ok) return limit.response;
  const base = { ...cors, ...limit.headers };

  const raw = await readJsonCapped(request, { limit: MAX_BODY_BYTES, headers: base });
  if (!raw.ok) return raw.response;

  const parsed = parseChatRequest(raw.value);
  if (!parsed.ok) return errorResponse(400, parsed.message, { param: parsed.param, code: "invalid_request", headers: base });

  const outcome = await getLiveGateway().handle(parsed.value, resolveProviderKeys(request.headers));
  const headers = { ...base, ...gatewayHeaders(outcome) };

  switch (outcome.kind) {
    case "blocked": {
      const top = outcome.firewall.hits[0];
      return errorResponse(403, `Blocked by the pre-flight firewall: ${top.owasp} ${top.label}.`, {
        type: "permission_error",
        code: "prompt_blocked",
        headers,
        extra: { firewall: { verdict: outcome.firewall.verdict, hits: outcome.firewall.hits } },
      });
    }
    case "unavailable":
      return errorResponse(outcome.status, outcome.message, {
        code: outcome.status === 429 ? "upstream_rate_limited" : "upstream_unavailable",
        headers: outcome.status === 429 ? { ...headers, "Retry-After": "30" } : headers,
        extra: { attempts: outcome.attempts },
      });
    case "served":
      return parsed.value.stream ? sseResponse(outcome, parsed.value, headers) : jsonResponse(outcome, headers);
  }
}

export function OPTIONS(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
