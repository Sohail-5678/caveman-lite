"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Play, X } from "lucide-react";
import {
  BENCHMARK_CASES,
  runBenchmarkCase,
  type BenchmarkCategory,
  type BenchmarkResult,
} from "@/lib/evals/gateway-benchmark";
import { cn } from "@/lib/format";
import { Chip, Glyph, Label, Micro } from "./ui";

type Status = "idle" | "running" | "done";

const TOTAL = BENCHMARK_CASES.length;

/** One unit for the whole column: ms at one decimal, never a bare "0.0". */
const fmtDuration = (ms: number) => (ms < 0.05 ? "< 0.1 ms" : `${ms.toFixed(1)} ms`);

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function BenchmarkDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduce = useReducedMotion();
  const [results, setResults] = useState<Record<string, BenchmarkResult>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [expanded, setExpanded] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  // Each run holds a token; closing the drawer or starting a new run retires the old one.
  const token = useRef(0);

  const groups = useMemo(() => {
    const m = new Map<BenchmarkCategory, typeof BENCHMARK_CASES>();
    for (const c of BENCHMARK_CASES) m.set(c.category, [...(m.get(c.category) ?? []), c]);
    return [...m.entries()];
  }, []);

  const list = Object.values(results);
  const passed = list.filter((r) => r.pass).length;
  const failed = list.length - passed;
  const totalMs = list.reduce((s, r) => s + r.durationMs, 0);

  const run = async () => {
    const my = ++token.current;
    setResults({});
    setStatus("running");
    for (const c of BENCHMARK_CASES) {
      if (my !== token.current) return;
      setCurrent(c.id);
      const r = await runBenchmarkCase(c);
      if (my !== token.current) return;
      setResults((prev) => ({ ...prev, [c.id]: r }));
      // a beat between cases so the run is legible; the measured durations are the cases' own
      await new Promise((res) => setTimeout(res, reduce ? 0 : 55));
    }
    if (my !== token.current) return;
    setCurrent(null);
    setStatus("done");
  };

  useEffect(
    () => () => {
      token.current++;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    if (Object.keys(results).length < TOTAL) void run();
    else setStatus("done");
    return () => {
      window.removeEventListener("keydown", onKey);
      // closing mid-run abandons it; the next open starts over
      token.current++;
      setStatus((s) => (s === "running" ? "idle" : s));
      setCurrent(null);
      requestAnimationFrame(() => returnTo?.focus());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const allPassed = status === "done" && failed === 0;

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="scrim"
            aria-hidden
            className="fixed inset-0 z-50 bg-[rgb(20_6_10/0.45)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={onClose}
          />
          <motion.aside
            key="panel"
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bench-title"
            aria-describedby="bench-desc"
            className="glass fixed inset-y-2 right-2 z-50 flex w-[min(560px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl bg-[rgb(53_29_34/0.88)] outline-none"
            initial={reduce ? { opacity: 0 } : { x: "104%" }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "104%" }}
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
          >
            <header className="border-b border-line px-5 pb-5 pt-6 sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label className="text-ink-2">Verification suite</Label>
                  <h2 id="bench-title" className="t-title mt-1.5 text-[22px] text-ink-1">
                    {TOTAL} checks, {groups.length} subsystems
                  </h2>
                  <p id="bench-desc" className="mt-2 max-w-[54ch] text-[13px] leading-snug text-ink-3 [text-wrap:pretty]">
                    Each case exercises the real module in your browser: stampede coalescing, entity vetoes, breaker
                    transitions, McNemar math, injection blocking.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm size-[30px] shrink-0 p-0 [@media(pointer:coarse)]:size-10"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X className="size-4" strokeWidth={1.8} />
                </button>
              </div>

              <div className="mt-5 flex items-center gap-4">
                {/* quiet when green: passes are hairline ticks, only a failure reaches full height in colour */}
                <div
                  role="img"
                  aria-label={`${passed} of ${TOTAL} passed, ${failed} failed`}
                  className="flex h-[18px] flex-1 items-center justify-between"
                >
                  {BENCHMARK_CASES.map((c) => {
                    const r = results[c.id];
                    return (
                      <span
                        key={c.id}
                        className={cn(
                          "w-[2px] rounded-[1px] transition-[height,background-color] duration-300",
                          r
                            ? r.pass
                              ? "h-[12px] bg-[rgb(236_233_225/0.38)]"
                              : "h-full bg-cinnabar"
                            : current === c.id
                              ? "h-[12px] bg-ink-2"
                              : "h-[4px] bg-ink-4",
                        )}
                      />
                    );
                  })}
                </div>
                {/* aria-disabled, not disabled: the focused button keeps focus while the run it started is going */}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:active:transform-none"
                  onClick={() => {
                    if (status !== "running") void run();
                  }}
                  aria-disabled={status === "running"}
                >
                  <Play className="size-3" strokeWidth={2} fill="currentColor" />
                  {status === "running" ? "Running" : "Re-run"}
                </button>
              </div>
              {/* the counter below ticks 30 times a run, so only the final tally is spoken */}
              <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {status === "done" ? `${passed} of ${TOTAL} checks passed${failed ? `, ${failed} failed` : ""}, ${fmtDuration(totalMs)} total.` : ""}
              </p>
              <div className="t-data mt-3 flex min-h-[22px] items-center gap-2.5 text-[11.5px] text-ink-3">
                {allPassed ? (
                  <>
                    {/* a clean pass stays bone: malachite is cache hit / healthy, not generic success */}
                    <Chip>
                      {passed}/{TOTAL}
                    </Chip>
                    <span>passed</span>
                  </>
                ) : failed > 0 ? (
                  <>
                    <Chip tone="cinnabar">{failed} failed</Chip>
                    <span>
                      <span className="text-ink-1">{passed}</span>/{TOTAL} passed
                    </span>
                  </>
                ) : (
                  <span>
                    <span className="text-ink-1">{list.length}</span>/{TOTAL} {status === "running" ? "run so far" : "run"}
                  </span>
                )}
                <span className="ml-auto">{totalMs ? `${totalMs.toFixed(1)} ms total` : "—"}</span>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6" aria-busy={status === "running"}>
              {groups.map(([category, cases]) => (
                <section key={category} className="mb-5">
                  <div className="mb-1 flex items-center justify-between">
                    <Micro>{category}</Micro>
                    <span className="t-data text-[11px] text-ink-3">
                      {cases.filter((c) => results[c.id]?.pass).length}/{cases.length}
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {cases.map((c) => {
                      const r = results[c.id];
                      const isOpen = expanded === c.id && !!r;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                            className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-3 py-2.5 text-left"
                            aria-expanded={isOpen}
                          >
                            <span className="flex h-[19px] items-center justify-center">
                              {r ? (
                                r.pass ? (
                                  <Check className="size-3 text-ink-2" strokeWidth={2.2} aria-label="passed" />
                                ) : (
                                  <Glyph tone="cinnabar" size={8} />
                                )
                              ) : current === c.id ? (
                                <span className="size-1.5 rounded-full bg-ink-2 motion-safe:animate-pulse" />
                              ) : (
                                <span className="size-1 rounded-full bg-ink-4" />
                              )}
                            </span>
                            <span className={cn("text-[13px] leading-[19px] [text-wrap:pretty]", r ? "text-ink-1" : "text-ink-3")}>
                              {c.name}
                              {r && !r.pass ? <span className="sr-only"> (failed)</span> : null}
                            </span>
                            <span className="t-data text-[11px] leading-[19px] text-ink-3">{r ? fmtDuration(r.durationMs) : ""}</span>
                          </button>
                          <AnimatePresence initial={false}>
                            {isOpen ? (
                              <motion.div
                                initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
                                exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                                className="overflow-hidden"
                              >
                                <p className="t-data break-words pb-3 pl-[30px] text-[11.5px] leading-relaxed text-ink-3 [text-wrap:pretty]">
                                  {r.detail}
                                </p>
                              </motion.div>
                            ) : null}
                          </AnimatePresence>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
