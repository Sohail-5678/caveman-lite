"use client";

import { ArrowDown, ArrowUpRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useGateway } from "@/lib/gateway/use-gateway";
import { BREAKER_COOLDOWN_MS } from "@/lib/gateway/controller";
import type { Tone } from "@/lib/gateway/choreography";
import { percentile } from "@/lib/utils/prng";
import { cn, fmtCountdown, fmtInt, fmtMsValue, fmtPct, fmtSigned, fmtUsd, NBSP, plural } from "@/lib/format";
import { GatewayTopologyMap } from "./GatewayTopologyMap";
import { Glyph, Label, Micro } from "./ui";

// Non-breaking spaces keep comparators and units on the same line as their number.
const SPEC: Array<[string, string, string]> = [
  ["Exact hit", "< 2 ms", "SHA-256 over canonical JSON"],
  ["Semantic hit", "< 14 ms", "cos ≥ 0.94 with entity parity"],
  ["Stampede", "50 → 1", "Singleflight promise lock"],
  ["Routing decision", "< 4 ms", "12-feature logistic model"],
  ["Failover", "< 1 ms", "Breaker open → backup provider"],
  ["Pre-flight", "< 10 ms", "OWASP LLM01 · PII scrub"],
];

/**
 * A lone change after a quiet spell fades in once. During a burst the digits update in place,
 * so the readout holds steady instead of strobing on every completion.
 */
