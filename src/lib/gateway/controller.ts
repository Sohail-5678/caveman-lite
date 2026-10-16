/**
 * Client-side orchestrator: owns the engine, plays choreographed runs in real time, feeds the 3D scene
 * and keeps the UI store in step with what the viewer actually sees.
 */
import type { ProviderId } from "../types";
import type { BreakerState } from "../router/circuit-breaker";
import { percentile } from "../utils/prng";
import {
  agentBody,
  ambientRequest,
  sdkBody,
  burstWorkload,
  entityTrapWorkload,
  freshWorkload,
  PROMPTS,
  seedEntries,
  writeResponse,
} from "../workload-traces";
import { exactKey } from "../cache/exact-cache";
import { GatewayEngine, type GatewayTrace, type RunResult } from "./engine";
import {
  choreograph,
  DECISION_COUNTERS,
  SCENE,
  type CounterKey,
  type PacketPlan,
  type SceneEvent,
  type Tone,
} from "./choreography";
import { createStore, type Store } from "./store";

export const BREAKER_COOLDOWN_MS = 30_000;
/** A dispatch frame this long after the previous one means the loop was suspended (hidden tab): fast-forward. */
const CATCH_UP_GAP_MS = 1000;
/** When fast-forwarding, flashes, sparks and vetoes older than this are dropped. */
const STALE_MS = 2000;

const pageVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

export interface BreakerView {
  state: BreakerState;
  /** Wall-clock time of the transition (Date.now() scale). */
  since: number;
  reason: string;
  trips: number;
}

export interface BurstState {
  /** -1 while queued: the engine has not run it yet. */
  runId: number;
  status: "queued" | "running" | "done";
  /** 1-based burst number since the last cold start, fixed when Fire was pressed. */
  index: number;
  total: number;
  completed: GatewayTrace[];
  upstreamCalls: number;
  /** null while queued: the cache is only checked when the engine picks the burst up. */
  cold: boolean | null;
  startedAt: number;
}

/** True while a burst is queued or in flight; use this to disable Fire / Cold start. */
export function isBurstActive(burst: BurstState | null): boolean {
  return !!burst && burst.status !== "done";
}

export interface BurstSummary {
  runId: number;
  index: number;
  cold: boolean;
  p50: number;
  p95: number;
  p99: number;
  baselineP50: number;
  baselineP95: number;
  baselineP99: number;
  admitted: number;
  served: number;
  upstreamCalls: number;
  costUsd: number;
  baselineCostUsd: number;
}

export interface Totals {
  requests: number;
  blocked: number;
  t1: number;
  t2: number;
  coalesced: number;
  upstream: number;
  vetoes: number;
  failovers: number;
  errors: number;
  costUsd: number;
  baselineCostUsd: number;
  tokensSent: number;
  tokensBaseline: number;
  latencies: number[];
  baselineLatencies: number[];
}

export interface VetoNotice {
  at: number;
  similarity: number;
  threshold: number;
  reasons: string[];
  prompt: string;
  matched: string | null;
}

export interface GatewayState {
  ready: boolean;
  burst: BurstState | null;
  bursts: BurstSummary[];
  feed: GatewayTrace[];
  /** Settled requests: a response has come back. */
  totals: Totals;
  /** Gate decisions, counted as packets reach each gate. */
  counters: Record<CounterKey, number>;
  /** Requests already counted in `counters` whose response has not settled into `totals` yet. */
  inFlight: number;
  breakers: Record<ProviderId, BreakerView>;
  primaryKilled: boolean;
  /**
   * The kill switch changed while a burst was queued or playing. That burst was routed before the change,
   * so it plays out as computed and the change applies to new requests. Clears when the burst finishes.
   */
  chaosPending: boolean;
  /** performance.now() when a kill control was armed; null when disarmed. Shared by the dock and the safety cover. */
  killArmedAt: number | null;
  /** The verification drawer covers the page: no ambient traffic, the corridor is not watched. */
  paused: boolean;
  /** Why the last Fire failed; cleared by the next Fire. */
  lastError: string | null;
  veto: VetoNotice | null;
  inspector: { a: string; b: string; nonce: number };
  policy: Record<string, string>;
}

