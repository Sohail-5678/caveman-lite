/**
 * GET  /api/shadow-evals — replays the bundled 250-trace shadow dataset for all four agent nodes:
 *      McNemar (exact below 25 discordant pairs), 95% bootstrap CI on Δaccuracy, downgrade verdicts,
 *      the cost/accuracy Pareto frontier and the cheapest statistically safe swap per node.
 * POST /api/shadow-evals — the same statistics for your own data:
 *      { table: { n11, n10, n01, n00 } } or { baseline: boolean[], candidate: boolean[] }
 *      plus optional { alpha, maxDrop, iterations }.
 */
import { enforceRateLimit, errorResponse, readJsonCapped } from "@/lib/server/http";
import { analysePaired, shadowReport } from "@/lib/evals/shadow-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAIRS = 100_000;
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
const inRange = (v: unknown, lo: number, hi: number) => v === undefined || (typeof v === "number" && v > lo && v < hi);

export function GET(request: Request): Response {
  const limit = enforceRateLimit(request, "shadow-evals");
  if (!limit.ok) return limit.response;
  return Response.json(shadowReport(), { headers: { ...limit.headers, "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const limit = enforceRateLimit(request, "shadow-evals");
  if (!limit.ok) return limit.response;
  const headers = limit.headers;
  const raw = await readJsonCapped(request, { headers });
  if (!raw.ok) return raw.response;
  const body = raw.value as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "Body must be a JSON object.", { headers });

  const { alpha, maxDrop, iterations } = body;
  if (!inRange(alpha, 0, 1)) return errorResponse(400, "`alpha` must be in (0, 1).", { param: "alpha", headers });
  if (!inRange(maxDrop, 0, 1)) return errorResponse(400, "`maxDrop` must be in (0, 1).", { param: "maxDrop", headers });
  if (iterations !== undefined && (!Number.isInteger(iterations) || (iterations as number) < 100 || (iterations as number) > 10_000)) {
    return errorResponse(400, "`iterations` must be an integer between 100 and 10,000.", { param: "iterations", headers });
  }
  const options = { alpha: alpha as number | undefined, maxDrop: maxDrop as number | undefined, iterations: iterations as number | undefined };

  if (body.table !== undefined) {
    const t = body.table as Record<string, unknown>;
    if (!t || typeof t !== "object" || !["n11", "n10", "n01", "n00"].every((k) => isCount(t[k]))) {
      return errorResponse(400, "`table` needs non-negative integer n11, n10, n01 and n00.", { param: "table", headers });
    }
    const table = { n11: t.n11 as number, n10: t.n10 as number, n01: t.n01 as number, n00: t.n00 as number };
    if (table.n11 + table.n10 + table.n01 + table.n00 > MAX_PAIRS) {
      return errorResponse(400, `A table may describe at most ${MAX_PAIRS.toLocaleString("en-US")} pairs.`, { param: "table", headers });
    }
    return Response.json(analysePaired({ table }, options), { headers });
  }

  const { baseline, candidate } = body;
  const bools = (v: unknown): v is boolean[] => Array.isArray(v) && v.length <= MAX_PAIRS && v.every((x) => typeof x === "boolean");
  if (!bools(baseline) || !bools(candidate) || baseline.length !== candidate.length || baseline.length === 0) {
    return errorResponse(400, "Send `table`, or `baseline` and `candidate` as equal-length boolean arrays.", { headers });
  }
  return Response.json(analysePaired({ baseline, candidate }, options), { headers });
}
