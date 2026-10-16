/**
 * Paired shadow-eval statistics (McNemar, exact binomial, bootstrap CI) and Pareto frontier.
 *
 * A cheaper candidate model is shadow-run on the same prompts as the baseline. Only the discordant
 * pairs (one passes, the other fails) carry information about a difference in accuracy, which is
 * exactly what McNemar's test looks at.
 */
import { mulberry32 } from "../utils/prng";

export interface Contingency {
  /** both pass */
  n11: number;
  /** baseline A passes, candidate B fails */
  n10: number;
  /** baseline A fails, candidate B passes */
  n01: number;
  /** both fail */
  n00: number;
}

export interface McNemarResult extends Contingency {
  n: number;
  discordant: number;
  /** Continuity-corrected: (|n10 - n01| - 1)^2 / (n10 + n01); 0 when discordant = 0 or |n10 - n01| <= 1. */
  chi2: number;
  /** Chi-square (df = 1) survival function of chi2. */
  pValue: number;
  /** Two-sided exact binomial p under Bin(discordant, 0.5). */
  pExact: number;
  /** Exact test when discordant < 25, otherwise the chi-square approximation. */
  test: "exact" | "chi2";
  /** The p-value of the test above. */
  p: number;
  accA: number;
  accB: number;
  /** accB - accA */
  deltaAcc: number;
}

/** Below this many discordant pairs the exact binomial test is used. */
const EXACT_TEST_LIMIT = 25;

const count = (x: number) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

export function mcnemar(table: Contingency): McNemarResult {
  const n11 = count(table.n11);
  const n10 = count(table.n10);
  const n01 = count(table.n01);
  const n00 = count(table.n00);
  const n = n11 + n10 + n01 + n00;
  const discordant = n10 + n01;
  const gap = Math.abs(n10 - n01);
  const chi2 = discordant === 0 || gap <= 1 ? 0 : (gap - 1) ** 2 / discordant;
  const pValue = chiSquareSurvival1(chi2);
  const pExact = binomialTwoSidedP(Math.min(n10, n01), discordant);
  const test = discordant < EXACT_TEST_LIMIT ? "exact" : "chi2";
  const accA = n ? (n11 + n10) / n : 0;
  const accB = n ? (n11 + n01) / n : 0;
  return {
    n11,
    n10,
    n01,
    n00,
    n,
    discordant,
    chi2,
    pValue,
    pExact,
    test,
    p: test === "exact" ? pExact : pValue,
    accA,
    accB,
    deltaAcc: accB - accA,
  };
}

// ---------------------------------------------------------------------------------------------
// erfc — W. J. Cody, "Rational Chebyshev approximations for the error function" (1969),
// as in netlib SPECFUN CALERF. Relative accuracy ~1e-16 over the whole real line.
// ---------------------------------------------------------------------------------------------

const ERF_A = [3.1611237438705656, 113.86415415105016, 377.485237685302, 3209.3775891384694, 0.18577770618460315];
const ERF_B = [23.601290952344122, 244.02463793444417, 1282.6165260773723, 2844.2368334391704];
const ERF_C = [
  0.5641884969886701, 8.883149794388376, 66.11919063714163, 298.6351381974001, 881.952221241769, 1712.0476126340707,
  2051.0783778260716, 1230.3393547979972, 2.1531153547440383e-8,
];
const ERF_D = [
  15.744926110709835, 117.6939508913125, 537.1811018620099, 1621.3895745666903, 3290.7992357334847, 4362.619090143247,
  3439.3676741437216, 1230.3393548037495,
];
const ERF_P = [0.30532663496123236, 0.36034489994980445, 0.12578172611122926, 0.016083785148742275, 6.587491615298378e-4, 0.016315387137302097];
const ERF_Q = [2.568520192289822, 1.8729528499234604, 0.5279051029514285, 0.06051834131244132, 0.0023352049762686918];
const INV_SQRT_PI = 0.5641895835477563;

/** exp(-y²) without the cancellation error of squaring a large y directly. */
function expNegSquare(y: number): number {
  const ysq = Math.trunc(y * 16) / 16;
  const del = (y - ysq) * (y + ysq);
  return Math.exp(-ysq * ysq) * Math.exp(-del);
}

