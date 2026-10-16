/**
 * Gateway engine — the request pipeline shared by the burst simulator, the playground and the API route:
 *
 *   pre-flight firewall → T1 exact cache → T2 semantic cache + entity guard → singleflight lock
 *   → complexity router + prompt compressor → provider pool behind per-provider circuit breakers
 *
 * Every stage is the real implementation. Only upstream latency is simulated, on a pluggable clock.
 */
import type { ChatMessage, ChatRequestBody, ProviderId, Tier } from "../types";
import { ExactCache, exactKey } from "../cache/exact-cache";
import { SemanticCache, cosine, type SemanticVerdict } from "../cache/semantic-cache";
import { checkParity, type EntitySet, type ParityReason } from "../cache/entity-guard";
import { Singleflight, type FlightResult } from "../cache/stampede-lock";
import { classifyComplexity } from "../router/complexity-classifier";
import { CircuitBreaker, type BreakerState, type BreakerSnapshot } from "../router/circuit-breaker";
import { compressMessages, estimateTokens } from "../router/prompt-compressor";
import { inspectPrompt, type FirewallVerdict } from "../security/preflight-firewall";
import { fnv1a, lognormal, mulberry32 } from "../utils/prng";
import { VirtualClock } from "./clock";
import {
  BASELINE_MODEL,
  MODELS,
  PROVIDER_ORDER,
  ROUTE_PLANS,
  SYSTEM_PROMPT_TOKENS,
  TTFT_SLA_MS,
  costUsd,
} from "./providers";

export type Outcome = "BLOCKED" | "T1_HIT" | "T2_HIT" | "COALESCED" | "UPSTREAM" | "ERROR";
export type ChaosMode = "healthy" | "rate_limited";
export type FailoverReason = "CIRCUIT_OPEN" | "HTTP_429" | "TTFT_SLA";

export interface WorkloadItem {
  /** Short tag for the trace table, e.g. "stampede". */
  label: string;
  body: ChatRequestBody;
  /** Arrival offset inside the run, ms. */
  arrivalMs: number;
  /** Retrieved context the agent attaches (tokens). */
  contextTokens: number;
  completionTokens: number;
  /** Which of the 50 agent workers fired it. */
  worker: number;
}

export interface StageTimings {
  network: number;
  firewall: number;
  t1: number;
  t2: number;
  lock: number;
  router: number;
  upstream: number;
}

export interface ProviderAttempt {
  model: string;
  provider: ProviderId;
  status: 200 | 429 | "OPEN";
  ttftMs: number;
  /** Lost (or won) a speculative hedge race. */
  hedge?: "lost" | "won";
}

export interface BreakerEvent {
  provider: ProviderId;
  from: BreakerState;
  to: BreakerState;
  reason: string;
  /** Index into route.attempts that caused it. */
  attemptIndex: number;
  /** Engine clock time of the transition. Inside a run this is run-anchored virtual time, not wall time. */
  at: number;
}

export interface RouteInfo {
  tier: Tier;
  probability: number;
  /** Model that answered; empty when every attempt failed (outcome ERROR). */
  model: string;
  /** Provider that answered, or the last one tried when every attempt failed. */
  provider: ProviderId;
  plannedModel: string;
  plannedProvider: ProviderId;
  failover: { from: ProviderId; to: ProviderId; reason: FailoverReason } | null;
  attempts: ProviderAttempt[];
  compressionSaved: number;
}

export interface SemanticInfo {
  verdict: SemanticVerdict;
  similarity: number;
  threshold: number;
  matchedPrompt: string | null;
  parityReasons: ParityReason[];
  naiveHit: boolean;
}

