/**
 * Choreography: turns engine traces (simulated milliseconds) into a watchable 3D timeline.
 * Stage compute takes microseconds, so travel between gates is paced for the eye; upstream waits
 * keep their real proportions (a 1.8 s frontier call visibly outlasts a 130 ms Groq call).
 */
import type { ProviderId, Tier } from "../types";
import type { BreakerState } from "../router/circuit-breaker";
import type { ParityReason } from "../cache/entity-guard";
import type { BreakerEvent, GatewayTrace } from "./engine";

export type Vec3 = [number, number, number];
export type Tone = "bone" | "malachite" | "glacier" | "amber" | "cinnabar";
export type GateId = "firewall" | "t1" | "t2" | "lock" | "router";

/* ── scene geometry (world units; x = pipeline direction, y = up, z = depth) ── */

export const SCENE = {
  laneY: 0.42,
  returnY: 1.66,
  laneSpread: 0.38,
  entryX: -8.25,
  workers: { x: -9.85, cols: 5, rows: 10, dx: 0.3, dz: 0.44 },
  gates: {
    firewall: { x: -6.6, width: 2.6, height: 2.2 },
    t1: { x: -4.1, size: 2.1 },
    t2: { x: -1.6, radius: 1.08 },
    lock: { x: 0.9, y: 1.15, radius: 0.86, orbit: 1.1 },
    router: { x: 3.45, y: 0.95, size: 0.52 },
  },
  shieldX: 6.15,
  providers: {
    groq: { x: 7.25, z: -3.1 },
    gemini: { x: 7.25, z: 0 },
    claude: { x: 7.25, z: 3.1 },
  } as Record<ProviderId, { x: number; z: number }>,
  monolith: { w: 0.62, d: 0.5, h: 2.7 },
} as const;

export function workerPosition(worker: number): Vec3 {
  const { x, cols, rows, dx, dz } = SCENE.workers;
  const col = worker % cols;
  const row = Math.floor(worker / cols) % rows;
  return [x + (col - (cols - 1) / 2) * dx, 0.02, (row - (rows - 1) / 2) * dz];
}

/* ── timeline types ──────────────────────────────────────────────────────── */

export type Segment =
  | { kind: "line"; t0: number; t1: number; from: Vec3; to: Vec3; tone: Tone; ease: "linear" | "inOut" | "out"; lift?: number }
  | { kind: "orbit"; t0: number; t1: number; center: Vec3; radius: number; phase: number; speed: number; tone: Tone }
  | { kind: "hold"; t0: number; t1: number; at: Vec3; tone: Tone };

export interface PacketPlan {
  key: string;
  traceId: number;
  segments: Segment[];
  start: number;
  end: number;
  /** Packet scale; leaders read slightly larger than followers. */
  size: number;
}

export type CounterKey =
  | "blocked"
  | "t1Hits"
  | "t2Hits"
  | "vetoes"
  | "coalesced"
  | "upstream"
  | "fast"
  | "frontier"
  | "failovers";

/** The stage that decided a request. Each request counts under at most one of these; a vetoed one is counted at the router. */
export const DECISION_COUNTERS: ReadonlySet<CounterKey> = new Set<CounterKey>(["blocked", "t1Hits", "t2Hits", "coalesced", "fast", "frontier"]);

export type SceneEvent =
  | { at: number; type: "spawn"; worker: number }
  /** A bone gate event on the return lane is a cache write; malachite is reserved for real T1/T2 hits. */
  | { at: number; type: "gate"; gate: GateId; tone: Tone }
  | { at: number; type: "veto"; similarity: number; threshold: number; reasons: ParityReason[]; prompt: string; matched: string | null }
  | { at: number; type: "block"; label: string }
  | { at: number; type: "spark"; pos: Vec3; tone: Tone; count: number }
  /** `late`: a 429 from a request issued before the breaker tripped that lands after it (a straggler). */
  | { at: number; type: "provider"; provider: ProviderId; tone: Tone; status: "busy" | "done" | "429" | "deflect"; late?: boolean }
  | { at: number; type: "breaker"; provider: ProviderId; to: BreakerState; reason: string }
  | { at: number; type: "counter"; key: CounterKey; traceId: number }
  | { at: number; type: "complete"; traceId: number; worker: number; tone: Tone };

