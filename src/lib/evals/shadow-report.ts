/**
 * Shadow-eval replay report: for every agent node, each candidate model's paired 2×2 table against the
 * node's baseline is run through McNemar (exact below 25 discordant pairs), a percentile bootstrap CI on
 * Δaccuracy, the downgrade verdict and the cost/accuracy Pareto frontier. Backs GET /api/shadow-evals and
 * mirrors what the Pareto chart renders in the browser.
 */
import {
  bootstrapDeltaCI,
  contingencyFromPairs,
  downgradeVerdict,
  mcnemar,
  pairsFromContingency,
  paretoFrontier,
  type Contingency,
  type DowngradeVerdict,
  type McNemarResult,
} from "./pareto-optimizer";
import {
  AGENT_NODES,
  baselineAccuracy,
  costPerMillion,
  EVAL_MODELS,
  nodeP95,
  SHADOW_SAMPLE,
  type AgentNode,
} from "../workload-traces";

export interface CandidateReport {
  model: string;
  label: string;
  vendor: string;
  tier: "fast" | "frontier";
  isBaseline: boolean;
  /** USD per 1M requests at this node's token profile. */
  costPer1MRequests: number;
  accuracy: number;
  p95Ms: number;
  onFrontier: boolean;
  /** 1 − cost / baseline cost. */
  costSaving: number;
  mcnemar: McNemarResult | null;
  ci95: { low: number; high: number } | null;
  verdict: DowngradeVerdict | null;
}

export interface NodeReport {
  id: string;
  index: number;
  label: string;
  role: string;
  baseline: string;
  baselineAccuracy: number;
  candidates: CandidateReport[];
  frontier: string[];
  recommendation: { model: string; costSaving: number; deltaAcc: number; p: number; summary: string } | null;
}

const pp = (delta: number) => `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta * 100).toFixed(1)} pp`;

export function analyseNode(node: AgentNode, options: { bootstrapIterations?: number } = {}): NodeReport {
  const baseAcc = baselineAccuracy(node);
  const baselineModel = EVAL_MODELS.find((m) => m.id === node.baseline);
  const baseCost = baselineModel ? costPerMillion(baselineModel, node) : 0;

  const rows = EVAL_MODELS.map((model): CandidateReport => {
    const isBaseline = model.id === node.baseline;
    const table = node.tables[model.id];
    const stats = table ? mcnemar(table) : null;
    let ci95: CandidateReport["ci95"] = null;
    if (stats) {
      const pairs = pairsFromContingency(stats, 11 + node.index);
      const ci = bootstrapDeltaCI(pairs.a, pairs.b, { iterations: options.bootstrapIterations ?? 2000, seed: 7 });
      ci95 = { low: ci.low, high: ci.high };
    }
    const cost = costPerMillion(model, node);
    return {
      model: model.id,
      label: model.label,
      vendor: model.vendor,
      tier: model.tier,
      isBaseline,
      costPer1MRequests: cost,
      accuracy: isBaseline ? baseAcc : stats ? stats.accB : 0,
      p95Ms: nodeP95(model, node),
      onFrontier: false,
      costSaving: baseCost > 0 ? 1 - cost / baseCost : 0,
      mcnemar: stats,
      ci95,
      verdict: stats ? downgradeVerdict(stats) : null,
    };
  });

  const frontier = paretoFrontier(rows.map((r) => ({ id: r.model, cost: r.costPer1MRequests, accuracy: r.accuracy })));
  const frontierIds = new Set(frontier.map((f) => f.id));
  for (const r of rows) r.onFrontier = frontierIds.has(r.model);

  const safe = rows
    .filter((r) => !r.isBaseline && r.costSaving > 0 && r.verdict === "STATISTICALLY_SAFE_TO_DOWNGRADE")
    .sort((a, b) => a.costPer1MRequests - b.costPer1MRequests);
  const pick = safe[0];
  const recommendation =
    pick && pick.mcnemar
      ? {
          model: pick.model,
          costSaving: pick.costSaving,
          deltaAcc: pick.mcnemar.deltaAcc,
          p: pick.mcnemar.p,
          summary:
            `Swapping ${node.label} from ${baselineModel?.label ?? node.baseline} to ${pick.label} changes accuracy by ` +
            `${pp(pick.mcnemar.deltaAcc)} (McNemar ${pick.mcnemar.test === "exact" ? "exact" : "χ²"} p = ${pick.mcnemar.p.toFixed(2)} > 0.05, ` +
            `statistically indistinguishable) while cutting cost by ${(pick.costSaving * 100).toFixed(1)}%.`,
        }
      : null;

  return {
    id: node.id,
    index: node.index,
    label: node.label,
    role: node.role,
    baseline: node.baseline,
    baselineAccuracy: baseAcc,
    candidates: rows,
    frontier: frontier.map((f) => f.id),
    recommendation,
  };
}

export function shadowReport(options: { bootstrapIterations?: number } = {}) {
  const nodes = AGENT_NODES.map((n) => analyseNode(n, options));
  return {
    sample: SHADOW_SAMPLE,
    alpha: 0.05,
    maxDrop: 0.01,
    nodes,
    safeDowngrades: nodes.filter((n) => n.recommendation).length,
  };
}

/** Ad-hoc analysis for a caller-supplied table or raw paired outcomes. */
export function analysePaired(
  input: { table: Contingency } | { baseline: boolean[]; candidate: boolean[] },
  options: { alpha?: number; maxDrop?: number; iterations?: number } = {},
) {
  const table = "table" in input ? input.table : contingencyFromPairs(input.baseline, input.candidate);
  const pairs = "table" in input ? pairsFromContingency(table, 42) : { a: input.baseline, b: input.candidate };
  const stats = mcnemar(table);
  const ci = bootstrapDeltaCI(pairs.a, pairs.b, { iterations: options.iterations ?? 2000, alpha: options.alpha ?? 0.05, seed: 7 });
  return {
    mcnemar: stats,
    ci: { low: ci.low, high: ci.high, level: 1 - ci.alpha, iterations: ci.iterations },
    verdict: downgradeVerdict(stats, { alpha: options.alpha, maxDrop: options.maxDrop }),
  };
}