type SceneListener = (event: SceneEvent) => void;

const emptyCounters = (): Record<CounterKey, number> => ({
  blocked: 0,
  t1Hits: 0,
  t2Hits: 0,
  vetoes: 0,
  coalesced: 0,
  upstream: 0,
  fast: 0,
  frontier: 0,
  failovers: 0,
});

const emptyTotals = (): Totals => ({
  requests: 0,
  blocked: 0,
  t1: 0,
  t2: 0,
  coalesced: 0,
  upstream: 0,
  vetoes: 0,
  failovers: 0,
  errors: 0,
  costUsd: 0,
  baselineCostUsd: 0,
  tokensSent: 0,
  tokensBaseline: 0,
  latencies: [],
  baselineLatencies: [],
});

const closedBreaker = (): BreakerView => ({ state: "CLOSED", since: 0, reason: "healthy", trips: 0 });

export function initialGatewayState(): GatewayState {
  return {
    ready: false,
    burst: null,
    bursts: [],
    feed: [],
    totals: emptyTotals(),
    counters: emptyCounters(),
    inFlight: 0,
    breakers: { groq: closedBreaker(), gemini: closedBreaker(), claude: closedBreaker() },
    primaryKilled: false,
    chaosPending: false,
    killArmedAt: null,
    paused: false,
    lastError: null,
    veto: null,
    inspector: { a: PROMPTS.apple, b: PROMPTS.microsoft, nonce: 0 },
    policy: {},
  };
}

export class GatewayController {
  readonly store: Store<GatewayState>;
  readonly engine: GatewayEngine;

  private plans: PacketPlan[] = [];
  private events: SceneEvent[] = [];
  private listeners = new Set<SceneListener>();
  private traceIndex = new Map<number, GatewayTrace>();
  private raf = 0;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private ambientTick = 0;
  private freshRound = 0;
  /** Groq was killed while a burst held the queue: send it fresh traffic once the burst is done. */
  private freshPending = false;
  /** primaryKilled when the active burst was enqueued, i.e. the chaos it was routed under. */
  private burstKilled = false;
  /** Traces counted at a deciding gate whose completion has not been dispatched yet. */
  private decided = new Set<number>();
  private lastFrame = 0;
  private sceneVisible = false;
  private started = false;
  private burstCount = 0;
  /** Set synchronously on Fire, so a double click can't start a second burst before the store says "queued". */
  private firing = false;
  private probing = new Set<ProviderId>();
  private reduced = false;

