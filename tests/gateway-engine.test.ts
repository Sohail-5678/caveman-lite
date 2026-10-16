import { describe, expect, it, vi } from "vitest";
import { GatewayEngine, type GatewayTrace } from "@/lib/gateway/engine";
import { choreograph, DECISION_COUNTERS, type SceneEvent } from "@/lib/gateway/choreography";
import { GatewayController, isBurstActive, type GatewayState } from "@/lib/gateway/controller";
import { exactKey } from "@/lib/cache/exact-cache";
import {
  agentBody,
  burstWorkload,
  entityTrapWorkload,
  freshWorkload,
  PROMPTS,
  seedEntries,
  writeResponse,
} from "@/lib/workload-traces";
import { percentile } from "@/lib/utils/prng";
import type { ProviderId } from "@/lib/types";

function fresh() {
  const engine = new GatewayEngine(writeResponse);
  engine.warm(seedEntries());
  return engine;
}

function tally(traces: GatewayTrace[]) {
  const by = (o: GatewayTrace["outcome"]) => traces.filter((t) => t.outcome === o).length;
  return {
    blocked: by("BLOCKED"),
    t1: by("T1_HIT"),
    t2: by("T2_HIT"),
    coalesced: by("COALESCED"),
    upstream: by("UPSTREAM"),
    errors: by("ERROR"),
    vetoes: traces.filter((t) => t.entityVeto).length,
    failovers: traces.filter((t) => t.route?.failover).length,
  };
}

describe("gateway engine · 50-request burst", () => {
  it("cold burst: stampedes coalesce, traps are vetoed, injections never reach upstream", async () => {
    const engine = fresh();
    const result = await engine.run(burstWorkload());
    const t = tally(result.traces);
    expect(result.traces).toHaveLength(50);
    expect(t.blocked).toBe(2);
    expect(t.errors).toBe(0);
    expect(t.vetoes).toBe(3);
    expect(t.t1 + t.t2).toBeGreaterThanOrEqual(11);
    expect(t.coalesced).toBeGreaterThanOrEqual(28);
    expect(result.upstreamCalls).toBe(t.upstream);
    expect(result.upstreamCalls).toBeLessThanOrEqual(8);

    // every follower waited on a real leader from the same run
    const ids = new Set(result.traces.filter((x) => x.outcome === "UPSTREAM").map((x) => x.id));
    for (const f of result.traces.filter((x) => x.outcome === "COALESCED")) expect(ids.has(f.coalesced!.leaderId)).toBe(true);

    // the identical-request stampede costs exactly one upstream call
    const stampede = result.traces.filter((x) => x.label === "stampede");
    expect(stampede.filter((x) => x.outcome === "UPSTREAM")).toHaveLength(1);
  });

  it("warm burst: zero upstream calls and a P95 in the low milliseconds", async () => {
    const engine = fresh();
    const cold = await engine.run(burstWorkload());
    const warm = await engine.run(burstWorkload());
    expect(warm.upstreamCalls).toBe(0);
    const admitted = warm.traces.filter((x) => x.outcome !== "BLOCKED");
    const p95 = percentile(admitted.map((x) => x.latencyMs), 95);
    const coldP95 = percentile(cold.traces.filter((x) => x.outcome !== "BLOCKED").map((x) => x.latencyMs), 95);
    const baselineP95 = percentile(admitted.map((x) => x.baselineLatencyMs), 95);
    expect(p95).toBeLessThan(20);
    expect(coldP95).toBeGreaterThan(p95);
    expect(baselineP95).toBeGreaterThan(1200);
  });

  it("killing Groq trips its breaker and fails over without dropping a request", async () => {
    const engine = fresh();
    engine.setChaos("groq", "rate_limited");
    const result = await engine.run(burstWorkload());
    const t = tally(result.traces);
    expect(t.errors).toBe(0);
    expect(t.failovers).toBeGreaterThanOrEqual(3);
    expect(engine.breakers.groq.state).toBe("OPEN");
    const trip = result.traces.flatMap((x) => x.breakerEvents).find((e) => e.provider === "groq" && e.to === "OPEN");
    expect(trip).toBeDefined();
  });

  it("entity trap: Microsoft is vetoed against the cached Apple answer", async () => {
    const engine = fresh();
    const result = await engine.run(entityTrapWorkload());
    const [trace] = result.traces;
    expect(trace.entityVeto).toBe(true);
    expect(trace.semantic?.naiveHit).toBe(true);
    expect(trace.outcome).toBe("UPSTREAM");
  });

  it("choreography gives every trace a completion event", async () => {
    const engine = fresh();
    const result = await engine.run(burstWorkload());
    const { plans, events } = choreograph(result.traces, 0);
    expect(plans).toHaveLength(50);
    expect(events.filter((e) => e.type === "complete")).toHaveLength(50);
  });
});