export interface GatewayTrace {
  id: number;
  runId: number;
  label: string;
  prompt: string;
  worker: number;
  arrivalMs: number;
  completedMs: number;
  outcome: Outcome;
  firewall: { verdict: FirewallVerdict; hits: string[]; redactions: number };
  exactKey: string;
  semantic: SemanticInfo | null;
  entityVeto: boolean;
  /** Set on followers: COALESCED, or ERROR when the leader they waited on failed. */
  coalesced: { leaderId: number; kind: "exact" | "semantic"; similarity: number | null } | null;
  /** Leaders only: followers that piggy-backed on this upstream call. */
  followers: number;
  /** Leaders only, for UPSTREAM and ERROR alike, so every provider attempt can be replayed. */
  route: RouteInfo | null;
  breakerEvents: BreakerEvent[];
  timings: StageTimings;
  /** Client-observed time to first token, ms. */
  latencyMs: number;
  /** Same request sent straight to the baseline frontier model, no gateway. */
  baselineLatencyMs: number;
  tokens: { prompt: number; sent: number; completion: number };
  costUsd: number;
  baselineCostUsd: number;
  response: string;
}

export interface RunResult {
  runId: number;
  traces: GatewayTrace[];
  upstreamCalls: number;
  durationMs: number;
}

interface CachedResponse {
  text: string;
  model: string;
  completionTokens: number;
}

interface UpstreamResult {
  response: CachedResponse;
  route: RouteInfo;
  breakerEvents: BreakerEvent[];
  routerMs: number;
  startedAt: number;
  completedAt: number;
  promptTokens: number;
  sentTokens: number;
  costUsd: number;
}

interface FlightMeta {
  leaderId: number;
  vector: Float32Array;
  entities: EntitySet;
}

class UpstreamUnavailable extends Error {
  constructor(
    readonly route: RouteInfo,
    readonly breakerEvents: BreakerEvent[],
    readonly routerMs: number,
    readonly startedAt: number,
    readonly completedAt: number,
  ) {
    super("All providers unavailable");
  }
}

export type ResponseWriter = (prompt: string, model: string) => string;

const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const round2 = (n: number) => Math.round(n * 100) / 100;

function lastUserContent(body: ChatRequestBody): string {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i].role === "user") return body.messages[i].content;
  }
  return "";
}

function withUserContent(body: ChatRequestBody, content: string): ChatRequestBody {
  let replaced = false;
  const messages: ChatMessage[] = [];
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (!replaced && m.role === "user") {
      messages.unshift({ ...m, content });
      replaced = true;
    } else {
      messages.unshift(m);
    }
  }
  return { ...body, messages };
}

function sampleTtft(model: string, rand: () => number): number {
  const spec = MODELS[model];
  return round2(lognormal(rand, spec.ttftMedianMs, spec.ttftSigma));
}

export class GatewayEngine {
  readonly exact = new ExactCache<CachedResponse>(2048);
  readonly semantic = new SemanticCache<CachedResponse>({ capacity: 2048 });
  readonly flights = new Singleflight<UpstreamResult>();
  readonly breakers: Record<ProviderId, CircuitBreaker>;
  readonly chaos: Record<ProviderId, ChaosMode> = { groq: "healthy", gemini: "healthy", claude: "healthy" };

  private nextId = 1;
  private nextRun = 1;
  private inFlight = new Map<string, FlightMeta>();
  private active: { clock: VirtualClock; anchor: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly writeResponse: ResponseWriter,
    private readonly seed = 2026,
  ) {
    const clock = () => this.now();
    this.breakers = {
      groq: new CircuitBreaker("groq", {}, clock),
      gemini: new CircuitBreaker("gemini", {}, clock),
      claude: new CircuitBreaker("claude", {}, clock),
    };
  }

  /** Pre-populate both cache tiers, as if these prompts were answered earlier today. */
  warm(entries: Array<{ body: ChatRequestBody; model: string; completionTokens: number }>): void {
    for (const { body, model, completionTokens } of entries) {
      const key = exactKey(body);
      if (this.exact.peek(key)) continue;
      const prompt = lastUserContent(body);
      const response: CachedResponse = { text: this.writeResponse(prompt, model), model, completionTokens };
      this.exact.set(key, response);
      this.semantic.insert(prompt, response);
    }
  }

