/**
 * POST /api/burst-sim — runs the 50-request concurrent burst through a fresh GatewayEngine on the server.
 *
 * Body (all optional): { chaos?: { groq?: "healthy" | "rate_limited", gemini?: …, claude?: … },
 *                        passes?: 1 | 2, seed?: number, traces?: boolean }
 * passes = 2 replays the same burst against the now-warm cache. Upstream latency runs on the engine's
 * virtual clock, so a burst with 1.8 s frontier calls returns in milliseconds with exact timings.
 */
import { enforceRateLimit, errorResponse, readJsonCapped } from "@/lib/server/http";
import { GatewayEngine, type ChaosMode, type GatewayTrace, type RunResult } from "@/lib/gateway/engine";
import { burstWorkload, seedEntries, writeResponse } from "@/lib/workload-traces";
import { percentile } from "@/lib/utils/prng";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["groq", "gemini", "claude"];
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

interface BurstOptions {
  chaos: Partial<Record<ProviderId, ChaosMode>>;
  passes: 1 | 2;
  seed: number;
  traces: boolean;
}

function parseOptions(raw: unknown): BurstOptions | string {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) return "Body must be a JSON object.";
  const chaos: BurstOptions["chaos"] = {};
  if (o.chaos !== undefined) {
    if (typeof o.chaos !== "object" || o.chaos === null) return "`chaos` must be an object.";
    for (const [provider, mode] of Object.entries(o.chaos)) {
      if (!PROVIDERS.includes(provider as ProviderId)) return `Unknown provider in chaos: ${provider}.`;
      if (mode !== "healthy" && mode !== "rate_limited") return `chaos.${provider} must be "healthy" or "rate_limited".`;
      chaos[provider as ProviderId] = mode;
    }
  }
  if (o.passes !== undefined && o.passes !== 1 && o.passes !== 2) return "`passes` must be 1 or 2.";
  if (o.seed !== undefined && (typeof o.seed !== "number" || !Number.isInteger(o.seed) || o.seed < 0 || o.seed > 2 ** 31)) {
    return "`seed` must be a non-negative integer.";
  }
  return { chaos, passes: (o.passes as 1 | 2) ?? 1, seed: (o.seed as number) ?? 50, traces: o.traces !== false };
}

function summarise(run: RunResult, label: "cold" | "warm") {
  const traces = run.traces;
  const count = (outcome: GatewayTrace["outcome"]) => traces.filter((t) => t.outcome === outcome).length;
  const admitted = traces.filter((t) => t.outcome !== "BLOCKED");
  const latencies = admitted.map((t) => t.latencyMs);
  const baseline = admitted.map((t) => t.baselineLatencyMs);
  const cost = traces.reduce((s, t) => s + t.costUsd, 0);
  const baselineCost = admitted.reduce((s, t) => s + t.baselineCostUsd, 0);
  const stampede = traces.filter((t) => t.label === "stampede");
  return {
    pass: label,
    requests: traces.length,
    outcomes: {
      blocked: count("BLOCKED"),
      exactHits: count("T1_HIT"),
      semanticHits: count("T2_HIT"),
      coalesced: count("COALESCED"),
      upstream: count("UPSTREAM"),
      errors: count("ERROR"),
    },
    upstreamCalls: run.upstreamCalls,
    entityVetoes: traces.filter((t) => t.entityVeto).length,
    failovers: traces.filter((t) => t.route?.failover).length,
    stampede: { requests: stampede.length, upstreamCalls: stampede.filter((t) => t.outcome === "UPSTREAM").length },
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      baselineP95: round(percentile(baseline, 95)),
    },
    costUsd: { gateway: round(cost, 6), baseline: round(baselineCost, 6), saved: baselineCost > 0 ? round(1 - cost / baselineCost, 4) : 0 },
    computeMs: round(run.durationMs),
  };
}

function compact(t: GatewayTrace) {
  return {
    id: t.id,
    label: t.label,
    worker: t.worker,
    arrivalMs: t.arrivalMs,
    outcome: t.outcome,
    latencyMs: t.latencyMs,
    baselineLatencyMs: t.baselineLatencyMs,
    firewall: t.firewall.verdict,
    entityVeto: t.entityVeto,
    similarity: t.semantic ? round(t.semantic.similarity, 4) : null,
    coalescedInto: t.coalesced?.leaderId ?? null,
    followers: t.followers,
    route: t.route
      ? { tier: t.route.tier, model: t.route.model, provider: t.route.provider, probability: round(t.route.probability, 3), failover: t.route.failover }
      : null,
    costUsd: round(t.costUsd, 6),
  };
}

export async function POST(request: Request): Promise<Response> {
  const limit = enforceRateLimit(request, "burst-sim");
  if (!limit.ok) return limit.response;
  const raw = await readJsonCapped(request, { limit: 16_384, headers: limit.headers, allowEmpty: true });
  if (!raw.ok) return raw.response;
  const options = parseOptions(raw.value);
  if (typeof options === "string") return errorResponse(400, options, { code: "invalid_request", headers: limit.headers });

  const engine = new GatewayEngine(writeResponse);
  engine.warm(seedEntries());
  for (const [provider, mode] of Object.entries(options.chaos)) engine.setChaos(provider as ProviderId, mode);

  const runs: Array<{ label: "cold" | "warm"; run: RunResult }> = [{ label: "cold", run: await engine.run(burstWorkload(options.seed)) }];
  if (options.passes === 2) runs.push({ label: "warm", run: await engine.run(burstWorkload(options.seed)) });

  return Response.json(
    {
      seed: options.seed,
      chaos: { groq: "healthy", gemini: "healthy", claude: "healthy", ...options.chaos },
      passes: runs.map(({ label, run }) => ({
        ...summarise(run, label),
        ...(options.traces ? { traces: run.traces.map(compact) } : {}),
      })),
      breakers: engine.breakerSnapshots(),
    },
    { headers: { ...limit.headers, "Cache-Control": "no-store" } },
  );
}