describe("choreography · signal semantics", () => {
  it("only real T1/T2 hits flash malachite; upstream answers write back through the caches in bone", async () => {
    const engine = fresh();
    const result = await engine.run(burstWorkload());
    const t = tally(result.traces);
    const { events } = choreograph(result.traces, 0);
    const gate = (g: string, tone: string) => events.filter((e) => e.type === "gate" && e.gate === g && e.tone === tone).length;
    expect(gate("t1", "malachite")).toBe(t.t1);
    expect(gate("t2", "malachite")).toBe(t.t2);
    // T1 has no forward-pass event for a miss, so every bone T1 event is a return-pass cache write
    expect(gate("t1", "bone")).toBe(t.upstream);
  });

  it("a breaker trips before any packet bounces off its shield, and later 429s read as stragglers", async () => {
    const engine = fresh();
    engine.setChaos("groq", "rate_limited");
    const result = await engine.run(burstWorkload());
    const { events } = choreograph(result.traces, 0);

    const state: Record<ProviderId, string> = { groq: "CLOSED", gemini: "CLOSED", claude: "CLOSED" };
    let trippedAt = -Infinity;
    let onTimeAfterTrip = 0;
    for (const e of events) {
      if (e.type === "breaker") {
        state[e.provider] = e.to;
        if (e.provider === "groq" && e.to === "OPEN") trippedAt = e.at;
      }
      if (e.type === "provider" && e.status === "deflect" && e.tone === "cinnabar") {
        expect(state[e.provider]).not.toBe("CLOSED");
        if (e.provider === "groq") expect(e.at).toBeGreaterThanOrEqual(trippedAt + 120);
      }
      const afterTrip = trippedAt > -Infinity && e.at > trippedAt;
      if (e.type === "provider" && e.provider === "groq" && e.status === "429" && afterTrip && !e.late) onTimeAfterTrip++;
    }
    expect(trippedAt).toBeGreaterThan(-Infinity);
    // only the attempt that tripped the breaker may land its 429 after the trip at full strength
    expect(onTimeAfterTrip).toBeLessThanOrEqual(1);

    const lateAt = new Set(events.filter((e) => e.type === "provider" && e.late).map((e) => e.at));
    for (const e of events) {
      if (e.type === "spark" && e.tone === "cinnabar" && lateAt.has(e.at) && e.count !== 14) expect(e.count).toBe(8);
    }

    for (const e of result.traces.flatMap((x) => x.breakerEvents)) expect(Number.isFinite(e.at)).toBe(true);
  });

  it("503s keep their route, visit every provider and replay their breaker trips", async () => {
    const engine = fresh();
    for (const p of ["groq", "gemini", "claude"] as const) engine.setChaos(p, "rate_limited");
    const result = await engine.run(burstWorkload());
    const errors = result.traces.filter((x) => x.outcome === "ERROR");
    const leaders = errors.filter((x) => !x.coalesced);
    expect(leaders.length).toBeGreaterThan(0);
    expect(errors.some((x) => x.coalesced)).toBe(true);

    for (const t of leaders) {
      expect(t.route?.model).toBe("");
      expect(t.route?.attempts.length).toBeGreaterThan(0);
      for (const e of t.breakerEvents) expect(t.route!.attempts[e.attemptIndex].provider).toBe(e.provider);
    }
    const tripped = new Set(leaders.flatMap((x) => x.breakerEvents).filter((e) => e.to === "OPEN").map((e) => e.provider));
    expect(tripped.has("groq") && tripped.has("gemini")).toBe(true);

    const { events, plans } = choreograph(result.traces, 0);
    expect(plans).toHaveLength(50);
    const trips = new Set(events.flatMap((e) => (e.type === "breaker" && e.to === "OPEN" ? [e.provider] : [])));
    expect(trips).toEqual(tripped);
    const rejected = new Set(
      events.flatMap((e) => (e.type === "provider" && (e.status === "429" || e.status === "deflect") ? [e.provider] : [])),
    );
    for (const p of tripped) expect(rejected.has(p)).toBe(true);
    const state: Record<ProviderId, string> = { groq: "CLOSED", gemini: "CLOSED", claude: "CLOSED" };
    for (const e of events) {
      if (e.type === "breaker") state[e.provider] = e.to;
      if (e.type === "provider" && e.status === "deflect" && e.tone === "cinnabar") expect(state[e.provider]).not.toBe("CLOSED");
    }
    // followers of a failed leader orbit the lock; they never count as upstream calls
    const upstream = events.filter((e) => e.type === "counter" && e.key === "upstream").length;
    expect(upstream).toBe(leaders.length + result.traces.filter((x) => x.outcome === "UPSTREAM").length);
  });
});