export interface Choreography {
  plans: PacketPlan[];
  events: SceneEvent[];
  end: number;
}

/* ── pacing ──────────────────────────────────────────────────────────────── */

const SPEED = 6.6; // world units per second
const ARRIVAL_STRETCH = 3.4; // visual ms per simulated arrival ms
const DECIDE_MS = 150;
/** A breaker trip must show at least this long before the first packet bounces off its shield. */
const TRIP_LEAD_MS = 120;

const dist = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const travel = (a: Vec3, b: Vec3, factor = 1) => Math.max(90, (dist(a, b) / SPEED) * 1000 * factor);
const upstreamVisual = (ttft: number) => Math.min(2100, Math.max(460, ttft * 0.9));

export function tierTone(tier: Tier): Tone {
  return tier === "fast" ? "glacier" : "amber";
}

export function outcomeTone(trace: GatewayTrace): Tone {
  switch (trace.outcome) {
    case "BLOCKED":
    case "ERROR":
      return "cinnabar";
    case "T1_HIT":
    case "T2_HIT":
      return "malachite";
    case "COALESCED":
      return "glacier";
    case "UPSTREAM":
      return trace.route?.failover ? "amber" : tierTone(trace.route?.tier ?? "fast");
  }
}

/**
 * Tone of the stage that *decided* a request. Same as outcomeTone except an entity-guard veto is the
 * deciding event (cinnabar), even though the request then travelled upstream.
 */
export function decisionTone(trace: GatewayTrace): Tone {
  return trace.entityVeto && trace.outcome !== "T1_HIT" && trace.outcome !== "T2_HIT" ? "cinnabar" : outcomeTone(trace);
}

class Builder {
  segments: Segment[] = [];
  t: number;
  pos: Vec3;
  constructor(start: number, origin: Vec3) {
    this.t = start;
    this.pos = origin;
  }
  line(to: Vec3, tone: Tone, opts: { factor?: number; ease?: "linear" | "inOut" | "out"; lift?: number; ms?: number } = {}) {
    const d = opts.ms ?? travel(this.pos, to, opts.factor);
    this.segments.push({ kind: "line", t0: this.t, t1: this.t + d, from: this.pos, to, tone, ease: opts.ease ?? "linear", lift: opts.lift });
    this.t += d;
    this.pos = to;
    return this;
  }
  hold(ms: number, tone: Tone) {
    this.segments.push({ kind: "hold", t0: this.t, t1: this.t + ms, at: this.pos, tone });
    this.t += ms;
    return this;
  }
  orbit(until: number, tone: Tone, phase: number) {
    const { x, y, orbit } = SCENE.gates.lock;
    const center: Vec3 = [x, y, 0];
    const entry: Vec3 = [x, y + orbit * Math.sin(phase), orbit * Math.cos(phase)];
    this.line(entry, tone, { ms: 260, ease: "out" });
    const t1 = Math.max(until, this.t + 220);
    this.segments.push({ kind: "orbit", t0: this.t, t1, center, radius: orbit, phase, speed: 2.2, tone });
    const span = (t1 - this.t) / 1000;
    const angle = phase + span * 2.2;
    this.pos = [x, y + orbit * Math.sin(angle), orbit * Math.cos(angle)];
    this.t = t1;
    return this;
  }
}

type BreakerSceneEvent = Extract<SceneEvent, { type: "breaker" }>;
type ProviderSceneEvent = Extract<SceneEvent, { type: "provider" }>;
type SparkSceneEvent = Extract<SceneEvent, { type: "spark" }>;