/** Complementary error function. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const y = Math.abs(x);
  let result: number;
  if (y <= 0.46875) {
    const ysq = y > 1.11e-16 ? y * y : 0;
    let num = ERF_A[4] * ysq;
    let den = ysq;
    for (let i = 0; i < 3; i++) {
      num = (num + ERF_A[i]) * ysq;
      den = (den + ERF_B[i]) * ysq;
    }
    return 1 - (x * (num + ERF_A[3])) / (den + ERF_B[3]);
  }
  if (y <= 4) {
    let num = ERF_C[8] * y;
    let den = y;
    for (let i = 0; i < 7; i++) {
      num = (num + ERF_C[i]) * y;
      den = (den + ERF_D[i]) * y;
    }
    result = expNegSquare(y) * ((num + ERF_C[7]) / (den + ERF_D[7]));
  } else if (y >= 26.543) {
    result = 0;
  } else {
    const ysq = 1 / (y * y);
    let num = ERF_P[5] * ysq;
    let den = ysq;
    for (let i = 0; i < 4; i++) {
      num = (num + ERF_P[i]) * ysq;
      den = (den + ERF_Q[i]) * ysq;
    }
    const r = (ysq * (num + ERF_P[4])) / (den + ERF_Q[4]);
    result = expNegSquare(y) * ((INV_SQRT_PI - r) / y);
  }
  return x < 0 ? 2 - result : result;
}

/** P(X > x) for X ~ chi-square with 1 degree of freedom: erfc(sqrt(x / 2)). */
export function chiSquareSurvival1(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x <= 0) return 1;
  if (x === Infinity) return 0;
  return Math.min(1, Math.max(0, erfc(Math.sqrt(x / 2))));
}

/** min(1, 2 * P(X <= min(k, n - k))) for X ~ Bin(n, 0.5). Numerically stable for n up to a few thousand. */
export function binomialTwoSidedP(k: number, n: number): number {
  const N = count(n);
  if (N === 0) return 1;
  const K = Math.min(N, count(k));
  const m = Math.min(K, N - K);
  // For Bin(n, ½), P(X <= ⌊(n-1)/2⌋) is exactly ½ (odd n) or more (even n): the two-sided p is 1.
  if (2 * m >= N - 1) return 1;
  // log C(n, i) built incrementally; terms increase for i <= n/2 so the last one is the maximum.
  const logTerms = new Float64Array(m + 1);
  for (let i = 1; i <= m; i++) logTerms[i] = logTerms[i - 1] + Math.log((N - i + 1) / i);
  const max = logTerms[m];
  let sum = 0;
  for (let i = 0; i <= m; i++) sum += Math.exp(logTerms[i] - max);
  const logTail = max + Math.log(sum) - N * Math.LN2;
  return Math.min(1, 2 * Math.exp(logTail));
}

export function contingencyFromPairs(a: boolean[], b: boolean[]): Contingency {
  if (a.length !== b.length) throw new RangeError(`paired outcomes must have equal length (got ${a.length} and ${b.length})`);
  const table: Contingency = { n11: 0, n10: 0, n01: 0, n00: 0 };
  for (let i = 0; i < a.length; i++) {
    if (a[i]) {
      if (b[i]) table.n11++;
      else table.n10++;
    } else if (b[i]) table.n01++;
    else table.n00++;
  }
  return table;
}

/** Deterministically shuffled paired outcomes that reproduce the table exactly. */
export function pairsFromContingency(table: Contingency, seed?: number): { a: boolean[]; b: boolean[] } {
  const a: boolean[] = [];
  const b: boolean[] = [];
  const push = (times: number, x: boolean, y: boolean) => {
    for (let i = 0; i < times; i++) {
      a.push(x);
      b.push(y);
    }
  };
  push(count(table.n11), true, true);
  push(count(table.n10), true, false);
  push(count(table.n01), false, true);
  push(count(table.n00), false, false);
  const rand = mulberry32(seed ?? 42);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
    [b[i], b[j]] = [b[j], b[i]];
  }
  return { a, b };
}

