"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { getController, useGateway } from "@/lib/gateway/use-gateway";
import { BREAKER_COOLDOWN_MS, isBurstActive, type BurstSummary } from "@/lib/gateway/controller";
import type { GatewayTrace } from "@/lib/gateway/engine";
import { decisionTone, type Tone } from "@/lib/gateway/choreography";
import { PROVIDER_ORDER, PROVIDERS, TTFT_SLA_MS } from "@/lib/gateway/providers";
import type { BreakerState } from "@/lib/router/circuit-breaker";
import type { ProviderId } from "@/lib/types";
import { percentile } from "@/lib/utils/prng";
import { cn, fmtInt, fmtMs, fmtMsValue, fmtUs, fmtUsd, plural, truncate } from "@/lib/format";
import { Chip, Glyph, Label, Micro, Reveal, SectionHeader } from "./ui";

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Wall clock that only ticks while `enabled`, so idle panels don't re-render. */
function useNow(interval: number, enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval, enabled]);
  return now;
}

/** SVG user units per CSS px, floored at 1 so viewBox text never renders below its nominal size. */
function useUnitScale<T extends Element>(viewWidth: number) {
  const ref = useRef<T>(null);
  const [k, setK] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setK(Math.max(1, viewWidth / w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewWidth]);
  return { ref, k };
}

const NNBSP = " ";
const COOLDOWN_S = BREAKER_COOLDOWN_MS / 1000;
/** Whole seconds until an OPEN breaker probes again, clamped so a stale clock can't paint an impossible value. */
const secondsLeft = (now: number, since: number) => Math.min(COOLDOWN_S, Math.max(0, Math.ceil((BREAKER_COOLDOWN_MS - (now - since)) / 1000)));

export function pathLabel(t: GatewayTrace): { text: string; tone: Tone; note?: string } {
  const tone = decisionTone(t);
  const r = t.route;
  if (tone === "cinnabar" && t.entityVeto && t.outcome !== "BLOCKED" && t.outcome !== "ERROR") {
    if (r?.failover) return { text: `Vetoed · failover → ${PROVIDERS[r.provider].name}`, tone };
    const to = t.outcome === "COALESCED" ? "coalesced" : r?.tier === "frontier" ? "frontier" : "fast tier";
    return { text: `Vetoed → ${to}`, tone };
  }
  switch (t.outcome) {
    case "BLOCKED":
      return { text: "Blocked", tone };
    case "T1_HIT":
      return { text: "Exact hit · T1", tone };
    case "T2_HIT":
      return { text: "Semantic hit · T2", tone };
    case "COALESCED":
      return { text: "Coalesced", tone, note: t.coalesced?.kind === "semantic" ? "semantic" : undefined };
    case "ERROR":
      return { text: "503 · no provider", tone };
    case "UPSTREAM":
      if (r?.failover) return { text: `Failover → ${PROVIDERS[r.provider].name}`, tone };
      return { text: r?.tier === "frontier" ? "Frontier" : "Fast tier", tone };
  }
}

const COMPOSITION: Array<{ n: number; what: string; path: string; tone: Tone }> = [
  { n: 22, what: "Identical cold requests", path: "1 upstream call", tone: "glacier" },
  { n: 10, what: "Paraphrases, 4 phrasings", path: "Coalesced", tone: "glacier" },
  { n: 6, what: "Exact repeats", path: "Exact hit · T1", tone: "malachite" },
  { n: 5, what: "Reworded repeats", path: "Semantic hit · T2", tone: "malachite" },
  { n: 3, what: "Entity traps", path: "Vetoed → upstream", tone: "cinnabar" },
  { n: 2, what: "Prompt injections", path: "Blocked pre-flight", tone: "cinnabar" },
  { n: 2, what: "Frontier reasoning tasks", path: "Gemini 2.5 Pro", tone: "amber" },
];

/* ── worker grid ─────────────────────────────────────────────────────────── */

const TONE_ORDER: Tone[] = ["malachite", "glacier", "amber", "cinnabar", "bone"];
const TONE_MEANING: Record<Tone, string> = {
  malachite: "served from cache",
  glacier: "fast tier or coalesced",
  amber: "frontier or rerouted",
  cinnabar: "blocked or vetoed",
  bone: "other",
};
const TONE_SHORT: Record<Tone, string> = {
  malachite: "cache",
  glacier: "fast · coalesced",
  amber: "frontier · rerouted",
  cinnabar: "blocked · vetoed",
  bone: "other",
};

