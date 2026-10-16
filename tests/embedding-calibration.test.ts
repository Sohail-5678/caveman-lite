/**
 * Calibration of the local embedding model + entity guard.
 *
 * The embedding is supposed to behave like a MiniLM-class sentence encoder, including its failure
 * mode: entity / number / polarity swaps barely move the vector (sim >= 0.94), so a naive semantic
 * cache would serve the wrong answer. The entity guard must veto those, while true paraphrases hit.
 */
import { describe, expect, it } from "vitest";
import { adaptiveThreshold, cosine, embed, SemanticCache } from "@/lib/cache/semantic-cache";
import type { ParityReason } from "@/lib/cache/entity-guard";

const A = "What was Apple's total revenue in Q3 2026, and how did it compare to analyst expectations?";
const REFUND = [
  "What is the refund window for customers on annual Enterprise plans who cancel mid-term?",
  "For customers on annual Enterprise plans who cancel mid-term, what is the refund window?",
  "What's the refund period for annual Enterprise plan customers who cancel mid-term?",
  "How long is the refund window for customers on annual Enterprise plans that cancel mid-term?",
];
const SNOWFLAKE = [
  "Summarize the top 5 risk factors in Snowflake's Q3 FY2026 10-Q filing.",
  "Summarize the top five risk factors in Snowflake's Q3 FY2026 10-Q filing.",
];
const ORDERS = [
  "List every column in the orders_2025 table with its data type and nullability.",
  "List all columns in the orders_2025 table along with their data types and nullability.",
];
const SINGLEFLIGHT = [
  "Explain how the singleflight pattern prevents cache stampedes in a distributed LLM gateway.",
  "How does the singleflight pattern prevent cache stampedes in a distributed LLM gateway? Explain.",
];

const sim = (a: string, b: string) => cosine(embed(a), embed(b));

interface Trap {
  name: string;
  cached: string;
  query: string;
  reason: ParityReason;
  range?: [number, number];
}

const TRAPS: Trap[] = [
  {
    name: "Apple -> Microsoft",
    cached: A,
    query: "What was Microsoft's total revenue in Q3 2026, and how did it compare to analyst expectations?",
    reason: "NAMED_ENTITY_MISMATCH",
    range: [0.95, 0.985],
  },
  {
    name: "Q3 -> Q4",
    cached: A,
    query: "What was Apple's total revenue in Q4 2026, and how did it compare to analyst expectations?",
    reason: "NUMERIC_MISMATCH",
  },
  {
    name: "renewed -> did not renew",
    cached: "Which enterprise customers renewed their contracts in 2025 after the price increase?",
    query: "Which enterprise customers did not renew their contracts in 2025 after the price increase?",
    reason: "POLARITY_MISMATCH",
  },
  {
    name: "highest -> lowest",
    cached: "Show the regions with the highest churn rate over the last 6 months of 2025.",
    query: "Show the regions with the lowest churn rate over the last 6 months of 2025.",
    reason: "POLARITY_MISMATCH",
  },
];

const pairs = <T,>(xs: T[]) => xs.flatMap((x, i) => xs.slice(i + 1).map((y) => [x, y] as [T, T]));

const PARAPHRASES: Array<[string, string, string]> = [
  ["Apple Q3 reordered", A, "In Q3 2026, what was Apple's total revenue and how did it compare with analyst expectations?"],
  ...pairs(REFUND).map(([a, b]) => [`refund ${REFUND.indexOf(a)}/${REFUND.indexOf(b)}`, a, b] as [string, string, string]),
  ["Snowflake 5 / five", SNOWFLAKE[0], SNOWFLAKE[1]],
  ["orders_2025 columns", ORDERS[0], ORDERS[1]],
  ["singleflight explain", SINGLEFLIGHT[0], SINGLEFLIGHT[1]],
];

const UNRELATED: Array<[string, string, string]> = [
  ["Apple Q3 vs haiku", A, "Write a haiku about Postgres vacuum."],
  ["refund vs Snowflake", REFUND[0], SNOWFLAKE[0]],
  ["Apple Q3 vs orders_2025", A, ORDERS[0]],
];

describe("embedding calibration: entity traps", () => {
  it.each(TRAPS)("$name: similar enough to fool a naive cache, vetoed by the guard", ({ cached, query, reason, range }) => {
    const s = sim(cached, query);
    expect(s).toBeGreaterThanOrEqual(0.94);
    if (range) {
      expect(s).toBeGreaterThanOrEqual(range[0]);
      expect(s).toBeLessThanOrEqual(range[1]);
    }
    const cache = new SemanticCache<string>();
    cache.insert(cached, "cached answer");
    const r = cache.lookup(query);
    expect(r.naiveHit).toBe(true);
    expect(r.candidate).toBe(true);
    expect(r.verdict).toBe("ENTITY_GUARD_VETO");
    expect(r.hit).toBe(false);
    expect(r.parity?.reasons).toContain(reason);
    expect(r.best?.similarity).toBeCloseTo(s, 6);
  });
});

describe("embedding calibration: safe paraphrases", () => {
  it.each(PARAPHRASES)("%s: sim >= adaptive threshold and parity OK -> HIT (both directions)", (_name, a, b) => {
    for (const [cached, query] of [
      [a, b],
      [b, a],
    ]) {
      const s = sim(cached, query);
      expect(s).toBeGreaterThanOrEqual(adaptiveThreshold(query));
      const cache = new SemanticCache<string>();
      cache.insert(cached, "cached answer");
      const r = cache.lookup(query);
      expect(r.verdict).toBe("HIT");
      expect(r.parity?.ok).toBe(true);
    }
  });
});

describe("embedding calibration: unrelated prompts", () => {
  it.each(UNRELATED)("%s: sim < 0.6", (_name, a, b) => {
    expect(sim(a, b)).toBeLessThan(0.6);
  });
});

describe("embedding calibration: adaptive threshold", () => {
  it("is 0.97 for short queries and 0.94 otherwise", () => {
    expect(adaptiveThreshold("Capital of France?")).toBe(0.97);
    expect(adaptiveThreshold(A)).toBe(0.94);
  });

  it("is symmetric and bounded", () => {
    for (const [, a, b] of [...PARAPHRASES, ...UNRELATED]) {
      const ab = sim(a, b);
      expect(ab).toBeCloseTo(sim(b, a), 6);
      expect(ab).toBeLessThanOrEqual(1);
      expect(ab).toBeGreaterThanOrEqual(-1);
    }
  });

  it("prints the calibration table", () => {
    const rows = [
      ...TRAPS.map((t) => ({ kind: "trap (veto)", pair: t.name, sim: Number(sim(t.cached, t.query).toFixed(4)) })),
      ...PARAPHRASES.map(([name, a, b]) => ({ kind: "paraphrase (hit)", pair: name, sim: Number(sim(a, b).toFixed(4)) })),
      ...UNRELATED.map(([name, a, b]) => ({ kind: "unrelated (miss)", pair: name, sim: Number(sim(a, b).toFixed(4)) })),
    ];
    console.table(rows);
    expect(rows).toHaveLength(TRAPS.length + PARAPHRASES.length + UNRELATED.length);
  });
});
