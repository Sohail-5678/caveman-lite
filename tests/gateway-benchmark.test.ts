import { describe, expect, it } from "vitest";
import { BENCHMARK_CASES, runBenchmark, runBenchmarkCase } from "@/lib/evals/gateway-benchmark";
import type { BenchmarkCategory } from "@/lib/evals/gateway-benchmark";

const CATEGORIES: BenchmarkCategory[] = [
  "Stampede",
  "Exact cache",
  "Semantic cache",
  "Entity guard",
  "Router",
  "Circuit breaker",
  "Compression",
  "Security",
  "Statistics",
];

describe("gateway benchmark suite", () => {
  it("defines exactly 30 well-formed cases across all 9 categories", () => {
    expect(BENCHMARK_CASES).toHaveLength(30);
    expect(new Set(BENCHMARK_CASES.map((c) => c.id)).size).toBe(30);
    expect(new Set(BENCHMARK_CASES.map((c) => c.category))).toEqual(new Set(CATEGORIES));
    for (const c of BENCHMARK_CASES) {
      expect(c.name.length).toBeLessThanOrEqual(48);
      expect(c.name[0]).toBe(c.name[0].toUpperCase());
    }
  });

  it("passes 30/30 when run sequentially", async () => {
    const seen: number[] = [];
    const results = await runBenchmark((_result, index) => seen.push(index));
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const failures = results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.detail}`);
    expect(failures).toEqual([]);
    expect(results.filter((r) => r.pass)).toHaveLength(30);
    for (const r of results) {
      expect(r.detail.length).toBeGreaterThan(0);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    console.table(results.map((r) => ({ id: r.id, pass: r.pass, ms: Number(r.durationMs.toFixed(2)), detail: r.detail })));
  });

  it("keeps every non-stampede case under 50 ms once warm", async () => {
    await runBenchmark(); // warm-up: first-call regex compilation and JIT
    const results = await runBenchmark();
    const slow = results.filter((r) => r.category !== "Stampede" && r.durationMs >= 50).map((r) => `${r.id}: ${r.durationMs.toFixed(1)} ms`);
    expect(slow).toEqual([]);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("reports a thrown error as a failing result instead of rejecting", async () => {
    const result = await runBenchmarkCase({
      id: "broken",
      category: "Statistics",
      name: "Broken case",
      run: async () => {
        throw new Error("kaboom");
      },
    });
    expect(result).toMatchObject({ id: "broken", pass: false, detail: "threw: kaboom" });
  });
});
