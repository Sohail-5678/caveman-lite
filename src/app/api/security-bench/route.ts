/**
 * GET  /api/security-bench — runs the 30-case verification suite (stampede, exact/semantic cache, entity guard,
 *      router, circuit breaker, compression, OWASP LLM01/LLM02/LLM07 firewall, statistics) against the real
 *      modules on the server and reports what each case measured.
 * POST /api/security-bench — red-team your own prompts: { prompts: string[] } (up to 50, 8,000 chars each)
 *      returns the firewall verdict, matched rules and redactions per prompt. An empty body runs the suite.
 */
import { enforceRateLimit, errorResponse, readJsonCapped } from "@/lib/server/http";
import { runBenchmark, type BenchmarkResult } from "@/lib/evals/gateway-benchmark";
import { inspectPrompt } from "@/lib/security/preflight-firewall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPTS = 50;
const MAX_PROMPT_CHARS = 8_000;

async function suite() {
  const started = performance.now();
  const results: BenchmarkResult[] = await runBenchmark();
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { passed: 0, total: 0 });
    c.total++;
    if (r.pass) c.passed++;
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    byCategory,
    results: results.map((r) => ({ ...r, durationMs: Math.round(r.durationMs * 1000) / 1000 })),
  };
}

export async function GET(request: Request): Promise<Response> {
  const limit = enforceRateLimit(request, "security-bench");
  if (!limit.ok) return limit.response;
  return Response.json(await suite(), { headers: { ...limit.headers, "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const limit = enforceRateLimit(request, "security-bench");
  if (!limit.ok) return limit.response;
  const headers = limit.headers;
  const raw = await readJsonCapped(request, { limit: 512_000, headers, allowEmpty: true });
  if (!raw.ok) return raw.response;
  const body = raw.value as { prompts?: unknown } | undefined;
  if (body === undefined || body.prompts === undefined) return Response.json(await suite(), { headers });

  const prompts = body.prompts;
  if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > MAX_PROMPTS || !prompts.every((p) => typeof p === "string")) {
    return errorResponse(400, `\`prompts\` must be an array of 1–${MAX_PROMPTS} strings.`, { param: "prompts", headers });
  }
  if (prompts.some((p) => p.length > MAX_PROMPT_CHARS)) {
    return errorResponse(400, `Each prompt is limited to ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`, { param: "prompts", headers });
  }

  const results = (prompts as string[]).map((prompt) => {
    const fw = inspectPrompt(prompt);
    return {
      verdict: fw.verdict,
      blocked: !fw.allowed,
      hits: fw.hits.map((h) => ({ ruleId: h.ruleId, category: h.category, owasp: h.owasp, label: h.label, match: h.match })),
      // types and offsets only: the redacted values are never echoed back
      redactions: fw.redactions.map((r) => ({ type: r.type, start: r.start, end: r.end })),
      sanitized: fw.sanitized,
      elapsedMs: Math.round(fw.elapsedMs * 1000) / 1000,
    };
  });
  return Response.json(
    { total: results.length, blocked: results.filter((r) => r.blocked).length, redacted: results.filter((r) => r.redactions.length).length, results },
    { headers },
  );
}