/**
 * Packets are paced for the eye, so a breaker trip can land visually after a later request already bounced
 * off that provider's shield. For every provider that was CLOSED when the run began, pull its trip forward
 * so it shows TRIP_LEAD_MS before the first deflect, then mark 429s that land after the trip as stragglers.
 */
function enforceCausality(
  transitions: Array<{ ev: BreakerSceneEvent; source: BreakerEvent }>,
  deflects: Array<{ provider: ProviderId; ev: SceneEvent }>,
  rejections: Array<{ provider: ProviderId; ev: ProviderSceneEvent; spark: SparkSceneEvent; tripped: boolean }>,
): void {
  const byProvider = new Map<ProviderId, Array<{ ev: BreakerSceneEvent; source: BreakerEvent }>>();
  for (const t of transitions) {
    const list = byProvider.get(t.source.provider) ?? [];
    list.push(t);
    byProvider.set(t.source.provider, list);
  }
  for (const [provider, list] of byProvider) {
    list.sort((a, b) => a.source.at - b.source.at);
    const first = list[0];
    if (first.source.from !== "CLOSED" || first.source.to !== "OPEN") continue;
    const firstDeflect = deflects.reduce<number>((m, d) => (d.provider === provider ? Math.min(m, d.ev.at) : m), Infinity);
    if (first.ev.at > firstDeflect - TRIP_LEAD_MS) first.ev.at = firstDeflect - TRIP_LEAD_MS;
  }
  for (const r of rejections) {
    if (r.tripped) continue;
    const before = (byProvider.get(r.provider) ?? []).filter((t) => t.ev.at < r.ev.at);
    const latest = before.reduce<BreakerSceneEvent | null>((m, t) => (!m || t.ev.at > m.at ? t.ev : m), null);
    if (latest?.to !== "OPEN") continue;
    r.ev.late = true;
    r.spark.count = 8;
  }
}