function WorkerGrid({ traces, inFlight }: { traces: GatewayTrace[]; inFlight: boolean }) {
  const byWorker = useMemo(() => {
    const m = new Map<number, GatewayTrace>();
    for (const t of traces) m.set(t.worker, t);
    return m;
  }, [traces]);

  const { summary, tally } = useMemo(() => {
    const counts = new Map<Tone, number>();
    for (const t of traces) {
      const tone = decisionTone(t);
      counts.set(tone, (counts.get(tone) ?? 0) + 1);
    }
    const present = TONE_ORDER.filter((tone) => counts.get(tone));
    const parts = present.map((tone) => `${counts.get(tone)} ${TONE_MEANING[tone]}`);
    const pending = 50 - traces.length;
    if (pending) parts.push(`${pending} ${inFlight ? "in flight" : "idle"}`);
    return { summary: `50 agent workers: ${parts.join(", ")}`, tally: present.map((tone) => ({ tone, n: counts.get(tone) ?? 0 })) };
  }, [traces, inFlight]);

  return (
    <div className="min-w-[200px] flex-1 basis-full lg:max-w-[300px] lg:basis-auto">
      <div role="img" aria-label={summary} className="grid grid-cols-10 gap-[3px] md:grid-cols-[repeat(25,minmax(0,1fr))] lg:grid-cols-10">
        {Array.from({ length: 50 }, (_, i) => {
          const t = byWorker.get(i);
          const tone = t ? decisionTone(t) : null;
          return (
            <span
              key={i}
              title={t ? `worker ${i} · ${pathLabel(t).text} · ${fmtMs(t.latencyMs)}` : `worker ${i}`}
              className={cn(
                "flex aspect-square items-center justify-center rounded-[2px] border border-line-2 bg-[rgb(236_233_225/0.03)] transition-[background-color,border-color] duration-300",
                !t && inFlight && "border-[rgb(236_233_225/0.34)]",
              )}
              style={
                tone && (inFlight || tone === "cinnabar" || tone === "amber")
                  ? { background: `color-mix(in oklab, var(--color-${tone}-chart) 14%, transparent)` }
                  : undefined
              }
            >
              {tone ? <Glyph tone={tone} size={7} /> : null}
            </span>
          );
        })}
      </div>
      {tally.length ? (
        <p aria-hidden className="t-data mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-ink-3">
          {tally.map(({ tone, n }) => (
            <span key={tone} className="flex items-center gap-1.5 whitespace-nowrap">
              <Glyph tone={tone} size={7} />
              <span className="text-ink-2">{n}</span> {TONE_SHORT[tone]}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/* ── kill switch under a hinged safety cover ─────────────────────────────── */

const COVER_OPEN = { type: "spring", stiffness: 700, damping: 42 } as const;
const COVER_CLOSE = { duration: 0.16, ease: [0.55, 0, 1, 0.45] } as const;
/** Presses this soon after the key goes live are ignored, so a double-click on Arm can't land on Kill. */
const KEY_GUARD_MS = 250;

function KillSwitch({ burstActive }: { burstActive: boolean }) {
  const killed = useGateway((s) => s.primaryKilled);
  const [armed, setArmed] = useState(false);
  const open = armed || killed;
  // Where the lid last came to rest; it only changes when a framer-motion animation completes.
  const [rest, setRest] = useState<"open" | "shut" | "moving">(() => (open ? "open" : "shut"));
  const [restFor, setRestFor] = useState(open);
  if (restFor !== open) {
    setRestFor(open);
    setRest("moving");
  }
  const reduce = useReducedMotion();
  const keyRef = useRef<HTMLButtonElement>(null);
  const coverRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"key" | "cover" | null>(null);
  const liveAt = useRef(0);
  const keyId = useId();
  const live = open && (reduce || rest === "open");
  const lidShut = !open && (reduce || rest === "shut");

  // The cover falls shut on its own; focus must not stay on a key that is about to go inert.
  useEffect(() => {
    if (!armed || killed) return;
    const id = setTimeout(() => {
      if (document.activeElement === keyRef.current) coverRef.current?.focus();
      setArmed(false);
    }, 6000);
    return () => clearTimeout(id);
  }, [armed, killed]);

  // Focus moves only after the DOM has dropped disabled/inert from the target.
  useEffect(() => {
    if (live) liveAt.current = performance.now();
    if (focusAfter.current === "key" && live) {
      focusAfter.current = null;
      keyRef.current?.focus();
    } else if (focusAfter.current === "cover" && !open) {
      focusAfter.current = null;
      coverRef.current?.focus();
    }
  }, [live, open]);

  const press = () => {
    if (!live) return;
    const c = getController();
    if (killed) {
      focusAfter.current = "cover";
      c.setPrimaryKilled(false);
      setArmed(false);
    } else if (performance.now() - liveAt.current >= KEY_GUARD_MS) {
      c.setPrimaryKilled(true);
    }
  };

  const lift = () => {
    if (killed) return;
    focusAfter.current = armed ? null : "key";
    setArmed(!armed);
  };

  return (
    <div className="flex items-center gap-5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-ink-2 [text-wrap:pretty]">
          {killed ? (
            <>
              Every Groq call now returns <span className="whitespace-nowrap">HTTP 429</span>. Three in a row trip the breaker and traffic
              fails over to Gemini.
            </>
          ) : (
            <>
              Lift the cover, then kill Groq: every call returns <span className="whitespace-nowrap">HTTP 429</span>, and the third in a row
              trips the breaker and fails traffic over to Gemini.
            </>
          )}
        </p>
        {killed && burstActive ? (
          <p className="mt-1.5 text-[12.5px] leading-snug text-ink-3 [text-wrap:pretty]">Applies from the next request; this burst was already routed.</p>
        ) : null}
      </div>

      <div className="relative h-[64px] w-[132px] shrink-0" style={{ perspective: 380, perspectiveOrigin: "50% 160%" }}>
        <span aria-hidden className="absolute inset-0 rounded-[9px] border border-line bg-[rgb(0_0_0/0.35)] shadow-[inset_0_1px_3px_rgb(0_0_0/0.6)]" />
        <button
          ref={keyRef}
          id={keyId}
          type="button"
          onClick={press}
          onKeyDown={(e) => {
            if (e.repeat && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              return;
            }
            if (e.key === "Escape" && armed && !killed) {
              e.preventDefault();
              focusAfter.current = "cover";
              setArmed(false);
            }
          }}
          disabled={!live}
          inert={!live}
          aria-hidden={!live}
          aria-label={killed ? "Restore Groq" : "Kill Groq (HTTP 429)"}
          className={cn(
            "absolute inset-[6px] flex flex-col items-center justify-center gap-0.5 rounded-[6px] border transition-[transform,background-color,border-color,color] duration-150 active:scale-[0.97]",
            lidShut
              ? "border-line bg-bg-2 text-ink-3"
              : killed
                ? "border-line-2 bg-bg-2 text-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_1px_0_rgb(0_0_0/0.6)]"
                : "border-[rgb(241_97_89/0.55)] bg-bg-3 text-ink-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_1px_0_rgb(0_0_0/0.6)]",
          )}
        >
          <span className={cn("whitespace-nowrap text-[12.5px] font-[600] tracking-[0.01em]", lidShut && "invisible")}>
            {killed ? "Restore Groq" : "Kill Groq"}
          </span>
          <span className={cn("t-data flex items-center gap-1 whitespace-nowrap text-[10.5px] text-ink-3", lidShut && "invisible")}>
            {killed ? (
              <>
                <Glyph tone="cinnabar" size={6} />
                429 live
              </>
            ) : (
              "HTTP 429"
            )}
          </span>
        </button>
        <motion.button
          ref={coverRef}
          type="button"
          aria-label={armed ? "Close the safety cover" : "Lift the safety cover to arm the kill switch"}
          aria-expanded={open}
          aria-controls={keyId}
          disabled={killed}
          aria-hidden={killed || undefined}
          onClick={lift}
          initial={false}
          animate={{ rotateX: open ? 108 : 0 }}
          transition={reduce ? { duration: 0 } : open ? COVER_OPEN : COVER_CLOSE}
          onAnimationComplete={(def) => setRest((def as { rotateX?: number }).rotateX ? "open" : "shut")}
          className="absolute inset-0 origin-top rounded-[9px] [transform-style:preserve-3d]"
        >
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center rounded-[9px] border border-line-3 [backface-visibility:hidden]"
            style={{
              background: "repeating-linear-gradient(135deg, rgb(236 233 225 / 0.05) 0 1px, transparent 1px 7px), var(--color-bg-2)",
              boxShadow: "inset 0 2px 0 rgb(241 97 89 / 0.7), 0 10px 22px -12px rgb(0 0 0 / 0.9)",
            }}
          >
            <span className="t-micro text-ink-2">Arm</span>
            <span className="absolute bottom-[6px] left-1/2 h-[2px] w-6 -translate-x-1/2 rounded-full bg-[rgb(236_233_225/0.18)]" />
          </span>
          {/* underside, seen once the lid swings past vertical */}
          <span
            aria-hidden
            className="absolute inset-0 rounded-[9px] border border-line-2 bg-[#0a0b0d] [backface-visibility:hidden] [transform:rotateX(180deg)]"
            style={{ boxShadow: "inset 0 -2px 0 rgb(236 233 225 / 0.08)" }}
          />
        </motion.button>
      </div>
    </div>
  );
}

/* ── breaker state machine ───────────────────────────────────────────────── */

const BREAKER_NODES: Array<{ id: BreakerState; x: number; name: string; tone: Tone }> = [
  { id: "CLOSED", x: 48, name: "CLOSED", tone: "malachite" },
  { id: "OPEN", x: 180, name: "OPEN", tone: "cinnabar" },
  { id: "HALF_OPEN", x: 312, name: "HALF-OPEN", tone: "amber" },
];

function StateMark({ tone, x, y, fill }: { tone: Tone; x: number; y: number; fill: string }) {
  if (tone === "cinnabar") return <rect x={x - 4.2} y={y - 4.2} width={8.4} height={8.4} rx={1} fill={fill} />;
  if (tone === "amber") return <path d={`M${x} ${y - 5.4}L${x + 5.2} ${y + 3.6}H${x - 5.2}Z`} fill={fill} />;
  return <circle cx={x} cy={y} r={4.6} fill={fill} />;
}

function BreakerDiagram({ state, since }: { state: BreakerState; since: number }) {
  const now = useNow(250, state === "OPEN");
  const { ref, k } = useUnitScale<HTMLDivElement>(360);
  const marker = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const elapsed = now - since;
  const progress = state === "OPEN" ? Math.min(1, Math.max(0, elapsed / BREAKER_COOLDOWN_MS)) : 0;
  const left = secondsLeft(now, since);
  const R = 22;
  const cy = 52;
  const font = { fontSize: 10.5 * k };
  const label = state === "HALF_OPEN" ? "half-open" : state.toLowerCase();

  return (
    <div ref={ref} className="mx-auto mt-3 w-full max-w-[400px]">
      <svg
        viewBox="0 -12 360 138"
        className="block w-full"
        role="img"
        aria-label={`Groq circuit breaker is ${label}${state === "OPEN" ? `; it probes again in ${left} seconds` : ""}`}
      >
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 8 4 0 8Z" fill="rgb(236 233 225 / 0.4)" />
          </marker>
        </defs>
        <g fill="none" strokeWidth="1">
          {state === "OPEN" ? (
            <path d="M212 52H284" stroke="var(--color-ink-2)" strokeWidth={1.5} strokeDasharray={`${72 * progress} 72`} />
          ) : null}
          <path d="M74 52H148" stroke="rgb(236 233 225 / 0.28)" markerEnd={`url(#${marker})`} />
          <path d="M212 52H284" stroke="rgb(236 233 225 / 0.28)" markerEnd={`url(#${marker})`} />
          <path d="M294 34C270 2 228 2 204 30" stroke="rgb(236 233 225 / 0.2)" markerEnd={`url(#${marker})`} />
          <path d="M290 66C250 122 110 122 70 66" stroke="rgb(236 233 225 / 0.2)" markerEnd={`url(#${marker})`} />
        </g>
        <g className="fill-[var(--color-ink-3)] font-mono" textAnchor="middle" style={font}>
          <text x="111" y="43">3 failures</text>
          <text x="248" y="43" className={state === "OPEN" ? "fill-[var(--color-ink-1)]" : undefined}>
            {state === "OPEN" ? left : COOLDOWN_S}
            {NNBSP}s
          </text>
          <text x="249" y="-2">probe fails</text>
          <text x="180" y="122">probe succeeds</text>
        </g>
        {BREAKER_NODES.map((n) => {
          const active = n.id === state;
          return (
            <g key={n.id}>
              <circle cx={n.x} cy={cy} r={R} fill="none" stroke={active ? "var(--color-ink-1)" : "var(--color-line-3)"} strokeWidth={active ? 1.4 : 1} />
              <StateMark tone={n.tone} x={n.x} y={cy} fill={active ? `var(--color-${n.tone})` : "var(--color-ink-4)"} />
              <text
                x={n.x}
                y={92}
                textAnchor="middle"
                style={font}
                className={cn("font-mono", active ? "fill-[var(--color-ink-1)]" : "fill-[var(--color-ink-3)]")}
              >
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── provider health strips ──────────────────────────────────────────────── */

type Sample = "ok" | "slow" | "429";

const SAMPLE_STYLE: Record<Sample, { height: number; background: string }> = {
  ok: { height: 12, background: "rgb(236 233 225 / 0.42)" },
  slow: { height: 16, background: "var(--color-amber-chart)" },
  "429": { height: 20, background: "var(--color-cinnabar-chart)" },
};

const PROVIDER_ROLE: Record<ProviderId, string> = {
  groq: "Fast primary",
  gemini: "Frontier · Groq backup",
  claude: "Frontier backup",
};

/* Two rows (strip below the name) wherever the column is too narrow for 20 samples. */
const PROVIDER_ROW =
  "grid grid-flow-row-dense grid-cols-[minmax(0,1fr)_108px] items-center gap-x-3 gap-y-2.5 py-3 sm:grid-cols-[120px_minmax(0,1fr)_108px] lg:grid-cols-[minmax(0,1fr)_108px] xl:grid-cols-[120px_minmax(0,1fr)_108px]";

function ProviderRows() {
  const breakers = useGateway((s) => s.breakers);
  const feed = useGateway((s) => s.feed);
  const anyOpen = PROVIDER_ORDER.some((id) => breakers[id].state === "OPEN");
  const now = useNow(500, anyOpen);
  const recent = useMemo(() => {
    const out: Record<ProviderId, Sample[]> = { groq: [], gemini: [], claude: [] };
    for (const t of [...feed].reverse()) {
      for (const a of t.route?.attempts ?? []) {
        if (a.status === "OPEN") continue;
        const slow = a.hedge === "lost" || a.ttftMs > TTFT_SLA_MS;
        out[a.provider].push(a.status === 429 ? "429" : slow ? "slow" : "ok");
      }
    }
    for (const id of PROVIDER_ORDER) out[id] = out[id].slice(-20);
    return out;
  }, [feed]);

  return (
    <div>
      {/* The key sits over the strip column, clear of the count and chip columns. */}
      <div className={cn(PROVIDER_ROW, "py-0 pb-1 pt-3")} title={`slow: time to first token above ${fmtMs(TTFT_SLA_MS)}`}>
        <span aria-hidden className="hidden sm:block lg:hidden xl:block" />
        <div className="col-span-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 pr-[80px] sm:col-span-1 lg:col-span-2 xl:col-span-1">
          <Micro className="whitespace-nowrap">Last 20 calls</Micro>
          {(["ok", "slow", "429"] as Sample[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="h-[9px] w-[4px] rounded-[1px]" style={{ background: SAMPLE_STYLE[s].background }} />
              <Micro>{s}</Micro>
            </span>
          ))}
        </div>
        <span aria-hidden className="hidden sm:block lg:hidden xl:block" />
      </div>
      <div className="divide-y divide-line">
        {PROVIDER_ORDER.map((id) => {
          const b = breakers[id];
          const tone: Tone = b.state === "OPEN" ? "cinnabar" : b.state === "HALF_OPEN" ? "amber" : "malachite";
          const left = secondsLeft(now, b.since);
          const samples = recent[id];
          const fails = samples.filter((s) => s === "429").length;
          const slow = samples.filter((s) => s === "slow").length;
          const count = fails ? `${fails}${NNBSP}×${NNBSP}429` : slow ? `${slow}${NNBSP}slow` : "";
          return (
            <div key={id} className={PROVIDER_ROW}>
              <div className="min-w-0">
                <p className="text-[13px] text-ink-1">{PROVIDERS[id].name}</p>
                <p className="whitespace-nowrap text-[12px] text-ink-3">{PROVIDER_ROLE[id]}</p>
              </div>
              <div
                role="img"
                aria-label={`${PROVIDERS[id].name}, last ${samples.length} calls: ${fails} rate-limited (HTTP 429), ${slow} slower than ${fmtMs(TTFT_SLA_MS)}`}
                className="col-span-2 flex min-w-0 items-end gap-3 sm:col-span-1 lg:col-span-2 xl:col-span-1"
              >
                <div className="flex h-5 min-w-0 flex-1 items-end justify-end gap-[2px] overflow-hidden">
                  {Array.from({ length: 20 }, (_, i) => {
                    const s = samples[i - (20 - samples.length)];
                    return (
                      <span
                        key={i}
                        className="w-[4px] shrink-0 rounded-[1px] sm:w-[5px]"
                        style={s ? SAMPLE_STYLE[s] : { height: 4, background: "rgb(236 233 225 / 0.08)" }}
                      />
                    );
                  })}
                </div>
                <span className="t-data w-[68px] shrink-0 whitespace-nowrap text-right text-[11px] leading-none text-ink-2">{count}</span>
              </div>
              <Chip tone={tone} className="justify-self-end">
                {b.state === "OPEN" ? (
                  <>
                    Open · {left}
                    {NNBSP}
                    <span className="tok">s</span>
                  </>
                ) : b.state === "HALF_OPEN" ? (
                  "Half-open"
                ) : (
                  "Closed"
                )}
              </Chip>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── latency histogram ───────────────────────────────────────────────────── */

const BINS = [
  { lo: 0, hi: 10 },
  { lo: 10, hi: 25 },
  { lo: 25, hi: 50 },
  { lo: 50, hi: 100 },
  { lo: 100, hi: 250 },
  { lo: 250, hi: 500 },
  { lo: 500, hi: 1000 },
  { lo: 1000, hi: 2000 },
  { lo: 2000, hi: Infinity },
];

const fmtEdge = (v: number) => (v >= 1000 ? `${v / 1000}k` : `${v}`);
const binName = (b: (typeof BINS)[number]) => (Number.isFinite(b.hi) ? `${fmtEdge(b.lo)} to ${fmtEdge(b.hi)} ms` : `${fmtEdge(b.lo)} ms and over`);

/** Smallest step from {1, 2, 5} × 10^k near `raw`. */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

/** Horizontal position (0..1) of a latency on the bin axis, log-interpolated inside its bin. */
function binPosition(ms: number): number {
  const i = Math.max(0, BINS.findIndex((b) => ms < b.hi));
  const b = BINS[i];
  const lo = Math.max(b.lo, 1);
  const hi = Number.isFinite(b.hi) ? b.hi : b.lo * 2.5;
  const f = (Math.log(Math.max(ms, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return (i + Math.min(1, Math.max(0, f))) / BINS.length;
}

const BAND = 30; // p95 labels, above the plot
const PLOT = 140;
const AXIS = 22;
/** Bone-chart at 50%, mixed opaque so a rule drawn behind a bar is hidden by it. */
const DIRECT_FILL = "color-mix(in oklab, var(--color-bone-chart) 50%, var(--color-bg-1))";

/** Drawn before the bars, so the dashed hairline only shows in empty space; the label sits in the band above the plot. */
function P95Rule({ ms, row, side, label, rule, ink }: { ms: number; row: 0 | 1; side: "left" | "right"; label: string; rule: string; ink: string }) {
  const x = binPosition(ms);
  const top = row * 15;
  return (
    <div aria-hidden className="pointer-events-none absolute" style={{ left: `${x * 100}%`, top, height: BAND + PLOT - top }}>
      <span className="absolute inset-y-0 left-0 border-l border-dashed" style={{ borderColor: rule }} />
      <span
        className={cn("t-data absolute top-0 whitespace-nowrap bg-bg-1 px-1 text-[10.5px] leading-[12px]", side === "left" ? "right-[2px]" : "left-[2px]")}
        style={{ color: ink }}
      >
        {label}
      </span>
    </div>
  );
}

function Histogram({ traces, p95, empty }: { traces: GatewayTrace[]; p95: { gateway: number; direct: number } | null; empty: boolean }) {
  const admitted = traces.filter((t) => t.outcome !== "BLOCKED");
  const count = (values: number[]) => BINS.map((b) => values.filter((v) => v >= b.lo && v < b.hi).length);
  const gw = count(admitted.map((t) => t.latencyMs));
  const direct = count(admitted.map((t) => t.baselineLatencyMs));
  const max = Math.max(4, ...gw, ...direct);
  const step = niceStep(max / 3);
  let domain = Math.ceil(max / step) * step;
  // Headroom so the count over the tallest bar stays inside the plot.
  if (max / domain > 0.88) domain += step;
  const ticks = Array.from({ length: Math.round(domain / step) + 1 }, (_, i) => i * step);
  const y = (v: number) => BAND + PLOT - (v / domain) * PLOT;
  const height = (n: number) => (n ? Math.max(2, (n / domain) * PLOT) : 0);

  return (
    <figure>
      <figcaption className="mb-1 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Micro className="text-accent">
          Fig. 02 — Time to first token · <span className="tok whitespace-nowrap">ms, log bins</span>
        </Micro>
        <span className="flex items-center gap-4 text-[11.5px] text-ink-3">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2 w-2.5 rounded-[1.5px] bg-ink-1" /> Through gateway
          </span>
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2 w-2.5 rounded-[1.5px]" style={{ background: DIRECT_FILL }} /> Direct to provider
          </span>
        </span>
        {p95 ? (
          <span className="sr-only">
            p95 {fmtMs(p95.gateway)} through the gateway, {fmtMs(p95.direct)} direct to provider.
          </span>
        ) : null}
      </figcaption>

      <div className="flex gap-2.5" style={{ height: BAND + PLOT + AXIS }}>
        <div aria-hidden className="relative w-6 shrink-0">
          <span className="t-data absolute right-0 top-[6px] text-[10.5px] leading-none text-ink-3">req</span>
          {ticks.map((t) => (
            <span key={t} className="t-data absolute right-0 -translate-y-1/2 text-[10.5px] leading-none text-ink-3" style={{ top: y(t) }}>
              {t}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {ticks.map((t) => (
            <div key={t} aria-hidden className={cn("absolute inset-x-0 h-px", t === 0 ? "bg-line-3" : "bg-line")} style={{ top: y(t) }} />
          ))}

          {BINS.map((b, i) => (
            <div key={b.lo} aria-hidden className="absolute" style={{ left: `${(i / BINS.length) * 100}%`, top: BAND + PLOT }}>
              <span className="absolute left-0 top-0 h-1 w-px bg-line-3" />
              <span className="t-data absolute left-0 top-2 -translate-x-1/2 text-[10.5px] leading-none text-ink-3">{fmtEdge(b.lo)}</span>
            </div>
          ))}

          {p95 ? (
            <>
              {/* Direct labels the top row and gateway the row below, each on the side away from the other rule,
                  so neither label is crossed by the other dashed line. */}
              <P95Rule
                ms={p95.direct}
                row={0}
                side={binPosition(p95.direct) > 0.72 ? "left" : "right"}
                label={`direct p95 ${fmtMsValue(p95.direct)}`}
                rule={DIRECT_FILL}
                ink="var(--color-ink-3)"
              />
              <P95Rule
                ms={p95.gateway}
                row={1}
                side={binPosition(p95.gateway) > 0.18 && p95.gateway <= p95.direct ? "left" : "right"}
                label={`p95 ${fmtMsValue(p95.gateway)}`}
                rule="var(--color-ink-2)"
                ink="var(--color-ink-1)"
              />
            </>
          ) : null}

          <div className="absolute inset-x-0 grid grid-cols-9" style={{ top: BAND, height: PLOT }}>
            {BINS.map((b, i) => (
              <div
                key={b.lo}
                role="img"
                aria-label={`${binName(b)}: ${gw[i]} through gateway, ${direct[i]} direct`}
                className="flex h-full items-end justify-center gap-[2px] px-[3px]"
              >
                {[
                  { n: gw[i], bar: "bg-ink-1", fill: undefined, text: "text-ink-2" },
                  { n: direct[i], bar: "", fill: DIRECT_FILL, text: "text-ink-3" },
                ].map((s, j) => (
                  <span key={j} className="flex h-full max-w-[12px] flex-1 flex-col items-center justify-end">
                    {s.n ? <span className={cn("t-data relative z-10 mb-[2px] whitespace-nowrap bg-bg-1 px-px text-[10.5px] leading-[11px]", s.text)}>{s.n}</span> : null}
                    <span
                      className={cn("w-full rounded-t-[1.5px] transition-[height] duration-500 ease-[var(--ease-out)] motion-reduce:transition-none", s.bar)}
                      style={{ height: height(s.n), background: s.fill }}
                    />
                  </span>
                ))}
              </div>
            ))}
          </div>


          {empty ? (
            <p className="absolute inset-x-0 text-center text-[13px] text-ink-3" style={{ top: BAND + PLOT / 2 - 10 }}>
              No burst yet — fire 50 to measure.
            </p>
          ) : null}
        </div>
      </div>
    </figure>
  );
}

/* ── trace table ─────────────────────────────────────────────────────────── */

/** One shared log scale for every row: 1 ms … 3 s. */
const LOG_MAX = Math.log10(3000);
const logX = (ms: number) => Math.min(1, Math.max(0, Math.log10(Math.max(ms, 1)) / LOG_MAX));
const pct = (f: number) => `${f * 100}%`;
const AXIS_TICKS: Array<[number, string]> = [
  [1, "1"],
  [10, "10"],
  [100, "100"],
  [1000, "1k"],
];
/** The latency column is a fixed 124px track (less 3px margins), so a gap in px is known without measuring. */
const TRACK_PX = 118;
const MIN_GAP_PX = 6;
// Decades are evenly spaced on the log scale, so one repeating hairline marks them all.
const DECADE_GRID = {
  backgroundImage: "linear-gradient(90deg, rgb(236 233 225 / 0.06) 1px, transparent 1px)",
  backgroundSize: `${100 / LOG_MAX}% 100%`,
};

const fmtCost = (usd: number) => `$${usd.toFixed(4)}`;

function stageTitle(t: GatewayTrace): string {
  const compute = t.timings.firewall + t.timings.t1 + t.timings.t2 + t.timings.lock + t.timings.router;
  const wait = Math.max(0, t.latencyMs - t.timings.network - compute);
  return [
    `network ${fmtMs(t.timings.network)}`,
    `firewall ${fmtUs(t.timings.firewall)}`,
    `T1 ${fmtUs(t.timings.t1)}`,
    `T2 ${fmtUs(t.timings.t2)}`,
    `lock ${fmtUs(t.timings.lock)}`,
    t.timings.router ? `router ${fmtUs(t.timings.router)}` : null,
    wait ? `${t.outcome === "COALESCED" ? "awaiting leader" : "upstream"} ${fmtMs(wait)}` : null,
    `direct to provider ${fmtMs(t.baselineLatencyMs)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The decision glyph (same shapes as <Glyph>) with a bg-1 halo, so a direct tick beneath it never fuses into the mark. */
function DumbbellHead({ tone }: { tone: Tone }) {
  const fill = `var(--color-${tone === "bone" ? "ink-2" : tone})`;
  const halo = { stroke: "var(--color-bg-1)", strokeWidth: 2.2, strokeLinejoin: "round" as const, paintOrder: "stroke" as const };
  return (
    <svg width={9} height={9} viewBox="-1 -1 12 12" aria-hidden className="block">
      {tone === "malachite" || tone === "bone" ? <circle cx="5" cy="5" r="4" fill={fill} {...halo} /> : null}
      {tone === "glacier" ? <path d="M5 .6 9.4 5 5 9.4.6 5Z" fill={fill} {...halo} /> : null}
      {tone === "amber" ? <path d="M5 1 9.4 9H.6Z" fill={fill} {...halo} /> : null}
      {tone === "cinnabar" ? <rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1" fill={fill} {...halo} /> : null}
    </svg>
  );
}

function Dumbbell({ t }: { t: GatewayTrace }) {
  const tone = decisionTone(t);
  const g = logX(t.latencyMs);
  const d = logX(t.baselineLatencyMs);
  // Endpoints closer than MIN_GAP_PX read as one mark: drop the connector and let a taller tick pass behind the glyph.
  const near = Math.abs(d - g) * TRACK_PX <= MIN_GAP_PX;
  return (
    <div className="relative mx-[3px] h-2.5" style={DECADE_GRID} title={stageTitle(t)}>
      {near ? null : (
        <span className="absolute top-1/2 h-px -translate-y-1/2 bg-[rgb(236_233_225/0.22)]" style={{ left: pct(Math.min(g, d)), width: pct(Math.abs(d - g)) }} />
      )}
      <span className={cn("absolute top-1/2 w-px -translate-y-1/2 bg-[var(--color-bone-chart)]", near ? "h-3" : "h-2")} style={{ left: pct(d) }} />
      <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: pct(g) }}>
        <DumbbellHead tone={tone} />
      </span>
      <span className="sr-only">direct to provider {fmtMs(t.baselineLatencyMs)}</span>
    </div>
  );
}

function DumbbellAxis() {
  return (
    <div>
      <span className="flex items-center gap-2.5 whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          <Glyph tone="bone" size={7} />
          <Micro>gateway</Micro>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="flex items-center">
            <span className="h-px w-1.5 bg-[rgb(236_233_225/0.22)]" />
            <span className="h-2 w-px bg-[var(--color-bone-chart)]" />
          </span>
          <Micro>direct</Micro>
        </span>
      </span>
      <div aria-hidden className="relative mx-[3px] mt-1.5 h-2.5">
        {AXIS_TICKS.map(([v, label], i) => (
          <span key={v} className="t-data absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10.5px] leading-none text-ink-3" style={{ left: pct(logX(v)) }}>
            {label}
            {i === AXIS_TICKS.length - 1 ? <span className="absolute left-full top-0 ml-[3px]">ms</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/*
 * Phones: two-line items (prompt + TTFT, decision + cost). md+: a six-column table on one grid.
 * lg–xl drops the latency column so the prompt keeps its width in the narrower right column.
 */
const TRACE_GRID = [
  "grid items-center gap-x-3 px-5 md:px-6",
  "grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:'p_t'_'d_c']",
  "md:grid-cols-[28px_minmax(0,1fr)_150px_64px_124px_56px] md:[grid-template-areas:'i_p_d_t_s_c']",
  "lg:grid-cols-[28px_minmax(0,1fr)_150px_64px_56px] lg:[grid-template-areas:'i_p_d_t_c']",
  "xl:grid-cols-[28px_minmax(0,1fr)_150px_64px_124px_56px] xl:[grid-template-areas:'i_p_d_t_s_c']",
].join(" ");
const STAGE_CELL = "hidden [grid-area:s] md:block lg:hidden xl:block";
const MOBILE_ROWS = 12;

function TraceTable({ traces, emptyText }: { traces: GatewayTrace[]; emptyText: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="relative lg:min-h-[320px] lg:flex-1">
      <div
        role="table"
        aria-label="Request trace, scrollable"
        tabIndex={0}
        className="focus-visible:outline-offset-[-2px] md:max-h-[480px] md:overflow-y-auto lg:absolute lg:inset-0 lg:max-h-none"
      >
        <div role="row" className={cn(TRACE_GRID, "sticky top-0 z-10 hidden items-end border-b border-line bg-bg-1 py-2.5 md:grid")}>
          <div role="columnheader" className="[grid-area:i]">
            <Micro>#</Micro>
          </div>
          <div role="columnheader" className="[grid-area:p]">
            <Micro>Prompt</Micro>
          </div>
          <div role="columnheader" className="[grid-area:d]">
            <Micro>Decided by</Micro>
          </div>
          <div role="columnheader" className="text-right [grid-area:t]">
            <Micro>TTFT</Micro>
          </div>
          <div role="columnheader" className={STAGE_CELL}>
            <DumbbellAxis />
          </div>
          <div role="columnheader" className="text-right [grid-area:c]">
            <Micro>Cost</Micro>
          </div>
        </div>

        {traces.length === 0 ? (
          <div role="row">
            <div role="cell" className="px-5 py-10 text-center text-[13px] text-ink-3">
              {emptyText}
            </div>
          </div>
        ) : null}

        {traces.map((t, i) => {
          const path = pathLabel(t);
          return (
            <div
              key={`${t.runId}:${t.id}`}
              role="row"
              className={cn(
                TRACE_GRID,
                "row-in gap-y-1 border-b border-line py-3 hover:bg-[rgb(236_233_225/0.025)] md:gap-y-0 md:py-2.5",
                !expanded && i >= MOBILE_ROWS && "max-md:hidden",
              )}
            >
              <div role="cell" className="t-data hidden text-[11.5px] text-ink-3 [grid-area:i] md:block">
                {t.id}
              </div>
              <div role="cell" className="min-w-0 [grid-area:p]">
                <p className="truncate text-[13px] text-ink-2" title={t.prompt}>
                  {truncate(t.prompt, 90)}
                </p>
              </div>
              <div role="cell" className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-1 [grid-area:d]">
                <Glyph tone={path.tone} size={7} />
                <span className="truncate" title={path.note ? `${path.text} · ${path.note}` : path.text}>
                  {path.text}
                  {path.note ? <span className="t-data ml-1.5 text-[11.5px] text-ink-3">{path.note}</span> : null}
                </span>
              </div>
              <div role="cell" className="t-data whitespace-nowrap text-right text-[12.5px] text-ink-1 [grid-area:t]">
                {fmtMs(t.latencyMs)}
              </div>
              <div role="cell" className={STAGE_CELL}>
                <Dumbbell t={t} />
              </div>
              <div role="cell" className={cn("t-data whitespace-nowrap text-right text-[12px] [grid-area:c]", t.costUsd ? "text-ink-2" : "text-ink-3")}>
                {fmtCost(t.costUsd)}
              </div>
            </div>
          );
        })}
      </div>

      {traces.length > MOBILE_ROWS ? (
        <div className="px-5 py-2 md:hidden">
          <button type="button" className="btn btn-ghost btn-sm w-full" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Show fewer" : `Show all ${traces.length}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── section ─────────────────────────────────────────────────────────────── */

function Percentile({ q, value, base }: { q: number; value: number | null; base: number | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Micro>
        <span className="tok">p{q}</span>
      </Micro>
      {value === null ? (
        <span className="t-figure text-[24px] text-ink-3">
          —<span className="sr-only">not measured yet</span>
        </span>
      ) : (
        <span className="flex items-baseline gap-1 whitespace-nowrap">
          <span className="t-figure text-[24px] tabular-nums text-ink-1">{fmtMsValue(value)}</span>
          <span className="t-data text-[11px] text-ink-3">ms</span>
        </span>
      )}
      <span className="t-data whitespace-nowrap text-[11px] text-ink-3" title="Same request sent direct to the provider">
        {base === null ? (
          <span aria-hidden>vs —</span>
        ) : (
          <>
            vs <span className="sr-only">direct to provider </span>
            {fmtMsValue(base)}
            {NNBSP}ms
          </>
        )}
      </span>
    </div>
  );
}

function BurstHistory({ bursts }: { bursts: BurstSummary[] }) {
  if (bursts.length < 2) return null;
  const recent = bursts.slice(-4);
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4">
      <Micro>
        <span className="tok">p95</span> by burst
      </Micro>
      {recent.map((b, i) => (
        <span key={b.runId} className="t-data flex items-center gap-2 whitespace-nowrap text-[12px] text-ink-3">
          {i > 0 ? <span className="text-ink-4">→</span> : null}#{b.index}
          <span className="text-ink-1">{fmtMs(b.p95)}</span>
          <span className="text-[10.5px] uppercase tracking-[0.06em]">{b.cold ? "cold" : "warm"}</span>
        </span>
      ))}
    </div>
  );
}

/** aria-disabled keeps a busy button focusable; these utilities stand in for .btn:disabled. */
const HELD = "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:active:transform-none";

function breakerNote(state: BreakerState, reason: string): string {
  if (state === "HALF_OPEN") return "probing";
  if (state === "CLOSED") return "trips after 3 failures";
  const cause = /429/.test(reason) ? " · HTTP 429" : "";
  return /probe/.test(reason) ? `probe failed${cause}` : `tripped${cause}`;
}

function PlayMark() {
  return (
    <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden className="shrink-0">
      <path d="M0 0 8 4.5 0 9Z" fill="currentColor" />
    </svg>
  );
}

export function BurstLoadSimulator() {
  const burst = useGateway((s) => s.burst);
  const bursts = useGateway((s) => s.bursts);
  const feed = useGateway((s) => s.feed);
  const breakers = useGateway((s) => s.breakers);
  const [scope, setScope] = useState<"burst" | "all">("all");

  const active = isBurstActive(burst);
  const burstTraces = useMemo(() => burst?.completed ?? [], [burst]);
  const tableRows = scope === "burst" ? [...burstTraces].reverse() : feed;
  const groqDown = breakers.groq.state === "OPEN";

  // Same inputs and percentile rule as the controller's summary, so live and settled readings agree.
  const stats = useMemo(() => {
    const admitted = burstTraces.filter((t) => t.outcome !== "BLOCKED");
    const lat = admitted.map((t) => t.latencyMs);
    const base = admitted.map((t) => t.baselineLatencyMs);
    const p = (values: number[], q: number) => (values.length ? percentile(values, q) : null);
    return {
      admitted: admitted.length,
      upstream: burstTraces.filter((t) => t.outcome === "UPSTREAM").length,
      served: burstTraces.filter((t) => t.outcome === "T1_HIT" || t.outcome === "T2_HIT" || t.outcome === "COALESCED").length,
      cost: burstTraces.reduce((sum, t) => sum + t.costUsd, 0),
      baselineCost: admitted.reduce((sum, t) => sum + t.baselineCostUsd, 0),
      p50: p(lat, 50),
      p95: p(lat, 95),
      p99: p(lat, 99),
      base50: p(base, 50),
      base95: p(base, 95),
      base99: p(base, 99),
    };
  }, [burstTraces]);

  const settledP95 = burst && !active && stats.p95 !== null && stats.base95 !== null ? { gateway: stats.p95, direct: stats.base95 } : null;

  return (
    <section id="chaos" className="mx-auto max-w-[1360px] px-4 pt-32 md:px-8 md:pt-40">
      <SectionHeader index="02" kicker="Burst & chaos console" title="Coalesce a stampede, then kill the primary">
        Fifty agent workers fire at once: identical cold queries, paraphrases, warm repeats, entity traps and injections. Every number below
        comes from the real pipeline, run on a virtual clock.
      </SectionHeader>

      <Reveal>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          {/* left: load + chaos */}
          <div className="flex flex-col gap-3 lg:col-span-5">
            <div className="bezel p-5 md:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label>Load generator</Label>
                  <p className="mt-1.5 text-[13px] leading-snug text-ink-3 [text-wrap:balance]">50 concurrent requests, one per worker.</p>
                </div>
                <button
                  type="button"
                  className={cn("btn btn-ghost btn-sm", HELD, "aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-2")}
                  aria-disabled={active}
                  onClick={() => {
                    if (active) return;
                    void getController().coldStart();
                  }}
                  title={active ? "Wait for the burst to finish" : "Clear both cache tiers"}
                >
                  Cold start
                </button>
              </div>

              <ul className="mt-5 divide-y divide-line border-y border-line">
                {COMPOSITION.map((row) => (
                  <li key={row.what} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 py-2">
                    <span className="t-data text-[12.5px] text-ink-1">{row.n}</span>
                    <span className="text-[13px] text-ink-2">{row.what}</span>
                    <span className="flex items-center justify-end gap-2 whitespace-nowrap text-right text-[12px] text-ink-3">
                      {row.path}
                      <Glyph tone={row.tone} size={7} />
                    </span>
                  </li>
                ))}
                {groqDown ? (
                  <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 py-2">
                    <span className="t-data text-[12.5px] text-ink-3">—</span>
                    <span className="text-[13px] text-ink-2">Groq circuit open</span>
                    <span className="flex items-center justify-end gap-2 whitespace-nowrap text-right text-[12px] text-ink-3">
                      Fast tier → Gemini
                      <Glyph tone="amber" size={7} />
                    </span>
                  </li>
                ) : null}
              </ul>

              <div className="mt-5 flex flex-wrap items-end gap-x-5 gap-y-4">
                <WorkerGrid traces={burstTraces} inFlight={active} />
                <button
                  type="button"
                  className={cn("btn btn-primary ml-auto", HELD, "aria-disabled:hover:bg-ink-1")}
                  aria-disabled={active}
                  onClick={() => {
                    if (active) return;
                    void getController().fireBurst();
                  }}
                >
                  <PlayMark />
                  {bursts.length ? "Fire again" : "Fire 50 requests"}
                </button>
              </div>
            </div>

            <div className="bezel p-5 md:p-6 lg:flex-1">
              <Label>Kill switch · Groq primary</Label>
              <div className="mt-4">
                <KillSwitch burstActive={active} />
              </div>
              <div className="mt-6 border-t border-line pt-4">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="shrink-0 text-[12.5px] font-[520] tracking-[-0.005em] text-ink-2">Groq breaker</span>
                  <span className="t-data min-w-0 whitespace-nowrap text-right text-[11px] text-ink-3">{breakerNote(breakers.groq.state, breakers.groq.reason)}</span>
                </div>
                <BreakerDiagram state={breakers.groq.state} since={breakers.groq.since} />
              </div>
              <div className="mt-2 border-t border-line">
                <ProviderRows />
              </div>
            </div>
          </div>

          {/* right: telemetry */}
          <div className="flex flex-col gap-3 lg:col-span-7">
            <div className="bezel p-5 md:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Label>
                  {burst ? (
                    <>
                      Burst #{burst.index}
                      {burst.status === "queued" ? null : <span className="whitespace-nowrap"> · {burst.cold ? "cold cache" : "warm cache"}</span>}
                    </>
                  ) : (
                    "Last burst"
                  )}
                </Label>
                <Chip>
                  {burst?.status === "queued" ? (
                    "Queued"
                  ) : active ? (
                    <>
                      <Glyph tone="glacier" size={7} />
                      In flight
                      {burst?.status === "running" ? ` · ${burstTraces.length}/${burst.total}` : ""}
                    </>
                  ) : burst ? (
                    "Settled"
                  ) : (
                    "Idle"
                  )}
                </Chip>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] md:items-end">
                <div>
                  <div className="flex items-baseline gap-3">
                    <span className={cn("t-figure text-[64px] tabular-nums md:text-[76px]", burst ? "text-ink-1" : "text-ink-3")}>
                      {burst ? stats.upstream : "—"}
                      {burst ? null : <span className="sr-only">not measured yet</span>}
                    </span>
                    <span className="text-[14px] leading-tight text-ink-2">
                      upstream {stats.upstream === 1 && burst ? "call" : "calls"}
                      {burst ? (
                        <>
                          <br />
                          <span className="text-ink-3">for {plural(stats.admitted, "admitted request")}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <p className="mt-3 text-[12.5px] leading-snug text-ink-3 [text-wrap:pretty]">
                    {burst ? (
                      <>
                        {fmtInt(stats.served)} answered from cache or coalesced onto an <span className="whitespace-nowrap">in-flight call</span> ·{" "}
                        <span className="whitespace-nowrap">{fmtUsd(stats.cost)} spent</span> vs <span className="whitespace-nowrap">{fmtUsd(stats.baselineCost)} direct</span>
                      </>
                    ) : (
                      "No burst yet — fire 50 to measure."
                    )}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-3 border-t border-line pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0">
                  <Percentile q={50} value={stats.p50} base={stats.base50} />
                  <Percentile q={95} value={stats.p95} base={stats.base95} />
                  <Percentile q={99} value={stats.p99} base={stats.base99} />
                </div>
              </div>
              <BurstHistory bursts={bursts} />

              <div className="mt-7">
                <Histogram traces={burstTraces} p95={settledP95} empty={!burst} />
              </div>
            </div>

            <div className="bezel flex flex-col overflow-hidden lg:min-h-0 lg:flex-1">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5 md:px-6">
                <Label>Request trace</Label>
                <div className="seg" role="group" aria-label="Trace scope">
                  <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                    All traffic
                  </button>
                  <button type="button" aria-pressed={scope === "burst"} onClick={() => setScope("burst")}>
                    Last burst
                  </button>
                </div>
              </div>
              <TraceTable
                traces={tableRows.slice(0, 80)}
                emptyText={scope === "burst" && !burst ? "No burst yet — fire 50 to measure." : "Requests appear here as their responses land."}
              />
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