describe("gateway engine · queue", () => {
  it("enqueued work waits for the run ahead of it", async () => {
    const engine = fresh();
    const order: string[] = [];
    const run = engine.run(burstWorkload()).then((r) => {
      order.push("run");
      return r;
    });
    const clear = engine.enqueue(() => {
      order.push("clear");
      engine.clearCaches();
    });
    const [result] = await Promise.all([run, clear]);
    expect(order).toEqual(["run", "clear"]);
    expect(tally(result.traces).t1).toBeGreaterThan(0);
    expect(engine.exact.size).toBe(0);
  });

  it("a health probe never touches a CLOSED breaker", () => {
    const engine = fresh();
    engine.setChaos("groq", "rate_limited");
    expect(engine.probe("groq").attempted).toBe(false);
    expect(engine.breakers.groq.snapshot().window).toHaveLength(0);
  });
});

describe("gateway controller · burst lifecycle", () => {
  const dispatchAll = (c: GatewayController) => (c as unknown as { dispatch(now: number): void }).dispatch(Infinity);
  const snowflake = exactKey(agentBody(PROMPTS.snowflake));

  it("a double Fire queues one burst and runs the engine once", async () => {
    const c = new GatewayController();
    const run = vi.spyOn(c.engine, "run");
    const first = c.fireBurst();
    expect(c.store.get().burst).toMatchObject({ status: "queued", index: 1, runId: -1, cold: null });
    expect(isBurstActive(c.store.get().burst)).toBe(true);
    const second = c.fireBurst();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(c.store.get().burst).toMatchObject({ status: "running", index: 1, cold: true });

    dispatchAll(c);
    const s = c.store.get();
    expect(s.burst?.status).toBe("done");
    expect(s.burst?.completed).toHaveLength(50);
    expect(s.bursts).toHaveLength(1);
    expect(s.bursts[0]).toMatchObject({ index: 1, cold: true });

    await c.fireBurst();
    dispatchAll(c);
    expect(c.store.get().bursts[1]).toMatchObject({ index: 2, cold: false, upstreamCalls: 0 });
  });

  it("cold start is a no-op while a burst is queued, and runs in the engine queue once idle", async () => {
    const c = new GatewayController();
    const fire = c.fireBurst();
    await c.coldStart();
    await c.sendPair(PROMPTS.apple, PROMPTS.microsoft);
    expect(c.store.get().burst).toMatchObject({ status: "queued", index: 1 });
    await fire;
    expect(c.engine.exact.peek(snowflake)).toBeDefined();
    expect(c.store.get().burst).toMatchObject({ status: "running", index: 1 });
    dispatchAll(c);

    const inFlight = c.engine.run(entityTrapWorkload());
    const cold = c.coldStart();
    expect(c.store.get().bursts).toEqual([]);
    expect(c.store.get().burst).toBeNull();
    await inFlight;
    await cold;
    expect(c.engine.exact.peek(snowflake)).toBeUndefined();

    await c.fireBurst();
    expect(c.store.get().burst).toMatchObject({ index: 1, cold: true });
  });
});