  constructor() {
    this.engine = new GatewayEngine(writeResponse);
    this.engine.warm(seedEntries());
    this.store = createStore<GatewayState>(initialGatewayState());
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const loop = () => {
      this.dispatch(performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(loop);
    this.probeTimer = setInterval(() => this.probeBreakers(), 500);
    this.store.set({ ready: true });
    this.scheduleAmbient(900);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.started = false;
  }

  /** The corridor is on screen in a visible tab. Off screen, runs skip the choreography and land at once. */
  setSceneVisible(visible: boolean): void {
    this.sceneVisible = visible;
  }

  /** The verification drawer is open: ambient traffic stops and the corridor counts as not watched. */
  setPaused(paused: boolean): void {
    if (this.store.get().paused !== paused) this.store.set({ paused });
  }

  /** Scene effects (gate flashes, sparks, breaker rings) are pushed as they fall due. */
  onScene(listener: SceneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activePlans(now: number): PacketPlan[] {
    return this.plans.filter((p) => p.start <= now + 50 && p.end >= now - 1200);
  }

  /* ── actions ───────────────────────────────────────────────────────────── */

  /** Never rejects: a failed run restores the previous burst and sets `lastError`. */
  async fireBurst(): Promise<void> {
    const previous = this.store.get().burst;
    if (this.firing || isBurstActive(previous)) return;
    this.firing = true;
    this.burstKilled = this.store.get().primaryKilled;
    const index = ++this.burstCount;
    const workload = burstWorkload();
    this.store.set({
      burst: {
        runId: -1,
        status: "queued",
        index,
        total: workload.length,
        completed: [],
        upstreamCalls: 0,
        cold: null,
        startedAt: performance.now(),
      },
      lastError: null,
    });
    try {
      // Enqueued back to back, so nothing can touch the caches between the cold check and the run.
      const coldCheck = this.engine.enqueue(() => !this.engine.exact.peek(exactKey(agentBody(PROMPTS.snowflake))));
      const run = this.engine.run(workload);
      const cold = await coldCheck;
      const result = await run;
      this.store.set({
        burst: {
          runId: result.runId,
          status: "running",
          index,
          total: result.traces.length,
          completed: [],
          upstreamCalls: result.upstreamCalls,
          cold,
          startedAt: performance.now(),
        },
      });
      this.play(result, 80);
    } catch (error) {
      this.burstCount = index - 1;
      console.error(error);
      this.store.set({
        burst: previous,
        chaosPending: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.firing = false;
    }
    this.flushFresh();
  }

  async runEntityTrap(): Promise<void> {
    if (this.busy()) return;
    this.store.set((s) => ({ inspector: { a: PROMPTS.apple, b: PROMPTS.microsoft, nonce: s.inspector.nonce + 1 } }));
    await this.sendPair(PROMPTS.apple, PROMPTS.microsoft);
  }

  /** Cache A, make sure B is not cached, then send B through the corridor. No-op while a burst is active. */
  async sendPair(a: string, b: string, delay = 40): Promise<void> {
    if (this.busy()) return;
    const item = { ...entityTrapWorkload()[0], body: agentBody(b) };
    // Enqueued back to back with the run, so the warm/forget can't interleave with another run.
    const prepared = this.engine.enqueue(() => {
      this.engine.warm([{ body: agentBody(a), model: "gemini-2.5-pro", completionTokens: 300 }]);
      this.engine.forget(item.body);
    });
    const run = this.engine.run([item]);
    await prepared;
    this.play(await run, delay);
  }

  /** Send one prompt through the full pipeline (it also travels the corridor when watched) and return its trace. */
  async runPrompt(prompt: string): Promise<GatewayTrace> {
    const item = { ...entityTrapWorkload()[0], label: "playground", body: sdkBody(prompt), contextTokens: 0, worker: 7 };
    const result = await this.land(this.engine.run([item]));
    return result.traces[0];
  }

  /**
   * Kill or restore Groq for every request enqueued from now on. A burst that is already queued or playing was
   * routed before the change and plays out as computed (`chaosPending`). A kill also sends fresh fast-tier
   * traffic, at once or after that burst, since ambient requests are mostly cache hits that never reach Groq.
   * Resolves once that traffic has landed.
   */
  setPrimaryKilled(killed: boolean): Promise<void> {
    if (killed === this.store.get().primaryKilled) return Promise.resolve();
    void this.engine.enqueue(() => this.engine.setChaos("groq", killed ? "rate_limited" : "healthy"));
    const busy = this.busy();
    this.freshPending = killed && busy;
    this.store.set({ primaryKilled: killed, killArmedAt: null, chaosPending: busy && killed !== this.burstKilled });
    return killed && !busy ? this.sendFresh() : Promise.resolve();
  }

  /** Arm or disarm the kill. Any kill or restore disarms it. */
  armKill(armed: boolean): void {
    this.store.set({ killArmedAt: armed ? performance.now() : null });
  }

  /** Drop both cache tiers and the burst history. No-op while a burst is queued or running. */
  async coldStart(): Promise<void> {
    if (this.busy()) return;
    this.burstCount = 0;
    this.store.set({ bursts: [], burst: null });
    await this.engine.enqueue(() => {
      this.engine.clearCaches();
      this.engine.warm(seedEntries());
    });
  }

  setInspectorPair(a: string, b: string): void {
    this.store.set((s) => ({ inspector: { a, b, nonce: s.inspector.nonce + 1 } }));
  }

  applyPolicy(nodeId: string, modelId: string): void {
    this.store.set((s) => ({ policy: { ...s.policy, [nodeId]: modelId } }));
  }

  private busy(): boolean {
    return this.firing || isBurstActive(this.store.get().burst);
  }

  /** Fresh fast-tier requests the cache has never answered, so each one reaches the primary. */
  private async sendFresh(): Promise<void> {
    this.freshPending = false;
    const items = freshWorkload(this.freshRound++);
    const prepared = this.engine.enqueue(() => items.forEach((item) => this.engine.forget(item.body)));
    const run = this.engine.run(items);
    try {
      await this.land(Promise.all([prepared, run]).then(([, result]) => result));
    } catch (error) {
      console.error(error);
    }
  }

  private flushFresh(): void {
    if (this.freshPending && !this.busy()) void this.sendFresh();
  }

  /* ── playback ──────────────────────────────────────────────────────────── */

  private watched(): boolean {
    return this.sceneVisible && !this.store.get().paused && pageVisible();
  }

  /** A watched run travels the corridor; an unwatched one lands in the store as soon as the engine is done. */
  private async land(run: Promise<RunResult>): Promise<RunResult> {
    const result = await run;
    if (this.watched()) this.play(result, 0);
    else this.settle(result);
    return result;
  }

  private play(result: RunResult, delay: number): void {
    const start = performance.now() + delay;
    const { plans, events } = choreograph(result.traces, start);
    for (const t of result.traces) this.traceIndex.set(t.id, t);
    this.plans = [...this.plans.filter((p) => p.end > performance.now() - 1500), ...plans];
    this.events = [...this.events, ...events].sort((a, b) => a.at - b.at);
  }

  /** Headless landing: the counters the choreography would have raised, breakers at engine time, no scene events. */
  private settle(result: RunResult): void {
    const s = this.store.get();
    const counters = { ...s.counters };
    for (const e of choreograph(result.traces, 0).events) if (e.type === "counter") counters[e.key] += 1;
    const wall = Date.now();
    const transitions = result.traces.flatMap((t) => t.breakerEvents).sort((a, b) => a.at - b.at);
    const breakers = { ...s.breakers };
    for (const e of transitions) {
      breakers[e.provider] = {
        state: e.to,
        // run-anchored virtual time can run a few hundred ms ahead of the clock
        since: Math.min(e.at, wall),
        reason: e.reason,
        trips: breakers[e.provider].trips + (e.to === "OPEN" ? 1 : 0),
      };
    }
    this.store.set({ counters, ...(transitions.length ? { breakers } : {}), ...this.absorb(result.traces) });
  }

  private emit(event: SceneEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  /**
   * Emits due scene events and folds them into the store. After a suspended loop (hidden tab) the backlog is
   * fast-forwarded in one batch: every count and completion is kept, but only events younger than STALE_MS are
   * shown, and each provider gets only its latest breaker transition. Times are back-dated to when each event
   * fell due, so cooldowns and the veto card's read time stay honest.
   */
  private dispatch(now: number, wall = Date.now()): void {
    const catchUp = now - this.lastFrame > CATCH_UP_GAP_MS;
    this.lastFrame = now;
    if (this.events.length === 0 || this.events[0].at > now) return;
    const due: SceneEvent[] = [];
    while (this.events.length && this.events[0].at <= now) due.push(this.events.shift()!);

    const ageOf = (e: SceneEvent) => (Number.isFinite(now) ? Math.max(0, now - e.at) : 0);
    const latest = new Map<ProviderId, SceneEvent>();
    if (catchUp) for (const e of due) if (e.type === "breaker") latest.set(e.provider, e);

    const s = this.store.get();
    let counters = s.counters;
    let breakers = s.breakers;
    const completed: GatewayTrace[] = [];
    let veto = s.veto;

    for (const event of due) {
      const age = ageOf(event);
      if (event.type === "breaker") {
        if (!catchUp || latest.get(event.provider) === event) this.emit(event);
        const prev = breakers[event.provider];
        breakers = {
          ...breakers,
          [event.provider]: {
            state: event.to,
            since: wall - age,
            reason: event.reason,
            trips: prev.trips + (event.to === "OPEN" ? 1 : 0),
          },
        };
        continue;
      }
      const news = age <= STALE_MS;
      if (news) this.emit(event);
      if (event.type === "counter") {
        counters = { ...counters, [event.key]: counters[event.key] + 1 };
        if (DECISION_COUNTERS.has(event.key)) this.decided.add(event.traceId);
      } else if (event.type === "veto") {
        if (news) veto = { at: wall - age, similarity: event.similarity, threshold: event.threshold, reasons: event.reasons, prompt: event.prompt, matched: event.matched };
      } else if (event.type === "complete") {
        this.decided.delete(event.traceId);
        const trace = this.traceIndex.get(event.traceId);
        if (trace) {
          completed.push(trace);
          this.traceIndex.delete(event.traceId);
        }
      }
    }

    const patch: Partial<GatewayState> = {};
    if (counters !== s.counters) patch.counters = counters;
    if (breakers !== s.breakers) patch.breakers = breakers;
    if (veto !== s.veto) patch.veto = veto;
    if (this.decided.size !== s.inFlight) patch.inFlight = this.decided.size;
    if (completed.length) Object.assign(patch, this.absorb(completed));
    if (Object.keys(patch).length) this.store.set(patch);
    this.flushFresh();
  }

  private absorb(done: GatewayTrace[]): Partial<GatewayState> {
    const s = this.store.get();
    const totals: Totals = {
      ...s.totals,
      latencies: [...s.totals.latencies],
      baselineLatencies: [...s.totals.baselineLatencies],
    };
    for (const t of done) {
      totals.requests += 1;
      totals.costUsd += t.costUsd;
      totals.baselineCostUsd += t.outcome === "BLOCKED" ? 0 : t.baselineCostUsd;
      totals.tokensSent += t.tokens.sent;
      totals.tokensBaseline += t.outcome === "BLOCKED" ? 0 : t.tokens.prompt;
      if (t.outcome !== "BLOCKED") {
        totals.latencies.push(t.latencyMs);
        totals.baselineLatencies.push(t.baselineLatencyMs);
      }
      if (t.entityVeto) totals.vetoes += 1;
      if (t.route?.failover) totals.failovers += 1;
      switch (t.outcome) {
        case "BLOCKED":
          totals.blocked += 1;
          break;
        case "T1_HIT":
          totals.t1 += 1;
          break;
        case "T2_HIT":
          totals.t2 += 1;
          break;
        case "COALESCED":
          totals.coalesced += 1;
          break;
        case "UPSTREAM":
          totals.upstream += 1;
          break;
        case "ERROR":
          totals.errors += 1;
          break;
      }
    }
    if (totals.latencies.length > 600) totals.latencies.splice(0, totals.latencies.length - 600);
    if (totals.baselineLatencies.length > 600) totals.baselineLatencies.splice(0, totals.baselineLatencies.length - 600);

    const feed = [...done.slice().reverse(), ...s.feed].slice(0, 160);
    const patch: Partial<GatewayState> = { totals, feed };

    const burst = s.burst;
    if (burst && burst.status === "running") {
      const mine = done.filter((t) => t.runId === burst.runId);
      if (mine.length) {
        const completed = [...burst.completed, ...mine];
        const finished = completed.length >= burst.total;
        patch.burst = { ...burst, completed, status: finished ? "done" : "running" };
        if (finished) {
          patch.bursts = [...s.bursts, this.summarize(burst, completed)];
          patch.chaosPending = false;
        }
      }
    }
    return patch;
  }

  private summarize(burst: BurstState, traces: GatewayTrace[]): BurstSummary {
    const admitted = traces.filter((t) => t.outcome !== "BLOCKED");
    const lat = admitted.map((t) => t.latencyMs);
    const base = admitted.map((t) => t.baselineLatencyMs);
    return {
      runId: burst.runId,
      index: burst.index,
      cold: burst.cold === true,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      baselineP50: percentile(base, 50),
      baselineP95: percentile(base, 95),
      baselineP99: percentile(base, 99),
      admitted: admitted.length,
      served: traces.filter((t) => t.outcome === "T1_HIT" || t.outcome === "T2_HIT" || t.outcome === "COALESCED").length,
      upstreamCalls: burst.upstreamCalls,
      costUsd: traces.reduce((sum, t) => sum + t.costUsd, 0),
      baselineCostUsd: admitted.reduce((sum, t) => sum + t.baselineCostUsd, 0),
    };
  }

  /* ── background traffic & health probes ────────────────────────────────── */

  private scheduleAmbient(delay: number): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = setTimeout(async () => {
      await this.ambientStep();
      if (!this.started) return;
      // Off screen the traffic is headless and sparser: enough to keep breakers and KPIs live.
      const gap = this.watched() ? (this.reduced ? 2600 : 1250) + Math.random() * 700 : 3200 + Math.random() * 1600;
      this.scheduleAmbient(gap);
    }, delay);
  }

  /** One ambient request: played in the corridor when watched, settled straight into the store otherwise. */
  private async ambientStep(): Promise<void> {
    if (this.store.get().paused || this.busy() || !pageVisible()) return;
    try {
      await this.land(this.engine.run([ambientRequest(this.ambientTick++)]));
    } catch (error) {
      console.error(error);
    }
  }

  private probeBreakers(): void {
    const { breakers } = this.store.get();
    const now = Date.now();
    (Object.keys(breakers) as ProviderId[]).forEach((provider) => {
      const view = breakers[provider];
      if (view.state !== "OPEN" || now - view.since < BREAKER_COOLDOWN_MS || this.probing.has(provider)) return;
      this.probing.add(provider);
      // Queued like a run, so the probe never lands on a breaker mid-burst.
      this.engine
        .enqueue(() => this.engine.probe(provider))
        .then((result) => {
          if (!result.attempted) return;
          const probeOk = result.to === "CLOSED";
          const p = SCENE.providers[provider];
          const at = performance.now();
          const tone: Tone = probeOk ? "malachite" : "cinnabar";
          const reason = probeOk ? "half-open probe succeeded" : "half-open probe failed: HTTP 429";
          this.emit({ at, type: "provider", provider, tone, status: probeOk ? "done" : "429" });
          this.emit({ at, type: "spark", pos: [p.x - 0.45, 1.0, p.z], tone, count: probeOk ? 10 : 16 });
          this.emit({ at, type: "breaker", provider, to: result.to, reason });
          this.store.set((s) => ({
            breakers: {
              ...s.breakers,
              [provider]: {
                state: result.to,
                // Outside a run the engine clock is wall time, so the countdown restarts at the real transition.
                since: result.at,
                reason,
                trips: s.breakers[provider].trips + (result.to === "OPEN" ? 1 : 0),
              },
            },
          }));
        })
        .catch(() => undefined)
        .finally(() => this.probing.delete(provider));
    });
  }
}

let singleton: GatewayController | null = null;

export function getController(): GatewayController {
  if (!singleton) singleton = new GatewayController();
  return singleton;
}
