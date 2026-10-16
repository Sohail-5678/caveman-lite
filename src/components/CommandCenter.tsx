"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, useReducedMotion } from "framer-motion";
import { getController, type VetoNotice } from "@/lib/gateway/controller";
import { checkParity, extractEntities } from "@/lib/cache/entity-guard";
import { fmtMs, fmtInt, plural } from "@/lib/format";
import { Navbar } from "./Navbar";
import { Hero } from "./Hero";
import { BurstLoadSimulator } from "./BurstLoadSimulator";
import { SemanticCacheInspector } from "./SemanticCacheInspector";
import { ParetoFrontierChart } from "./ParetoFrontierChart";
import { ProxyPlayground } from "./ProxyPlayground";
import { BenchmarkDrawer } from "./BenchmarkDrawer";
import { Footer } from "./Footer";

/** The page plane while the drawer is in front of it. Navbar, main and the frame all take this exact transform. */
const RECEDE = "scale(0.955) translateY(8px)";

const PROVIDER_NAMES: Record<string, string> = { groq: "Groq", gemini: "Gemini", claude: "Claude" };
const BREAKER_WORDS: Record<string, string> = { OPEN: "open", HALF_OPEN: "half-open", CLOSED: "closed" };

/** "names differ: microsoft, not apple", incoming value first. */
function vetoReason(veto: VetoNotice): string {
  if (veto.matched) {
    const { diff } = checkParity(extractEntities(veto.matched), extractEntities(veto.prompt));
    const sets = [
      [diff.named, "names differ"],
      [diff.numeric, "numbers differ"],
      [diff.polarity, "negation differs"],
    ] as const;
    for (const [d, what] of sets) {
      if (d.onlyA.length || d.onlyB.length) return `${what}: ${d.onlyB.join(", ") || "none"}, not ${d.onlyA.join(", ") || "none"}`;
    }
  }
  return "entities differ";
}

/**
 * One polite live region for the whole instrument: burst results, breaker transitions and entity vetoes.
 * Messages that land together are spoken as one sentence, never more often than every 1.5 s.
 * Vetoes are only spoken right after the visitor acted, so ambient traffic stays silent.
 */
function useAnnouncements() {
  const [message, setMessage] = useState({ text: "", n: 0 });

  useEffect(() => {
    const store = getController().store;
    let prev = store.get();
    const queue = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSpoken = -Infinity;
    let lastAct = -Infinity;
    let lastVeto = -Infinity;

    const flush = () => {
      timer = null;
      if (!queue.size) return;
      const text = [...queue.values()].join(". ");
      queue.clear();
      lastSpoken = performance.now();
      setMessage((m) => ({ text, n: m.n + 1 }));
    };
    // keyed, so a breaker that flips twice inside one window is spoken once, in its latest state
    const say = (key: string, text: string) => {
      queue.set(key, text);
      if (!timer) timer = setTimeout(flush, Math.max(250, 1500 - (performance.now() - lastSpoken)));
    };

    const unsubscribe = store.subscribe(() => {
      const s = store.get();
      if (s.bursts !== prev.bursts && s.bursts.length > prev.bursts.length) {
        const b = s.bursts[s.bursts.length - 1];
        say(
          "burst",
          `Burst ${b.index} done: ${plural(b.upstreamCalls, "upstream call")} for ${fmtInt(b.admitted)} admitted, p95 ${fmtMs(b.p95)}`,
        );
      }
      if (s.breakers !== prev.breakers) {
        for (const id of Object.keys(s.breakers) as Array<keyof typeof s.breakers>) {
          const to = s.breakers[id].state;
          if (to !== prev.breakers[id]?.state) say(`breaker:${id}`, `${PROVIDER_NAMES[id] ?? id} circuit ${BREAKER_WORDS[to] ?? to}`);
        }
      }
      const veto = s.veto;
      const now = performance.now();
      if (veto && veto !== prev.veto && Date.now() - veto.at < 4000 && now - lastAct < 8000 && now - lastVeto > 6000) {
        lastVeto = now;
        say("veto", `Entity veto, ${vetoReason(veto)}. The near match was not served`);
      }
      prev = s;
    });

    const act = () => {
      lastAct = performance.now();
    };
    document.addEventListener("pointerdown", act, true);
    document.addEventListener("keydown", act, true);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      document.removeEventListener("pointerdown", act, true);
      document.removeEventListener("keydown", act, true);
    };
  }, []);

  return message;
}

export function CommandCenter() {
  const [benchOpen, setBenchOpen] = useState(false);
  const [origin, setOrigin] = useState("50% 0px");
  const reduce = useReducedMotion();
  const recede = benchOpen && !reduce;
  const returnTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const announcement = useAnnouncements();
  // The floor and keyline exist only while the plane is out or travelling back, so at rest the page has no
  // viewport-sized shadow that a mobile toolbar resize could briefly expose.
  const [planeUp, setPlaneUp] = useState(false);
  if (recede && !planeUp) setPlaneUp(true);
  useEffect(() => {
    if (recede || !planeUp) return;
    const id = setTimeout(() => setPlaneUp(false), 600);
    return () => clearTimeout(id);
  }, [recede, planeUp]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.overflow = benchOpen ? "hidden" : "";
    // keep the scrollbar's gutter so locking scroll doesn't shift the page sideways
    root.style.scrollbarGutter = benchOpen ? "stable" : "";
  }, [benchOpen]);

  useEffect(() => {
    // ambient traffic and corridor playback hold while the drawer is in front of the page
    getController().setPaused(benchOpen);
    if (!benchOpen && wasOpen.current) {
      returnTo.current?.focus({ preventScroll: true });
      returnTo.current = null;
    }
    wasOpen.current = benchOpen;
  }, [benchOpen]);

  const open = () => {
    const el = document.activeElement;
    returnTo.current = el instanceof HTMLElement && el !== document.body ? el : null;
    setOrigin(`50% ${Math.round(window.scrollY + window.innerHeight / 2)}px`);
    setBenchOpen(true);
  };

  return (
    <MotionConfig reducedMotion="user">
      <Navbar onOpenBench={open} recede={recede ? RECEDE : null} />
      {/* the page recedes as one plane while the verification drawer is in front of it */}
      <main
        id="top"
        inert={benchOpen}
        className="relative bg-bg-0 transition-transform duration-500 ease-[var(--ease-drawer)]"
        style={{ transformOrigin: origin, transform: recede ? RECEDE : "none" }}
      >
        <div className="key-light pointer-events-none absolute inset-x-0 top-0 h-[900px]" aria-hidden />
        <Hero />
        <BurstLoadSimulator />
        <SemanticCacheInspector />
        <ParetoFrontierChart />
        <ProxyPlayground />
        <Footer />
      </main>
      {/*
        The plane's edge. A viewport-sized frame takes the same transform; its spread shadow lays a dark floor
        over everything outside the scaled viewport (including page content above and below it), and a 1px
        keyline with rounded corners marks the plane. At scale 1 both sit just outside the viewport.
      */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[45] transition-[transform,border-radius] duration-500 ease-[var(--ease-drawer)]"
        style={{
          transform: recede ? RECEDE : "none",
          // 16px and 1px on screen once scaled by 0.955
          borderRadius: recede ? 16.75 : 0,
          boxShadow: planeUp ? "0 0 0 1.05px var(--color-line-2), 0 0 0 100vmax rgb(1 1 2)" : "none",
        }}
      />
      <BenchmarkDrawer open={benchOpen} onClose={() => setBenchOpen(false)} />
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement.text ? <span key={announcement.n}>{announcement.text}</span> : null}
      </div>
    </MotionConfig>
  );
}