  /** Remove one prompt from both tiers so the next request for it is a genuine miss. */
  forget(body: ChatRequestBody): void {
    this.exact.delete(exactKey(body));
    const prompt = lastUserContent(body).trim();
    const kept = this.semantic.entries().filter((e) => e.text.trim() !== prompt);
    if (kept.length === this.semantic.size) return;
    this.semantic.clear();
    for (const e of kept) this.semantic.insert(e.text, e.value, e.insertedAt);
  }

  /** Drop both cache tiers (cold start). Breakers and chaos settings are kept. */
  clearCaches(): void {
    this.exact.clear();
    this.semantic.clear();
  }

  setChaos(provider: ProviderId, mode: ChaosMode): void {
    this.chaos[provider] = mode;
  }

  breakerSnapshots(): Record<ProviderId, BreakerSnapshot> {
    return {
      groq: this.breakers.groq.snapshot(),
      gemini: this.breakers.gemini.snapshot(),
      claude: this.breakers.claude.snapshot(),
    };
  }

  /**
   * Health probe used once a breaker's cooldown has elapsed (HALF_OPEN). A CLOSED breaker is never probed,
   * so a stale view can't feed it a synthetic sample. `at` is the engine time of the resulting transition.
   */
  probe(provider: ProviderId): { attempted: boolean; from: BreakerState; to: BreakerState; at: number } {
    const breaker = this.breakers[provider];
    const from = breaker.state;
    if (from === "CLOSED" || !breaker.canRequest()) return { attempted: false, from, to: breaker.state, at: this.now() };
    if (this.chaos[provider] === "rate_limited") breaker.recordFailure("HTTP 429 on probe");
    else breaker.recordSuccess(MODELS[ROUTE_PLANS.fast[0]].ttftMedianMs);
    return { attempted: true, from, to: breaker.state, at: breaker.snapshot().lastTransition?.at ?? this.now() };
  }

  /**
   * Run `fn` on the same serial queue as run(), so cache and breaker mutations can't interleave with a burst.
   * Calls made back to back in one synchronous block execute back to back.
   */
  enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Fire a set of requests concurrently on a virtual clock. Runs are serialised. */
  run(items: WorkloadItem[]): Promise<RunResult> {
    return this.enqueue(() => this.execute(items));
  }

  /** Engine clock: run-anchored virtual time inside a run, wall time otherwise. */
  private now(): number {
    return this.active ? this.active.anchor + this.active.clock.now() : Date.now();
  }