function Tick({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef({ value, at: -Infinity });
  useLayoutEffect(() => {
    const prev = last.current;
    if (prev.value === value) return;
    const now = performance.now();
    last.current = { value, at: now };
    const el = ref.current;
    if (!el || now - prev.at < 600 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate({ opacity: [0.45, 1] }, { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }, [value]);
  return (
    <span ref={ref} className="inline-block">
      {value}
    </span>
  );
}

// Separators bind to the value before them, so a wrapped line never starts with "·".
const SEP = `${NBSP}· `;

type Kpi = {
  id: string;
  label: ReactNode;
  /** null until there is traffic to measure. */
  value: string | null;
  unit?: string;
  sub: string;
  tone?: Tone;
};

function KpiStrip() {
  const totals = useGateway((s) => s.totals);
  const groq = useGateway((s) => s.breakers.groq);
  const [now, setNow] = useState(() => Date.now());

  // The clock only matters for the probe countdown.
  useEffect(() => {
    if (groq.state !== "OPEN") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [groq.state]);

  const admitted = totals.requests - totals.blocked;
  const served = totals.t1 + totals.t2 + totals.coalesced;
  const measured = totals.latencies.length > 0;
  const p95 = percentile(totals.latencies, 95);
  const baseP95 = percentile(totals.baselineLatencies, 95);
  const spend = totals.baselineCostUsd > 0 ? totals.costUsd / totals.baselineCostUsd - 1 : 0;
  const cooldown = fmtCountdown(BREAKER_COOLDOWN_MS - (now - groq.since), BREAKER_COOLDOWN_MS);
  const groqTone: Tone = groq.state === "OPEN" ? "cinnabar" : groq.state === "HALF_OPEN" ? "amber" : "malachite";

  const cells: Kpi[] = [
    {
      id: "answered",
      // "Answered" means one thing on this page: served without an upstream call (T1 + T2 + coalesced).
      label: "Answered at gateway",
      value: admitted > 0 ? fmtPct(served / admitted, 0) : null,
      sub: `T1${NBSP}${fmtInt(totals.t1)}${SEP}T2${NBSP}${fmtInt(totals.t2)}${SEP}coalesced${NBSP}${fmtInt(totals.coalesced)}`,
    },
    {
      id: "requests",
      label: "Requests",
      value: fmtInt(totals.requests),
      sub: `${fmtInt(totals.blocked)}${NBSP}blocked at the edge`,
    },
    {
      id: "upstream",
      label: "Upstream calls",
      value: fmtInt(totals.upstream),
      sub: `of ${fmtInt(admitted)}${NBSP}admitted`,
    },
    {
      id: "ttft",
      label: (
        <>
          TTFT <span className="tok">p95</span>
        </>
      ),
      value: measured ? fmtMsValue(p95) : null,
      unit: "ms",
      sub: measured ? `vs ${fmtMsValue(baseP95)}${NBSP}ms direct` : "waiting for traffic",
    },
    {
      id: "spend",
      label: "Spend vs direct",
      value: totals.baselineCostUsd > 0 ? fmtSigned(spend, 1) : null,
      sub: totals.baselineCostUsd > 0 ? `${fmtUsd(totals.costUsd)}${NBSP}vs ${fmtUsd(totals.baselineCostUsd)}` : "no spend yet",
    },
    {
      id: "circuit",
      label: "Primary circuit",
      value: groq.state === "HALF_OPEN" ? "Half-open" : groq.state === "OPEN" ? "Open" : "Closed",
      tone: groqTone,
      sub: groq.state === "OPEN" ? `Groq${SEP}probe in${NBSP}${cooldown}` : `Groq${SEP}${plural(groq.trips, "trip")}`,
    },
  ];

  return (
    <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-line bg-line shadow-[0_24px_48px_-32px_rgb(var(--shadow-rgb)/calc(0.8*var(--shade)))] md:grid-cols-3 xl:grid-cols-[1.4fr_repeat(5,minmax(0,1fr))]">
      {cells.map((cell, i) => {
        const lead = i === 0;
        return (
          <div
            key={cell.id}
            className={cn(
              "flex min-w-0 flex-col gap-3 bg-bg-1 px-4 py-5 md:px-5",
              // two-column phones: the lead and the circuit span the row so no cell is left orphaned
              (lead || i === cells.length - 1) && "col-span-2 md:col-span-1",
            )}
          >
            <span className="flex items-center gap-2">
              {cell.tone ? <Glyph tone={cell.tone} size={7} /> : null}
              <Micro>{cell.label}</Micro>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className={cn("t-figure leading-[1.05] tabular-nums", lead ? "text-[40px]" : "text-[28px]", cell.value === null ? "text-ink-3" : "text-ink-1")}>
                {cell.value === null ? (
                  <>
                    <span aria-hidden>—</span>
                    <span className="sr-only">not measured yet</span>
                  </>
                ) : (
                  <Tick value={cell.value} />
                )}
              </span>
              {cell.unit && cell.value !== null ? <span className="t-data text-[12px] text-ink-3">{cell.unit}</span> : null}
            </span>
            <span className="mt-auto line-clamp-2 text-[12.5px] leading-snug text-ink-3 text-pretty">{cell.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Hero() {
  return (
    <section id="corridor" className="relative pt-36 md:pt-40 lg:pt-32">
      <div className="mx-auto max-w-[1360px] px-4 md:px-8">
        {/* One grid so phones read headline → corridor → readout → spec sheet. */}
        <div className="grid grid-cols-1 gap-y-14 lg:grid-cols-12 lg:gap-x-10 lg:gap-y-16">
          <div className="lg:col-span-7">
            <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px] text-ink-2">
              <span className="whitespace-nowrap">OpenAI-compatible gateway</span>
              <code className="t-data whitespace-nowrap text-[12.5px] text-ink-3">/api/v1/chat/completions</code>
            </p>
            <h1 className="t-display mt-7 text-[46px] text-ink-1 sm:text-[60px] xl:text-[76px]">
              Fifty agents.
              <br />
              <span className="text-ink-3">One upstream call.</span>
            </h1>
            <p className="mt-7 max-w-[56ch] text-[16.5px] leading-[1.6] text-ink-2">
              Fifty agents asking the same question cost one upstream call: a singleflight lock holds the other{" "}
              <span className="whitespace-nowrap">forty-nine</span> until the first answer returns.{" "}
              <span className="whitespace-nowrap">Caveman-Lite</span> sits between your agents and their model
              providers, answers repeats from cache, refuses hostile prompts, and sends what is left to the cheapest
              model that is statistically as good.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13.5px]">
              <a href="#playground" className="group -my-2.5 inline-flex items-center gap-1.5 py-2.5 text-ink-1">
                Call it with the OpenAI SDK
                <ArrowDown className="size-3.5 text-ink-3 transition-transform duration-200 group-hover:translate-y-0.5" />
              </a>
              <a
                href="https://github.com/Sohail-5678/caveman-lite"
                target="_blank"
                rel="noreferrer"
                className="group -my-2.5 inline-flex items-center gap-1.5 py-2.5 text-ink-3 transition-colors hover:text-ink-1"
              >
                Read the source
                <ArrowUpRight className="size-3.5 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </a>
            </div>
          </div>

          <aside className="order-last lg:order-none lg:col-span-5 lg:pl-6" aria-label="Specifications">
            <div className="flex items-center justify-between border-b border-line-2 pb-3">
              <Label>Spec sheet</Label>
              <Micro>Design targets</Micro>
            </div>
            <dl>
              {SPEC.map(([label, value, note]) => (
                <div key={label} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 border-b border-line py-[11px] sm:grid-cols-[150px_96px_1fr]">
                  <dt className="text-[13.5px] text-ink-2">{label}</dt>
                  <dd className="t-data text-right text-[13px] text-ink-1 sm:text-left">{value}</dd>
                  <dd className="col-span-2 text-[12.5px] text-ink-3 sm:col-span-1">{note}</dd>
                </div>
              ))}
            </dl>
          </aside>

          <div className="lg:col-span-12">
            <div className="mb-7 flex items-center gap-4">
              <span className="t-data text-[12px] text-ink-2">01</span>
              <span className="h-px flex-1 bg-line-2" />
              <Micro>Live pipeline</Micro>
            </div>
            <GatewayTopologyMap />
            <KpiStrip />
          </div>
        </div>
      </div>
    </section>
  );
}
