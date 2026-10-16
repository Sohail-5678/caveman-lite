"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { motion, useMotionValueEvent, useScroll, useTransform } from "framer-motion";
import { SCENE, type Tone } from "@/lib/gateway/choreography";
import { getController, useGateway } from "@/lib/gateway/use-gateway";
import { BREAKER_COOLDOWN_MS, isBurstActive } from "@/lib/gateway/controller";
import { checkParity, extractEntities } from "@/lib/cache/entity-guard";
import { CorridorRenderer, NARROW_BELOW, type LabelSlot, type ScreenRect } from "./corridor/renderer";
import { Glyph, Micro, PlayMark } from "./ui";
import { vetoReasons } from "./SemanticCacheInspector";
import { cn, fmtInt, plural } from "@/lib/format";
import type { ProviderId } from "@/lib/types";

const g = SCENE.gates;
const P = SCENE.providers;
const M = SCENE.monolith;

const VETO_CARD_MS = 3600;
const HOLD_MS = 700;

/**
 * Callout anchors in priority order: when two would overlap, the earlier one keeps its place.
 * Gate captions sit on two shared rails (above / below) and the providers in one column, like
 * dimensions on a drawing. Railed captions are listed outward from the scene: below the floor in
 * pipeline order, above it in reverse, so both rails read 01 → 05 from top to bottom.
 */
const SLOTS: Array<Omit<LabelSlot, "el" | "tag">> = [
  { id: "groq", anchor: [P.groq.x + M.w / 2, M.h, P.groq.z], lift: 14, side: "right", rail: true },
  { id: "gemini", anchor: [P.gemini.x + M.w / 2, M.h, P.gemini.z], lift: 14, side: "right", rail: true },
  { id: "claude", anchor: [P.claude.x + M.w / 2, M.h, P.claude.z], lift: 14, side: "right", rail: true },
  { id: "t1", anchor: [g.t1.x, 0, g.t1.size / 2], lift: 22, side: "below", rail: true },
  { id: "lock", anchor: [g.lock.x, 0, 0.3], lift: 22, side: "below", rail: true },
  // floor leader from the pylon foot keeps the router's caption clear of the Groq breaker
  { id: "router", anchor: [g.router.x, 0, 2.0], foot: [g.router.x, 0, 0], lift: 22, side: "below", rail: true },
  { id: "t2", anchor: [g.t2.x, 0.07 + g.t2.radius * 2 + 0.06, 0], lift: 28, side: "above", rail: true },
  { id: "firewall", anchor: [g.firewall.x, g.firewall.height + 0.1, 0], lift: 28, side: "above", rail: true },
  { id: "workers", anchor: [SCENE.workers.x, 0.02, -2.4], lift: 36, side: "above" },
];

/**
 * Phones look down the corridor, so the router, lock and providers stack above T2. Its caption joins
 * the floor rail there instead, which keeps 02 → 05 in reading order under the maquette.
 */
const NARROW_SLOTS: Array<Omit<LabelSlot, "el" | "tag">> = SLOTS.filter((s) => s.id !== "t2").flatMap((s) =>
  s.id === "t1" ? [s, { id: "t2", anchor: [g.t2.x, 0, 0.5], lift: 22, side: "below", rail: true }] : [s],
);

const GATE_INDEX: Record<string, string> = { workers: "00", firewall: "01", t1: "02", t2: "03", lock: "04", router: "05" };

const PROVIDER_META: Record<ProviderId, { name: string; model: string }> = {
  groq: { name: "Groq", model: "llama-3.3-70b" },
  gemini: { name: "Gemini", model: "2.5 Pro · Flash" },
  claude: { name: "Claude", model: "Sonnet 4.5" },
};

const LEGEND: Array<[Tone, string, string]> = [
  ["malachite", "Served from cache · circuit closed", "Cache · closed"],
  ["glacier", "Fast tier · coalesced", "Fast"],
  ["amber", "Frontier · rerouted · half-open", "Frontier"],
  ["cinnabar", "Blocked · vetoed · circuit open", "Blocked"],
];

/** A wall clock that only ticks while something on screen counts down. */
function useNow(active: boolean, interval = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [active, interval]);
  return now;
}