/** Lay out one run. `start` is a performance.now() timestamp. */
export function choreograph(traces: GatewayTrace[], start: number): Choreography {
  const plans: PacketPlan[] = [];
  const events: SceneEvent[] = [];
  const { laneY, returnY, laneSpread, entryX, gates, providers, shieldX } = SCENE;
  const ordered = [...traces].sort((a, b) => a.arrivalMs - b.arrivalMs || a.id - b.id);
  const leaderReturnAtLock = new Map<number, number>();
  const followerQueue: GatewayTrace[] = [];
  const transitions: Array<{ ev: BreakerSceneEvent; source: BreakerEvent }> = [];
  const deflects: Array<{ provider: ProviderId; ev: SceneEvent }> = [];
  const rejections: Array<{ provider: ProviderId; ev: ProviderSceneEvent; spark: SparkSceneEvent; tripped: boolean }> = [];

  const laneZ = (trace: GatewayTrace) => ((trace.worker % 10) / 9 - 0.5) * 2 * laneSpread;
  const back = (b: Builder, trace: GatewayTrace, tone: Tone, fromX: number) => {
    const z = laneZ(trace);
    const xs = [gates.router.x, gates.lock.x, gates.t2.x, gates.t1.x, gates.firewall.x].filter((x) => x < fromX - 0.05);
    for (const x of xs) b.line([x, returnY, z], tone);
    b.line([entryX, returnY, z], tone);
    b.line(workerPosition(trace.worker), tone, { ease: "inOut", factor: 1.15 });
    events.push({ at: b.t, type: "complete", traceId: trace.id, worker: trace.worker, tone });
  };
  const rise = (b: Builder, tone: Tone) => b.line([b.pos[0] - 0.12, returnY, b.pos[2]], tone, { ease: "inOut", ms: 300 });

  const planFor = (trace: GatewayTrace, b: Builder, size = 1) => {
    plans.push({ key: `${trace.runId}:${trace.id}`, traceId: trace.id, segments: b.segments, start: b.segments[0]?.t0 ?? b.t, end: b.t, size });
  };

  const approach = (trace: GatewayTrace, spawn: number) => {
    const z = laneZ(trace);
    const b = new Builder(spawn, workerPosition(trace.worker));
    events.push({ at: spawn, type: "spawn", worker: trace.worker });
    b.line([entryX, laneY, z], "bone", { ease: "out", factor: 1.2 });
    b.line([gates.firewall.x, laneY, z], "bone");
    return b;
  };

  for (const trace of ordered) {
    const spawn = start + trace.arrivalMs * ARRIVAL_STRETCH;
    const z = laneZ(trace);
    const tone = outcomeTone(trace);

    if (trace.outcome === "BLOCKED") {
      const b = approach(trace, spawn);
      events.push({ at: b.t, type: "gate", gate: "firewall", tone: "cinnabar" });
      events.push({ at: b.t, type: "block", label: trace.firewall.hits[0] ?? "Policy violation" });
      events.push({ at: b.t, type: "spark", pos: [gates.firewall.x - 0.08, laneY, z], tone: "cinnabar", count: 22 });
      events.push({ at: b.t, type: "counter", key: "blocked", traceId: trace.id });
      b.hold(DECIDE_MS, "cinnabar");
      rise(b, "cinnabar");
      back(b, trace, "cinnabar", gates.firewall.x);
      planFor(trace, b, 0.85);
      continue;
    }

    if (trace.outcome === "COALESCED" || trace.coalesced) {
      followerQueue.push(trace);
      continue;
    }

    const b = approach(trace, spawn);
    events.push({ at: b.t, type: "gate", gate: "firewall", tone: "bone" });
    b.line([gates.t1.x, laneY, z], "bone");

    if (trace.outcome === "T1_HIT") {
      events.push({ at: b.t, type: "gate", gate: "t1", tone: "malachite" });
      events.push({ at: b.t, type: "counter", key: "t1Hits", traceId: trace.id });
      b.hold(DECIDE_MS * 0.6, "malachite");
      rise(b, "malachite");
      back(b, trace, "malachite", gates.t1.x);
      planFor(trace, b);
      continue;
    }

    b.line([gates.t2.x, laneY, z], "bone");
    if (trace.outcome === "T2_HIT") {
      events.push({ at: b.t, type: "gate", gate: "t2", tone: "malachite" });
      events.push({ at: b.t, type: "counter", key: "t2Hits", traceId: trace.id });
      b.hold(DECIDE_MS, "malachite");
      rise(b, "malachite");
      back(b, trace, "malachite", gates.t2.x);
      planFor(trace, b);
      continue;
    }

    if (trace.entityVeto) {
      events.push({
        at: b.t,
        type: "veto",
        similarity: trace.semantic?.similarity ?? 0,
        threshold: trace.semantic?.threshold ?? 0.94,
        reasons: trace.semantic?.parityReasons ?? [],
        prompt: trace.prompt,
        matched: trace.semantic?.matchedPrompt ?? null,
      });
      events.push({ at: b.t, type: "counter", key: "vetoes", traceId: trace.id });
      b.hold(DECIDE_MS * 1.6, "bone");
    } else {
      b.hold(DECIDE_MS * 0.4, "bone");
    }

    // leader (UPSTREAM or ERROR) continues through the lock and router
    b.line([gates.lock.x, laneY, z], "bone");
    events.push({ at: b.t, type: "gate", gate: "lock", tone: trace.followers > 0 ? "glacier" : "bone" });
    const route = trace.route;
    const routeTone = route ? tierTone(route.tier) : "cinnabar";
    b.line([gates.router.x, gates.router.y, 0], "bone", { ease: "inOut", factor: 1.05 });
    events.push({ at: b.t, type: "gate", gate: "router", tone: routeTone });
    events.push({ at: b.t, type: "counter", key: "upstream", traceId: trace.id });
    if (route) events.push({ at: b.t, type: "counter", key: route.tier === "fast" ? "fast" : "frontier", traceId: trace.id });
    b.hold(DECIDE_MS * 0.5, routeTone);

    const attempts = route?.attempts ?? [];
    let tonesSoFar: Tone = routeTone;
    let failed = false;
    // An attempt can carry two transitions (OPEN → HALF_OPEN when the probe is sent, then its result), so
    // the probe shows while the packet travels and the result lands with the packet.
    const breakersAt = (index: number, probing: boolean) => {
      for (const e of trace.breakerEvents) {
        if (e.attemptIndex !== index || (e.to === "HALF_OPEN") !== probing) continue;
        const ev: BreakerSceneEvent = { at: b.t, type: "breaker", provider: e.provider, to: e.to, reason: e.reason };
        events.push(ev);
        transitions.push({ ev, source: e });
      }
    };
    attempts.forEach((attempt, index) => {
      const p = providers[attempt.provider];
      const contact: Vec3 = [p.x - SCENE.monolith.w / 2 - 0.12, 1.0, p.z];
      breakersAt(index, true);
      if (attempt.status === "OPEN") {
        const shield: Vec3 = [shieldX, 1.0, p.z * 0.92];
        b.line(shield, tonesSoFar, { ease: "inOut", lift: 0.25 });
        const ev: SceneEvent = { at: b.t, type: "provider", provider: attempt.provider, tone: "cinnabar", status: "deflect" };
        events.push(ev);
        deflects.push({ provider: attempt.provider, ev });
        events.push({ at: b.t, type: "spark", pos: shield, tone: "cinnabar", count: 14 });
        if (!failed) events.push({ at: b.t, type: "counter", key: "failovers", traceId: trace.id });
        breakersAt(index, false);
        tonesSoFar = "amber";
        failed = true;
        return;
      }
      b.line(contact, tonesSoFar, { ease: "inOut", lift: index > 0 || failed ? 0.9 : 0.2, factor: index > 0 ? 1.15 : 1 });
      events.push({ at: b.t, type: "provider", provider: attempt.provider, tone: tonesSoFar, status: "busy" });
      if (attempt.status === 429) {
        // a 429 comes back in tens of ms, so the breaker reacts on contact; the hold only paces the sparks
        breakersAt(index, false);
        b.hold(380, tonesSoFar);
        const ev: ProviderSceneEvent = { at: b.t, type: "provider", provider: attempt.provider, tone: "cinnabar", status: "429" };
        const spark: SparkSceneEvent = { at: b.t, type: "spark", pos: contact, tone: "cinnabar", count: 18 };
        events.push(ev, spark);
        rejections.push({
          provider: attempt.provider,
          ev,
          spark,
          tripped: trace.breakerEvents.some((e) => e.attemptIndex === index && e.to === "OPEN"),
        });
        if (!failed) events.push({ at: b.t, type: "counter", key: "failovers", traceId: trace.id });
        tonesSoFar = "amber";
        failed = true;
        return;
      }
      if (attempt.hedge === "lost") {
        b.hold(Math.min(1500 * 0.75, upstreamVisual(attempt.ttftMs)), tonesSoFar);
        events.push({ at: b.t, type: "provider", provider: attempt.provider, tone: "amber", status: "deflect" });
        breakersAt(index, false);
        tonesSoFar = "amber";
        failed = true;
        return;
      }
      // SLA breaches and probe results are only known once the first token arrives
      b.hold(upstreamVisual(attempt.ttftMs), tonesSoFar);
      breakersAt(index, false);
      events.push({ at: b.t, type: "provider", provider: attempt.provider, tone: tonesSoFar, status: "done" });
    });

    // response heads home along the upper lane; the lock releases followers as it passes
    const finalTone = trace.outcome === "ERROR" ? "cinnabar" : tone;
    if (route && trace.outcome === "UPSTREAM") {
      const p = providers[route.provider];
      b.line([p.x - SCENE.monolith.w / 2 - 0.12, returnY, p.z], finalTone, { ms: 240, ease: "out" });
    } else {
      rise(b, finalTone);
    }
    b.line([gates.router.x, returnY, z], finalTone, { ease: "inOut" });
    b.line([gates.lock.x, returnY, z], finalTone);
    leaderReturnAtLock.set(trace.id, b.t);
    events.push({ at: b.t, type: "gate", gate: "lock", tone: trace.followers > 0 ? "glacier" : "bone" });
    // an upstream answer is written into both cache tiers on its way back: a bone write mark, never a malachite hit
    const writes = trace.outcome === "UPSTREAM";
    b.line([gates.t2.x, returnY, z], finalTone);
    if (writes) events.push({ at: b.t, type: "gate", gate: "t2", tone: "bone" });
    b.line([gates.t1.x, returnY, z], finalTone);
    if (writes) events.push({ at: b.t, type: "gate", gate: "t1", tone: "bone" });
    back(b, trace, finalTone, gates.t1.x);
    planFor(trace, b, 1.15);
  }

  // followers: arrive, orbit the lock until their leader's response (or its 503) passes back through it
  followerQueue.forEach((trace, index) => {
    const spawn = start + trace.arrivalMs * ARRIVAL_STRETCH;
    const z = laneZ(trace);
    const b = approach(trace, spawn);
    b.line([gates.t1.x, laneY, z], "bone");
    b.line([gates.t2.x, laneY, z], "bone");
    b.hold(DECIDE_MS * 0.4, "bone");
    b.line([gates.lock.x - 0.1, laneY, z], "bone");
    if (trace.outcome === "COALESCED") events.push({ at: b.t, type: "counter", key: "coalesced", traceId: trace.id });
    events.push({ at: b.t, type: "gate", gate: "lock", tone: "glacier" });
    const leaderId = trace.coalesced?.leaderId ?? -1;
    const release = leaderReturnAtLock.get(leaderId) ?? b.t + 900;
    const phase = (index * 2.39996) % (Math.PI * 2);
    b.orbit(release, "glacier", phase);
    const home = outcomeTone(trace);
    b.line([gates.lock.x - 0.15, returnY, z], home, { ms: 280, ease: "out" });
    back(b, trace, home, gates.lock.x);
    planFor(trace, b, 0.82);
  });

  enforceCausality(transitions, deflects, rejections);
  events.sort((a, b) => a.at - b.at);
  const end = plans.reduce((m, p) => Math.max(m, p.end), start);
  return { plans, events, end };
}