  private async execute(items: WorkloadItem[]): Promise<RunResult> {
    const runId = this.nextRun++;
    const clock = new VirtualClock();
    this.active = { clock, anchor: Date.now() };
    const started = perfNow();
    const upstreamBefore = this.flights.stats.upstreamCalls;

    const ordered = items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.arrivalMs - b.item.arrivalMs || a.index - b.index);
    const pending = ordered.map(({ item }) => {
      const id = this.nextId++;
      return clock.sleep(item.arrivalMs).then(() => this.handle(item, id, runId, clock));
    });
    const all = Promise.all(pending);
    try {
      await clock.drain();
      const traces = await all;
      return {
        runId,
        traces: traces.sort((a, b) => a.id - b.id),
        upstreamCalls: this.flights.stats.upstreamCalls - upstreamBefore,
        durationMs: perfNow() - started,
      };
    } finally {
      this.active = null;
    }
  }

  private findInFlight(vector: Float32Array, entities: EntitySet, threshold: number) {
    let best: { key: string; similarity: number } | null = null;
    for (const [key, meta] of this.inFlight) {
      const similarity = cosine(vector, meta.vector);
      if (similarity < threshold) continue;
      if (!checkParity(entities, meta.entities).ok) continue;
      if (!best || similarity > best.similarity) best = { key, similarity };
    }
    return best;
  }

  private async handle(item: WorkloadItem, id: number, runId: number, clock: VirtualClock): Promise<GatewayTrace> {
    const arrival = clock.now();
    const rand = mulberry32(fnv1a(`${this.seed}:${id}:${item.label}`));
    const prompt = lastUserContent(item.body);
    const network = round2(lognormal(rand, 7.2, 0.18));
    const timings: StageTimings = { network, firewall: 0, t1: 0, t2: 0, lock: 0, router: 0, upstream: 0 };
    const promptTokens = SYSTEM_PROMPT_TOKENS + item.contextTokens + estimateTokens(prompt);
    const baselineLatencyMs = round2(network + sampleTtft(BASELINE_MODEL, rand));
    const baselineCostUsd = costUsd(BASELINE_MODEL, promptTokens, item.completionTokens);

    const trace: GatewayTrace = {
      id,
      runId,
      label: item.label,
      prompt,
      worker: item.worker,
      arrivalMs: arrival,
      completedMs: arrival,
      outcome: "ERROR",
      firewall: { verdict: "PASS", hits: [], redactions: 0 },
      exactKey: "",
      semantic: null,
      entityVeto: false,
      coalesced: null,
      followers: 0,
      route: null,
      breakerEvents: [],
      timings,
      latencyMs: 0,
      baselineLatencyMs,
      tokens: { prompt: promptTokens, sent: 0, completion: 0 },
      costUsd: 0,
      baselineCostUsd,
      response: "",
    };
    const compute = () => timings.firewall + timings.t1 + timings.t2 + timings.lock;
    const finish = (outcome: Outcome, waitedMs = 0) => {
      trace.outcome = outcome;
      trace.latencyMs = round2(network + compute() + timings.router + waitedMs);
      trace.completedMs = round2(arrival + trace.latencyMs);
      return trace;
    };

    // 1 · pre-flight firewall
    let t = perfNow();
    const fw = inspectPrompt(prompt, { nonce: (id * 2654435761 >>> 0).toString(16).slice(-6).padStart(6, "0") });
    timings.firewall = perfNow() - t;
    trace.firewall = { verdict: fw.verdict, hits: fw.hits.map((h) => h.label), redactions: fw.redactions.length };
    if (!fw.allowed) {
      trace.response = `403 · blocked by pre-flight firewall (${fw.hits[0]?.owasp ?? "LLM01"} ${fw.hits[0]?.label ?? "policy"})`;
      return finish("BLOCKED");
    }

    // 2 · T1 exact cache
    const body = withUserContent(item.body, fw.sanitized);
    t = perfNow();
    const key = exactKey(body);
    const exactHit = this.exact.get(key);
    timings.t1 = perfNow() - t;
    trace.exactKey = key;
    if (exactHit) {
      trace.response = exactHit.text;
      return finish("T1_HIT");
    }

    // 3 · T2 semantic cache + entity guard
    t = perfNow();
    const look = this.semantic.lookup(fw.sanitized);
    timings.t2 = perfNow() - t;
    trace.semantic = {
      verdict: look.verdict,
      similarity: look.best?.similarity ?? 0,
      threshold: look.threshold,
      matchedPrompt: look.best?.entry.text ?? null,
      parityReasons: look.parity?.reasons ?? [],
      naiveHit: look.naiveHit,
    };
    if (look.hit && look.best) {
      this.exact.set(key, look.best.entry.value);
      trace.response = look.best.entry.value.text;
      return finish("T2_HIT");
    }
    trace.entityVeto = look.verdict === "ENTITY_GUARD_VETO";

    // 4 · singleflight stampede lock (exact key first, then semantically-equivalent in-flight work)
    t = perfNow();
    let flightKey = key;
    let kind: "exact" | "semantic" = "exact";
    let similarity: number | null = null;
    if (!this.flights.isInFlight(key)) {
      const match = this.findInFlight(look.vector, look.entities, look.threshold);
      if (match) {
        flightKey = match.key;
        kind = "semantic";
        similarity = match.similarity;
      }
    }
    const leader = !this.flights.isInFlight(flightKey);
    if (leader) this.inFlight.set(flightKey, { leaderId: id, vector: look.vector, entities: look.entities });
    const leaderId = leader ? id : (this.inFlight.get(flightKey)?.leaderId ?? id);
    timings.lock = perfNow() - t;
    const joinedAt = clock.now();

    let result: FlightResult<UpstreamResult>;
    try {
      result = await this.flights.run(flightKey, () => this.upstream(item, body, prompt, key, clock, rand, promptTokens));
    } catch (error) {
      if (error instanceof UpstreamUnavailable) {
        if (leader) {
          trace.route = error.route;
          trace.breakerEvents = error.breakerEvents;
          timings.router = error.routerMs;
          timings.upstream = round2(error.completedAt - error.startedAt);
        } else {
          trace.coalesced = { leaderId, kind, similarity };
        }
        trace.response = "503 · every provider in the route plan is unavailable";
        return finish("ERROR", error.completedAt - joinedAt);
      }
      throw error;
    } finally {
      if (leader) this.inFlight.delete(flightKey);
    }

    const up = result.value;
    const waited = up.completedAt - joinedAt;
    trace.response = up.response.text;
    trace.tokens.completion = up.response.completionTokens;
    if (result.role === "follower") {
      trace.coalesced = { leaderId, kind, similarity };
      return finish("COALESCED", waited);
    }
    trace.followers = result.followers;
    trace.route = up.route;
    trace.breakerEvents = up.breakerEvents;
    trace.tokens.sent = up.sentTokens;
    trace.costUsd = up.costUsd;
    timings.router = up.routerMs;
    timings.upstream = round2(up.completedAt - up.startedAt);
    return finish("UPSTREAM", waited);
  }

  private async upstream(
    item: WorkloadItem,
    body: ChatRequestBody,
    prompt: string,
    key: string,
    clock: VirtualClock,
    rand: () => number,
    promptTokens: number,
  ): Promise<UpstreamResult> {
    const t = perfNow();
    const classification = classifyComplexity(body);
    const compression = compressMessages(body.messages);
    const routerMs = perfNow() - t;

    const plan = ROUTE_PLANS[classification.tier];
    const attempts: ProviderAttempt[] = [];
    const breakerEvents: BreakerEvent[] = [];
    let failover: RouteInfo["failover"] = null;
    const startedAt = clock.now();

    const note = (provider: ProviderId, from: BreakerState, reason: string, attemptIndex: number) => {
      const breaker = this.breakers[provider];
      const to = breaker.state;
      if (to === from) return;
      const at = breaker.snapshot().lastTransition?.at ?? this.now();
      breakerEvents.push({ provider, from, to, reason, attemptIndex, at });
    };
    const nextProvider = (i: number) => MODELS[plan[Math.min(i + 1, plan.length - 1)]].provider;

    for (let i = 0; i < plan.length; i++) {
      const model = plan[i];
      const provider = MODELS[model].provider;
      const breaker = this.breakers[provider];

      const before = breaker.state;
      if (!breaker.canRequest()) {
        attempts.push({ model, provider, status: "OPEN", ttftMs: 0 });
        failover ??= { from: provider, to: nextProvider(i), reason: "CIRCUIT_OPEN" };
        continue;
      }
      note(provider, before, "cooldown elapsed — probing", attempts.length);

      if (this.chaos[provider] === "rate_limited") {
        const failMs = round2(28 + rand() * 22);
        await clock.sleep(failMs);
        const b = breaker.state;
        breaker.recordFailure("HTTP 429");
        attempts.push({ model, provider, status: 429, ttftMs: failMs });
        note(provider, b, "HTTP 429", attempts.length - 1);
        failover ??= { from: provider, to: nextProvider(i), reason: "HTTP_429" };
        continue;
      }

      const ttft = sampleTtft(model, rand);
      const backup = plan[i + 1];
      if (ttft > TTFT_SLA_MS && backup) {
        const backupProvider = MODELS[backup].provider;
        const backupTtft = sampleTtft(backup, rand);
        const hedgeAvailable =
          this.chaos[backupProvider] === "healthy" && this.breakers[backupProvider].state === "CLOSED";
        if (hedgeAvailable && TTFT_SLA_MS + backupTtft < ttft) {
          // Speculative hedge fired at the SLA mark and its first token arrived first.
          await clock.sleep(TTFT_SLA_MS + backupTtft);
          const b = breaker.state;
          breaker.recordSuccess(ttft);
          attempts.push({ model, provider, status: 200, ttftMs: ttft, hedge: "lost" });
          note(provider, b, `TTFT ${Math.round(ttft)}ms > ${TTFT_SLA_MS}ms SLA`, attempts.length - 1);
          const bb = this.breakers[backupProvider].state;
          this.breakers[backupProvider].recordSuccess(backupTtft);
          attempts.push({ model: backup, provider: backupProvider, status: 200, ttftMs: backupTtft, hedge: "won" });
          note(
            backupProvider,
            bb,
            backupTtft > TTFT_SLA_MS ? `TTFT ${Math.round(backupTtft)}ms > ${TTFT_SLA_MS}ms SLA` : "hedge succeeded",
            attempts.length - 1,
          );
          failover = { from: provider, to: backupProvider, reason: "TTFT_SLA" };
          return this.complete(backup, item, prompt, key, clock, classification, compression.savedRatio, {
            attempts,
            breakerEvents,
            failover,
            routerMs,
            startedAt,
            promptTokens,
            plannedModel: plan[0],
          });
        }
      }

      await clock.sleep(ttft);
      const b = breaker.state;
      breaker.recordSuccess(ttft);
      attempts.push({ model, provider, status: 200, ttftMs: ttft });
      note(
        provider,
        b,
        ttft > TTFT_SLA_MS ? `TTFT ${Math.round(ttft)}ms > ${TTFT_SLA_MS}ms SLA` : "probe succeeded",
        attempts.length - 1,
      );
      return this.complete(model, item, prompt, key, clock, classification, compression.savedRatio, {
        attempts,
        breakerEvents,
        failover,
        routerMs,
        startedAt,
        promptTokens,
        plannedModel: plan[0],
      });
    }

    const last = attempts[attempts.length - 1];
    const route: RouteInfo = {
      tier: classification.tier,
      probability: classification.probability,
      model: "",
      provider: last?.provider ?? MODELS[plan[0]].provider,
      plannedModel: plan[0],
      plannedProvider: MODELS[plan[0]].provider,
      failover,
      attempts,
      compressionSaved: 0,
    };
    throw new UpstreamUnavailable(route, breakerEvents, routerMs, startedAt, clock.now());
  }

  private complete(
    model: string,
    item: WorkloadItem,
    prompt: string,
    key: string,
    clock: VirtualClock,
    classification: { tier: Tier; probability: number },
    savedRatio: number,
    ctx: {
      attempts: ProviderAttempt[];
      breakerEvents: BreakerEvent[];
      failover: RouteInfo["failover"];
      routerMs: number;
      startedAt: number;
      promptTokens: number;
      plannedModel: string;
    },
  ): UpstreamResult {
    const spec = MODELS[model];
    // The compressor's measured saving on the live message also applies to the attached context,
    // clamped to the 12–32% band LLMLingua-style pruning achieves on retrieval context.
    const contextSaving = Math.min(0.32, Math.max(0.12, savedRatio));
    const userTokens = estimateTokens(prompt);
    const sentTokens = Math.round(
      SYSTEM_PROMPT_TOKENS + item.contextTokens * (1 - contextSaving) + userTokens * (1 - savedRatio),
    );
    const response: CachedResponse = {
      text: this.writeResponse(prompt, model),
      model,
      completionTokens: item.completionTokens,
    };
    this.exact.set(key, response);
    this.semantic.insert(prompt, response);
    return {
      response,
      route: {
        tier: classification.tier,
        probability: classification.probability,
        model,
        provider: spec.provider,
        plannedModel: ctx.plannedModel,
        plannedProvider: MODELS[ctx.plannedModel].provider,
        failover: ctx.failover,
        attempts: ctx.attempts,
        compressionSaved: 1 - sentTokens / ctx.promptTokens,
      },
      breakerEvents: ctx.breakerEvents,
      routerMs: ctx.routerMs,
      startedAt: ctx.startedAt,
      completedAt: clock.now(),
      promptTokens: ctx.promptTokens,
      sentTokens,
      costUsd: costUsd(model, sentTokens, item.completionTokens),
    };
  }
}

export { PROVIDER_ORDER };