export interface BootstrapCI {
  low: number;
  high: number;
  mean: number;
  iterations: number;
  alpha: number;
}

/** Linear-interpolated quantile of a sorted array (type 7). */
function quantileSorted(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Percentile bootstrap of accB - accA over paired resamples. Defaults: 2000 iterations, alpha 0.05, seed 7. */
export function bootstrapDeltaCI(
  a: boolean[],
  b: boolean[],
  options?: { iterations?: number; alpha?: number; seed?: number },
): BootstrapCI {
  if (a.length !== b.length) throw new RangeError(`paired outcomes must have equal length (got ${a.length} and ${b.length})`);
  const iterations = Math.max(1, Math.floor(options?.iterations ?? 2000));
  const alpha = Math.min(1, Math.max(0, options?.alpha ?? 0.05));
  const n = a.length;
  if (n === 0) return { low: 0, high: 0, mean: 0, iterations, alpha };

  // per-pair contribution to accB - accA is -1, 0 or +1; resample pair indices with replacement
  const diff = new Int8Array(n);
  for (let i = 0; i < n; i++) diff[i] = (b[i] ? 1 : 0) - (a[i] ? 1 : 0);
  const rand = mulberry32(options?.seed ?? 7);
  const deltas = new Float64Array(iterations);
  let total = 0;
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diff[Math.floor(rand() * n)];
    deltas[it] = s / n;
    total += deltas[it];
  }
  deltas.sort();
  return {
    low: quantileSorted(deltas, alpha / 2),
    high: quantileSorted(deltas, 1 - alpha / 2),
    mean: total / iterations,
    iterations,
    alpha,
  };
}

export type DowngradeVerdict =
  | "STATISTICALLY_SAFE_TO_DOWNGRADE"
  | "SIGNIFICANT_REGRESSION"
  | "CANDIDATE_BETTER"
  | "UNDERPOWERED";

/**
 * p <= alpha and deltaAcc < 0 -> SIGNIFICANT_REGRESSION; p <= alpha and deltaAcc > 0 -> CANDIDATE_BETTER;
 * p > alpha and |deltaAcc| < maxDrop -> STATISTICALLY_SAFE_TO_DOWNGRADE; otherwise UNDERPOWERED.
 * Defaults: alpha 0.05, maxDrop 0.01.
 */
export function downgradeVerdict(result: McNemarResult, options?: { alpha?: number; maxDrop?: number }): DowngradeVerdict {
  const alpha = options?.alpha ?? 0.05;
  const maxDrop = options?.maxDrop ?? 0.01;
  if (result.p <= alpha && result.deltaAcc < 0) return "SIGNIFICANT_REGRESSION";
  if (result.p <= alpha && result.deltaAcc > 0) return "CANDIDATE_BETTER";
  if (result.p > alpha && Math.abs(result.deltaAcc) < maxDrop) return "STATISTICALLY_SAFE_TO_DOWNGRADE";
  return "UNDERPOWERED";
}

export interface ParetoPoint {
  id: string;
  cost: number;
  accuracy: number;
  p95?: number;
}

/**
 * Non-dominated set sorted by cost ascending. a dominates b when a.cost <= b.cost and a.accuracy >= b.accuracy
 * (and a.p95 <= b.p95 when includeLatency) with at least one strict inequality.
 */
export function paretoFrontier<T extends ParetoPoint>(points: T[], options?: { includeLatency?: boolean }): T[] {
  const latency = options?.includeLatency === true;
  const p95 = (p: ParetoPoint) => (typeof p.p95 === "number" && !Number.isNaN(p.p95) ? p.p95 : Infinity);
  const dominates = (a: T, b: T): boolean => {
    if (a.cost > b.cost || a.accuracy < b.accuracy) return false;
    if (latency && p95(a) > p95(b)) return false;
    return a.cost < b.cost || a.accuracy > b.accuracy || (latency && p95(a) < p95(b));
  };
  return points
    .filter((candidate) => !points.some((other) => other !== candidate && dominates(other, candidate)))
    .sort((x, y) => x.cost - y.cost || y.accuracy - x.accuracy || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