/* ── evaluation (used by the renderer every frame) ───────────────────────── */

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function segmentAt(plan: PacketPlan, t: number): Segment | null {
  if (t < plan.start || t > plan.end) return null;
  for (const s of plan.segments) if (t >= s.t0 && t <= s.t1) return s;
  return plan.segments[plan.segments.length - 1] ?? null;
}

export function positionAt(plan: PacketPlan, t: number, out: Vec3 = [0, 0, 0]): Vec3 | null {
  const s = segmentAt(plan, t);
  if (!s) return null;
  if (s.kind === "hold") {
    out[0] = s.at[0];
    out[1] = s.at[1];
    out[2] = s.at[2];
    return out;
  }
  if (s.kind === "orbit") {
    const a = s.phase + ((t - s.t0) / 1000) * s.speed;
    out[0] = s.center[0];
    out[1] = s.center[1] + s.radius * Math.sin(a);
    out[2] = s.center[2] + s.radius * Math.cos(a);
    return out;
  }
  const raw = s.t1 === s.t0 ? 1 : (t - s.t0) / (s.t1 - s.t0);
  const k = s.ease === "inOut" ? easeInOut(raw) : s.ease === "out" ? easeOut(raw) : raw;
  out[0] = s.from[0] + (s.to[0] - s.from[0]) * k;
  out[1] = s.from[1] + (s.to[1] - s.from[1]) * k + (s.lift ? Math.sin(Math.PI * raw) * s.lift : 0);
  out[2] = s.from[2] + (s.to[2] - s.from[2]) * k;
  return out;
}

export function toneAt(plan: PacketPlan, t: number): Tone {
  return segmentAt(plan, t)?.tone ?? "bone";
}