describe("gateway controller · chaos, off-screen traffic and catch-up", () => {
  type Internals = {
    dispatch(now: number, wall?: number): void;
    ambientStep(): Promise<void>;
    events: SceneEvent[];
  };
  const internals = (c: GatewayController) => c as unknown as Internals;
  const decisions = (s: GatewayState) => [...DECISION_COUNTERS].reduce((sum, key) => sum + s.counters[key], 0);
  const record = (c: GatewayController) => {
    const scene: SceneEvent[] = [];
    c.onScene((e) => scene.push(e));
    return scene;
  };

  it("fresh traffic misses both tiers and reaches the primary, round after round", async () => {
    const engine = fresh();
    await engine.run(burstWorkload());
    for (let round = 0; round < 4; round++) {
      const items = freshWorkload(round);
      for (const item of items) engine.forget(item.body);
      const { traces } = await engine.run(items);
      for (const t of traces) {
        expect(t).toMatchObject({ outcome: "UPSTREAM", entityVeto: false, coalesced: null });
        expect(t.route).toMatchObject({ tier: "fast", provider: "groq" });
      }
    }
  });

  it("killing Groq while the corridor is off screen still trips its breaker", async () => {
    const c = new GatewayController();
    const scene = record(c);
    const before = Date.now();
    await c.setPrimaryKilled(true);
    const s = c.store.get();
    expect(c.engine.breakers.groq.state).toBe("OPEN");
    expect(s.breakers.groq).toMatchObject({ state: "OPEN", trips: 1, reason: "HTTP 429" });
    expect(s.breakers.groq.since).toBeGreaterThanOrEqual(before);
    expect(s.breakers.groq.since).toBeLessThanOrEqual(Date.now());
    expect(s.totals).toMatchObject({ requests: 3, upstream: 3, failovers: 3, errors: 0 });
    expect(s.counters).toMatchObject({ fast: 3, upstream: 3, failovers: 3 });
    expect(decisions(s)).toBe(s.totals.requests);
    expect(s).toMatchObject({ inFlight: 0, chaosPending: false });
    // nobody is watching, so nothing was choreographed
    expect(scene).toHaveLength(0);
    expect(c.activePlans(performance.now())).toHaveLength(0);

    // a second kill is a no-op, not another round of traffic
    await c.setPrimaryKilled(true);
    expect(c.store.get().totals.requests).toBe(3);
  });

  it("ambient traffic lands headless off screen, plays when watched and stops while paused", async () => {
    const c = new GatewayController();
    for (let i = 0; i < 6; i++) await internals(c).ambientStep();
    let s = c.store.get();
    expect(s.totals.requests).toBe(6);
    expect(s.feed).toHaveLength(6);
    expect(decisions(s)).toBe(6);
    expect(c.activePlans(performance.now())).toHaveLength(0);

    c.setSceneVisible(true);
    await internals(c).ambientStep();
    expect(c.store.get().totals.requests).toBe(6);
    expect(c.activePlans(performance.now())).toHaveLength(1);
    internals(c).dispatch(Infinity);
    s = c.store.get();
    expect(s.totals.requests).toBe(7);
    expect(decisions(s)).toBe(7);

    c.setPaused(true);
    await internals(c).ambientStep();
    expect(c.store.get().totals.requests).toBe(7);
  });

  it("a kill while a burst is queued or playing is flagged pending and applies right after the burst", async () => {
    const c = new GatewayController();
    const fire = c.fireBurst();
    await c.setPrimaryKilled(true);
    expect(c.store.get()).toMatchObject({ primaryKilled: true, chaosPending: true });
    await fire;
    expect(c.store.get().chaosPending).toBe(true);
    // back to the chaos the burst was routed under: nothing is pending
    await c.setPrimaryKilled(false);
    expect(c.store.get().chaosPending).toBe(false);
    await c.setPrimaryKilled(true);
    expect(c.store.get().chaosPending).toBe(true);
    expect(c.store.get().totals.requests).toBe(0);

    internals(c).dispatch(Infinity);
    const s = c.store.get();
    expect(s.burst?.status).toBe("done");
    expect(s.chaosPending).toBe(false);
    // the burst was computed with a healthy primary and plays out that way
    expect(s.burst?.completed.some((t) => t.route?.failover)).toBe(false);
    expect(s.breakers.groq.state).toBe("CLOSED");
    // the next requests meet the dead key
    await vi.waitFor(() => expect(c.store.get().breakers.groq.state).toBe("OPEN"));
    expect(c.store.get().totals.requests).toBe(53);
  });

  it("returning to the tab long after a burst settles it in one batch without replaying it", async () => {
    const c = new GatewayController();
    c.engine.setChaos("groq", "rate_limited");
    const scene = record(c);
    await c.fireBurst();
    const timeline = [...internals(c).events];
    const t0 = timeline[0].at;
    const back = timeline[timeline.length - 1].at + 30_000;
    const wall0 = 1_800_000_000_000;
    const clock = (t: number) => wall0 + (t - t0);

    internals(c).dispatch(t0 - 16, clock(t0 - 16));
    internals(c).dispatch(t0, clock(t0));
    const live = scene.length;
    expect(live).toBeGreaterThan(0);

    let sets = 0;
    const unsubscribe = c.store.subscribe(() => sets++);
    internals(c).dispatch(back, clock(back));
    unsubscribe();

    const s = c.store.get();
    expect(sets).toBe(1);
    expect(s.burst?.status).toBe("done");
    expect(s.totals.requests).toBe(50);
    expect(s.inFlight).toBe(0);
    expect(decisions(s)).toBe(50);

    // no sparks, flashes or vetoes from half a minute ago; each provider gets its latest transition only
    const breakers = timeline.filter((e): e is Extract<SceneEvent, { type: "breaker" }> => e.type === "breaker");
    const lastOf = new Map(breakers.map((e) => [e.provider, e]));
    expect(lastOf.get("groq")?.to).toBe("OPEN");
    expect(scene.slice(live)).toEqual([...lastOf.values()]);

    // the trip keeps the time it happened, so its cooldown is not restarted
    expect(Math.abs(s.breakers.groq.since - clock(lastOf.get("groq")!.at))).toBeLessThan(1);
    expect(s.breakers.groq.trips).toBe(breakers.filter((e) => e.provider === "groq" && e.to === "OPEN").length);
    expect(s.veto).toBeNull();
    expect(s.counters.vetoes).toBe(3);
  });

  it("returning mid-burst shows only the last two seconds, back-dated, and keeps the in-flight gap", async () => {
    const c = new GatewayController();
    const scene = record(c);
    await c.fireBurst();
    const timeline = [...internals(c).events];
    const t0 = timeline[0].at;
    const vetoes = timeline.filter((e) => e.type === "veto");
    const lastVeto = vetoes[vetoes.length - 1];
    const back = lastVeto.at + 1500;
    const clock = (t: number) => 1_800_000_000_000 + (t - t0);

    internals(c).dispatch(t0 - 16, clock(t0 - 16));
    const live = scene.length;
    internals(c).dispatch(back, clock(back));

    const due = timeline.filter((e) => e.at <= back);
    const shown = scene.slice(live);
    expect(shown.length).toBeGreaterThan(0);
    for (const e of shown) if (e.type !== "breaker") expect(back - e.at).toBeLessThanOrEqual(2000);
    expect(shown.filter((e) => e.type !== "breaker")).toHaveLength(due.filter((e) => back - e.at <= 2000).length);

    const s = c.store.get();
    // the veto card opens for what is left of its read time, not a fresh one
    expect(Math.abs(s.veto!.at - clock(lastVeto.at))).toBeLessThan(1);
    expect(s.counters.vetoes).toBe(vetoes.length);
    expect(s.inFlight).toBeGreaterThan(0);
    expect(decisions(s)).toBe(s.totals.requests + s.inFlight);
    expect(s.burst?.status).toBe("running");

    internals(c).dispatch(Infinity);
    expect(c.store.get()).toMatchObject({ inFlight: 0, burst: { status: "done" } });
  });

  it("a failed Fire restores the previous burst and reports instead of throwing", async () => {
    const c = new GatewayController();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(c.engine, "run").mockImplementationOnce(() =>
      c.engine.enqueue(() => {
        throw new Error("engine down");
      }),
    );
    await expect(c.fireBurst()).resolves.toBeUndefined();
    expect(c.store.get()).toMatchObject({ burst: null, lastError: "engine down" });
    await c.fireBurst();
    expect(c.store.get()).toMatchObject({ lastError: null, burst: { index: 1, status: "running" } });
    quiet.mockRestore();
  });
});