function Callout({ index, name, children }: { index: string; name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-[3px] text-center [text-shadow:0_1px_10px_rgb(7_8_11/0.95)]">
      <span className="t-micro whitespace-nowrap">
        <span className="text-accent-lo">{index}</span> <span className="text-ink-2">{name}</span>
      </span>
      <span className="t-data whitespace-nowrap text-[11.5px] text-ink-1">{children}</span>
    </div>
  );
}

/**
 * Plain-language reason for a veto, plus the line a developer would see in the response headers.
 * Reads cached → incoming, the same direction as the cache inspector.
 */
function describeVeto(veto: { similarity: number; threshold: number; prompt: string; matched: string | null }) {
  const code = `cos ${veto.similarity.toFixed(3)} ≥ τ ${veto.threshold.toFixed(2)} · x-cache: VETO`;
  if (!veto.matched) return { plain: "Close match, but the entities differ", code };
  const parity = checkParity(extractEntities(veto.matched), extractEntities(veto.prompt));
  const [reason] = vetoReasons(parity, "prose", { a: veto.matched, b: veto.prompt });
  return { plain: reason ?? "Close match, but the entities differ", code };
}

/** Open arc with an arrow tick: drawn for this set, square caps like the rest of the hairlines. */
function ResetMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path d="M2.25 6A3.75 3.75 0 1 0 3.35 3.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" />
      <path d="M3.35 1V3.35H1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" />
    </svg>
  );
}

/** aria-disabled keeps a busy key focusable, so keyboard users don't lose their place. */
const BUSY = "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:active:[transform:none]";

/**
 * Kill is a hold, not a press: the fill sweeps for 700 ms while held and snaps back on early release,
 * so the dock can't take Groq down by a stray click, a double-click or a held key's auto-repeat.
 * Restore stays a single press.
 */
function KillKey({ killed, onKill, onRestore }: { killed: boolean; onKill: () => void; onRestore: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  /** The current gesture started as a kill hold, so its trailing click must not restore. */
  const holdGesture = useRef(false);
  const keyDown = useRef(false);
  const hintId = useId();

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  }, []);

  const begin = () => {
    if (killed || timer.current !== undefined) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      onKill();
    }, HOLD_MS);
  };

  useEffect(() => cancel, [cancel]);

  return (
    <button
      type="button"
      className="btn btn-secondary relative touch-manipulation overflow-hidden [-webkit-touch-callout:none] max-sm:px-2.5"
      aria-label={killed ? "Restore Groq" : "Hold to kill Groq"}
      aria-describedby={killed ? undefined : hintId}
      title={killed ? "Restore Groq" : "Hold to kill Groq"}
      onPointerDown={(e) => {
        holdGesture.current = !killed;
        if (e.button !== 0 || killed) return;
        begin();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        holdGesture.current = false;
        // auto-repeat must neither start a hold nor, once killed, restore
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (killed) return;
        e.preventDefault();
        keyDown.current = true;
        begin();
      }}
      onKeyUp={(e) => {
        if ((e.key !== " " && e.key !== "Enter") || !keyDown.current) return;
        e.preventDefault();
        keyDown.current = false;
        cancel();
      }}
      onBlur={() => {
        keyDown.current = false;
        cancel();
      }}
      onClick={() => {
        if (holdGesture.current) {
          holdGesture.current = false;
          return;
        }
        if (killed) onRestore();
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[rgb(241_97_89/0.2)] shadow-[inset_0_0_0_1px_rgb(241_97_89/0.45)]"
        style={{
          clipPath: holding ? "inset(0 0 0 0)" : "inset(0 100% 0 0)",
          transition: holding ? `clip-path ${HOLD_MS}ms linear` : "clip-path 200ms ease-out",
        }}
      />
      {/* both labels share one cell, so the key keeps its width when it flips */}
      <span className="relative grid select-none [&>*]:[grid-area:1/1]">
        <span className={cn("text-center", killed && "invisible")}>
          <span className="sm:hidden">Hold to kill</span>
          <span className="hidden sm:inline">Hold to kill Groq</span>
        </span>
        <span className={cn("inline-flex items-center justify-center gap-1.5", !killed && "invisible")}>
          <Glyph tone="cinnabar" size={7} />
          <span className="sm:hidden">Restore</span>
          <span className="hidden sm:inline">Restore Groq</span>
        </span>
      </span>
      <span id={hintId} className="sr-only">
        Press and hold for 0.7 seconds. Every Groq call then returns HTTP 429 and the breaker fails traffic over.
      </span>
    </button>
  );
}

export function GatewayTopologyMap() {
  const figureRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captionRef = useRef<HTMLElement>(null);
  const legendRef = useRef<HTMLUListElement>(null);
  const vetoRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const slotEls = useRef<Record<string, HTMLDivElement | null>>({});
  const tagEls = useRef<Record<string, HTMLSpanElement | null>>({});
  const rendererRef = useRef<CorridorRenderer | null>(null);
  const measureRef = useRef<() => void>(() => {});
  const vetoShownRef = useRef(false);

  const counters = useGateway((s) => s.counters);
  const breakers = useGateway((s) => s.breakers);
  const veto = useGateway((s) => s.veto);
  const burst = useGateway((s) => s.burst);
  const killed = useGateway((s) => s.primaryKilled);
  const totals = useGateway((s) => s.totals);

  /** Phone layout: follows the renderer's own threshold, so camera and callouts switch together. */
  const [narrow, setNarrow] = useState(false);

  const anyOpen = breakers.groq.state === "OPEN" || breakers.gemini.state === "OPEN" || breakers.claude.state === "OPEN";
  const now = useNow(anyOpen);

  // Scrolling away raises the corridor's own camera until the maquette lies flat, then the figure dims.
  const { scrollYProgress } = useScroll({ target: figureRef, offset: ["start 0.25", "end start"] });
  const opacity = useTransform(scrollYProgress, [0.5, 1], [1, 0.35]);
  useMotionValueEvent(scrollYProgress, "change", (p) => rendererRef.current?.setScrollProgress(p));

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    const figure = figureRef.current;
    if (!canvas || !frame || !figure) return;
    const controller = getController();
    controller.start();
    const renderer = new CorridorRenderer(canvas, controller);
    rendererRef.current = renderer;
    // labels are handed over by the effect below, which also swaps them for the phone rails
    renderer.setBreakers(controller.store.get().breakers);
    renderer.setScrollProgress(scrollYProgress.get());

    // HTML overlays in canvas pixels: the frame, the caption and the legend share one origin
    const box = (el: HTMLElement | null): ScreenRect | null =>
      el && el.offsetWidth > 0 ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
    const measure = () => {
      const caption = captionRef.current;
      if (caption) figure.style.setProperty("--caption-bottom", `${caption.offsetTop + caption.offsetHeight}px`);
      renderer.setObstacles([box(caption), box(legendRef.current)].filter((r): r is ScreenRect => r !== null));
      renderer.setVetoCard(vetoShownRef.current ? box(vetoRef.current) : null);
      const dock = dockRef.current;
      renderer.setFloor(dock ? dock.offsetTop - 6 : null);
    };
    measureRef.current = measure;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== frame) continue;
        setNarrow(entry.contentRect.width < NARROW_BELOW);
        renderer.resize(entry.contentRect.width, entry.contentRect.height);
      }
      measure();
    });
    for (const el of [frame, captionRef.current, legendRef.current, vetoRef.current, dockRef.current]) if (el) ro.observe(el);

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotionPreference = () => renderer.setReducedMotion(motionQuery.matches);
    onMotionPreference();
    motionQuery.addEventListener("change", onMotionPreference);

    let visible = false;
    const sync = () => {
      const on = visible && document.visibilityState === "visible";
      controller.setSceneVisible(on);
      if (on) renderer.start();
      else renderer.stop();
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        sync();
      },
      { threshold: 0.02 },
    );
    io.observe(frame);
    document.addEventListener("visibilitychange", sync);

    return () => {
      ro.disconnect();
      io.disconnect();
      motionQuery.removeEventListener("change", onMotionPreference);
      document.removeEventListener("visibilitychange", sync);
      measureRef.current = () => {};
      rendererRef.current = null;
      renderer.dispose();
      controller.setSceneVisible(false);
    };
    // the scroll motion value is stable for the component's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.setBreakers(breakers);
  }, [breakers]);

  useEffect(() => {
    rendererRef.current?.setLabels(
      (narrow ? NARROW_SLOTS : SLOTS).map((s): LabelSlot => ({ ...s, el: slotEls.current[s.id] ?? null, tag: tagEls.current[s.id] ?? null })),
    );
  }, [narrow]);

  // the veto card stays up for a fixed read time after the most recent veto
  const [vetoShown, setVetoShown] = useState(false);
  useEffect(() => {
    if (!veto) return;
    const left = VETO_CARD_MS - (Date.now() - veto.at);
    if (left <= 0) return;
    setVetoShown(true);
    const id = setTimeout(() => setVetoShown(false), left);
    return () => clearTimeout(id);
  }, [veto]);

  const vetoNote = useMemo(() => (veto ? describeVeto(veto) : null), [veto]);

  // on phones the veto docks as a line on the dock, so the card never covers the scene
  const cardShown = vetoShown && !narrow;
  useEffect(() => {
    vetoShownRef.current = cardShown;
    if (cardShown) {
      measureRef.current();
      return;
    }
    // let the card finish fading before the labels underneath come back
    const id = setTimeout(() => measureRef.current(), 220);
    return () => clearTimeout(id);
  }, [cardShown, vetoNote]);

  const active = isBurstActive(burst);
  const controller = typeof window === "undefined" ? null : getController();

  // Stage callouts count a request when it reaches the stage; session totals count it once it settles.
  const decided = counters.blocked + counters.t1Hits + counters.t2Hits + counters.coalesced + counters.upstream;
  const inFlight = Math.max(0, decided - totals.requests);
  const readout =
    active && burst ? (
      <>
        burst <span className="text-ink-1">{fmtInt(burst.completed.length)}</span>/{fmtInt(burst.total)} returned
      </>
    ) : (
      <>
        <span className="text-ink-1">{fmtInt(totals.requests)}</span> {totals.requests === 1 ? "request" : "requests"} this session
        {inFlight > 0 ? <> · {fmtInt(inFlight)} in flight</> : null}
      </>
    );

  const breakerState = (id: ProviderId): { tone: Tone; label: string; left: number } => {
    const b = breakers[id];
    if (b.state === "OPEN") {
      const left = Math.ceil((BREAKER_COOLDOWN_MS - (now - b.since)) / 1000);
      return { tone: "cinnabar", label: "Open", left: clamp(left, 0, BREAKER_COOLDOWN_MS / 1000) };
    }
    if (b.state === "HALF_OPEN") return { tone: "amber", label: "Half-open", left: 0 };
    return { tone: "malachite", label: "Closed", left: 0 };
  };

  const setSlot = (id: string) => (el: HTMLDivElement | null) => {
    slotEls.current[id] = el;
  };
  const setTag = (id: string) => (el: HTMLSpanElement | null) => {
    tagEls.current[id] = el;
  };

  const slot = "absolute left-0 top-0 opacity-0 transition-opacity duration-150 will-change-transform";

  return (
    <motion.figure
      ref={figureRef}
      style={{ opacity }}
      className="bezel reg-marks relative isolate overflow-hidden rounded-[14px]"
    >
      {/* depth wash: light from above, floor falling into shadow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 70% at 50% 0%, rgb(243 240 233 / 0.05), transparent 60%), linear-gradient(180deg, transparent 55%, rgb(0 0 0 / 0.35))",
        }}
      />

      <div ref={frameRef} className="relative h-[560px] w-full md:h-[600px]">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full cursor-grab touch-pan-y"
          aria-label="Animated 3D view of requests flowing through the gateway pipeline"
          role="img"
        />

        {/* 3D-anchored callouts, positioned by the renderer whenever the view changes */}
        <div className="pointer-events-none absolute inset-0 select-none">
          <div ref={setSlot("workers")} className={slot}>
            <Callout index="00" name="Agents">
              {plural(50, "worker")}
            </Callout>
          </div>
          <div ref={setSlot("firewall")} className={slot}>
            <Callout index="01" name="Firewall">
              {fmtInt(counters.blocked)} blocked
            </Callout>
          </div>
          <div ref={setSlot("t1")} className={slot}>
            <Callout index="02" name="T1 exact">
              {plural(counters.t1Hits, "hit")}
            </Callout>
          </div>
          <div ref={setSlot("t2")} className={slot}>
            <Callout index="03" name="T2 semantic">
              {plural(counters.t2Hits, "hit")} · {fmtInt(counters.vetoes)} vetoed
            </Callout>
          </div>
          <div ref={setSlot("lock")} className={slot}>
            <Callout index="04" name="Singleflight">
              {fmtInt(counters.coalesced)} coalesced
            </Callout>
          </div>
          <div ref={setSlot("router")} className={slot}>
            <Callout index="05" name="Router">
              {fmtInt(counters.fast)} fast · {fmtInt(counters.frontier)} frontier
            </Callout>
          </div>
          {Object.entries(GATE_INDEX).map(([id, index]) => (
            <span
              key={id}
              ref={setTag(id)}
              aria-hidden
              className="t-data absolute left-0 top-0 rounded-[4px] border border-line-2 bg-[rgb(7_8_11/0.9)] px-1 text-[10.5px] leading-[15px] text-ink-2 opacity-0 transition-opacity duration-150 will-change-transform"
            >
              {index}
            </span>
          ))}
          {(Object.keys(PROVIDER_META) as ProviderId[]).map((id) => {
            const state = breakerState(id);
            const countdown = state.left > 0 ? <span className="tok">{state.left}{" "}s</span> : null;
            return (
              <div key={id} ref={setSlot(id)} className={slot}>
                {narrow ? (
                  // phones: name and state glyph only, so the column gives the maquette its width back
                  <div className="flex flex-col items-start gap-[3px] text-left [text-shadow:0_1px_10px_rgb(7_8_11/0.95)]">
                    <span className="flex items-center gap-1.5">
                      <Glyph tone={state.tone} size={7} />
                      <span className="t-micro whitespace-nowrap text-ink-2">
                        {PROVIDER_META[id].name}
                        <span className="sr-only"> {state.label}</span>
                      </span>
                    </span>
                    {countdown ? <span className="t-micro pl-[13px] text-ink-3">{countdown}</span> : null}
                  </div>
                ) : (
                  <div className="flex w-[100px] flex-col items-start gap-[3px] text-left [text-shadow:0_1px_10px_rgb(7_8_11/0.95)]">
                    <span className="t-micro text-ink-2">{PROVIDER_META[id].name}</span>
                    <span className="t-data whitespace-nowrap text-[11px] text-ink-3">{PROVIDER_META[id].model}</span>
                    <span className="flex items-center gap-1.5">
                      <Glyph tone={state.tone} size={7} />
                      <span className="t-micro whitespace-nowrap text-ink-2">
                        {state.label}
                        {countdown ? <> {countdown}</> : null}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* entity-veto card, docked under the caption like an exploded-view callout */}
        <div
          ref={vetoRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-5 w-[min(300px,calc(100%-40px))] rounded-[10px] border border-line-2 bg-[rgb(13_15_18/0.96)] px-3.5 py-3 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.7)] transition-opacity duration-200 md:left-6",
            cardShown ? "opacity-100" : "opacity-0",
            narrow && "hidden",
          )}
          style={{ top: "calc(var(--caption-bottom, 96px) + 14px)" }}
        >
          <div className="flex items-center gap-2">
            <Glyph tone="cinnabar" size={7} />
            <Micro className="text-ink-2">Entity guard · veto</Micro>
          </div>
          {vetoNote ? (
            <>
              <p className="mt-2 text-[13px] leading-snug text-ink-1">{vetoNote.plain}</p>
              <p className="t-data mt-1 text-[11px] leading-snug text-ink-3">{vetoNote.code}</p>
            </>
          ) : null}
        </div>

        {/* legend, wide screens: a right-aligned stack */}
        <ul ref={legendRef} className="pointer-events-none absolute right-5 top-5 hidden space-y-1.5 md:right-6 md:top-6 xl:block">
          {LEGEND.map(([tone, label]) => (
            <li key={tone} className="flex items-center justify-end gap-2">
              <span className="text-[11.5px] text-ink-3">{label}</span>
              <Glyph tone={tone} size={7} />
            </li>
          ))}
        </ul>

        {/* orbit hint + session readout */}
        <div className="pointer-events-none absolute bottom-5 left-6 hidden lg:block">
          <span className="text-[11.5px] text-ink-3">Drag to orbit · double-click to reset</span>
        </div>
        <div className={cn("pointer-events-none absolute bottom-5 right-6 hidden text-right", !narrow && "lg:block")}>
          <span className="t-data text-[11.5px] text-ink-3">{readout}</span>
        </div>

        {/* control dock; on phones it carries the readout line, which a veto replaces for a moment */}
        <div ref={dockRef} className="absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 px-2 md:bottom-5">
          {narrow ? (
            <div className="pointer-events-none relative h-[18px] w-full max-w-[360px] px-3">
              <p
                className={cn(
                  "t-data absolute inset-x-3 inset-y-0 truncate text-center text-[11.5px] leading-[18px] text-ink-3 transition-opacity duration-150",
                  vetoShown ? "opacity-0" : "opacity-100",
                )}
              >
                {readout}
              </p>
              <p
                aria-hidden
                className={cn(
                  "absolute inset-x-3 inset-y-0 flex items-center justify-center gap-1.5 text-[12px] leading-[18px] transition-opacity duration-150",
                  vetoShown ? "opacity-100" : "opacity-0",
                )}
              >
                <Glyph tone="cinnabar" size={7} />
                <span className="t-micro shrink-0 text-ink-2">Veto</span>
                <span className="truncate text-ink-1">{vetoNote?.plain}</span>
              </p>
            </div>
          ) : null}
          <div className="glass flex items-center gap-1 rounded-xl p-1.5 sm:gap-1.5">
            <button
              type="button"
              className={cn("btn btn-primary max-sm:gap-1.5 max-sm:px-2.5 aria-disabled:hover:bg-ink-1", BUSY)}
              aria-disabled={active}
              title={active ? "Burst in flight" : undefined}
              onClick={() => {
                if (active) return;
                void controller?.fireBurst();
              }}
            >
              <PlayMark />
              <span className="hidden sm:inline">Fire 50 requests</span>
              <span className="sm:hidden">
                Fire <span aria-hidden>×</span>50
              </span>
            </button>
            <KillKey
              killed={killed}
              onKill={() => controller?.setPrimaryKilled(true)}
              onRestore={() => controller?.setPrimaryKilled(false)}
            />
            <button
              type="button"
              className={cn("btn btn-secondary max-sm:px-2.5 aria-disabled:hover:border-line-2 aria-disabled:hover:bg-bg-3", BUSY)}
              aria-disabled={active}
              aria-label="Entity trap: send a prompt that collides with a cached one"
              title={active ? "Wait for the burst to finish" : "Entity trap: send a prompt that collides with a cached one"}
              onClick={() => {
                if (active) return;
                void controller?.runEntityTrap();
              }}
            >
              <span className="sm:hidden">Trap</span>
              <span className="hidden sm:inline">Entity trap</span>
            </button>
            <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-line-2 sm:block" />
            <button
              type="button"
              className={cn("btn btn-ghost px-2.5 [@media(pointer:coarse)]:min-w-11 aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-2", BUSY)}
              aria-disabled={active}
              title={active ? "Wait for the burst to finish" : "Cold start: clear both cache tiers"}
              aria-label="Cold start: clear both cache tiers"
              onClick={() => {
                if (active) return;
                void controller?.coldStart();
              }}
            >
              <ResetMark />
            </button>
          </div>
        </div>
      </div>

      <figcaption ref={captionRef} className="pointer-events-none absolute left-5 top-5 max-w-[300px] md:left-6 md:top-6">
        <Micro className="text-accent">Fig. 01 — Request corridor</Micro>
        <p className="mt-1.5 text-[12.5px] leading-snug text-ink-3 [text-wrap:pretty]">
          <span className="md:hidden">Each packet is one real request.</span>
          <span className="hidden md:inline">
            Each packet is a request run through the real pipeline. Colour marks the stage that decided it; stage counts
            run for the session.
          </span>
        </p>
        {/* legend below xl: one compact row under the caption, clear of the provider column */}
        <ul className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 xl:hidden">
          {LEGEND.map(([tone, , short]) => (
            <li key={tone} className="flex items-center gap-1.5">
              <Glyph tone={tone} size={7} />
              <span className="text-[11.5px] text-ink-3">{short}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </motion.figure>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
