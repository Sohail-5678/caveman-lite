"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion, type Transition } from "framer-motion";
import {
  bootstrapDeltaCI,
  downgradeVerdict,
  mcnemar,
  pairsFromContingency,
  paretoFrontier,
  type BootstrapCI,
  type DowngradeVerdict,
  type McNemarResult,
} from "@/lib/evals/pareto-optimizer";
import {
  AGENT_NODES,
  baselineAccuracy,
  costPerMillion,
  EVAL_MODELS,
  nodeP95,
  SHADOW_SAMPLE,
  type AgentNode,
  type EvalModel,
} from "@/lib/workload-traces";
import { getController, useGateway } from "@/lib/gateway/use-gateway";
import type { Tone } from "@/lib/gateway/choreography";
import { cn, fmtInt, fmtPct, fmtPp, fmtSigned, fmtUsd } from "@/lib/format";
import { Chip, Glyph, Label, Micro, Reveal, SectionHeader } from "./ui";

/* ── analysis ────────────────────────────────────────────────────────────── */

interface Candidate {
  model: EvalModel;
  cost: number;
  accuracy: number;
  p95: number;
  isBaseline: boolean;
  stats: McNemarResult | null;
  verdict: DowngradeVerdict | null;
}

function analyse(node: AgentNode) {
  const baseAcc = baselineAccuracy(node);
  const candidates: Candidate[] = EVAL_MODELS.map((model) => {
    const isBaseline = model.id === node.baseline;
    const table = node.tables[model.id];
    const stats = table ? mcnemar(table) : null;
    return {
      model,
      cost: costPerMillion(model, node),
      accuracy: isBaseline ? baseAcc : stats ? stats.accB : 0,
      p95: nodeP95(model, node),
      isBaseline,
      stats,
      verdict: stats ? downgradeVerdict(stats) : null,
    };
  });
  const baseline = candidates.find((c) => c.isBaseline)!;
  const frontier = paretoFrontier(candidates.map((c) => ({ id: c.model.id, cost: c.cost, accuracy: c.accuracy })));
  const frontierIds = new Set(frontier.map((f) => f.id));
  const safe = candidates
    .filter((c) => !c.isBaseline && c.cost < baseline.cost && c.verdict === "STATISTICALLY_SAFE_TO_DOWNGRADE")
    .sort((x, y) => x.cost - y.cost);
  const recommended = safe[0] ?? null;
  return { candidates, baseline, frontier, frontierIds, recommended };
}

/** Same resampling everywhere, so a node card and the replay panel print the same interval. */
const deltaCI = (stats: McNemarResult, node: AgentNode): BootstrapCI => {
  const pairs = pairsFromContingency(stats, 11 + node.index);
  return bootstrapDeltaCI(pairs.a, pairs.b, { iterations: 2000, seed: 7 });
};

/** Only a significant regression is a signal; every other verdict is a plain reading. */
const VERDICT: Record<DowngradeVerdict, { label: string; tone?: Tone }> = {
  STATISTICALLY_SAFE_TO_DOWNGRADE: { label: "Safe to downgrade" },
  SIGNIFICANT_REGRESSION: { label: "Significant regression", tone: "cinnabar" },
  UNDERPOWERED: { label: "Inconclusive" },
  CANDIDATE_BETTER: { label: "Candidate better" },
};

const fmtP = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));
/** fmtPp without the unit, for intervals that carry it once: [−3.6, +2.0] pp. */
const ppValue = (delta: number) => fmtPp(delta).replace(/\s?pp$/, "");
const saving = (c: Candidate, baseline: Candidate) => 1 - c.cost / baseline.cost;
/** The verdict rule's margin, as a share. */
const RULE = 0.01;

const EASE = [0.23, 1, 0.32, 1] as const;

/** aria-disabled keeps a settled button focusable; these utilities stand in for .btn:disabled. */
const HELD = "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:active:transform-none";

/** Model names never break inside: "Claude Sonnet 4.5", not "Claude Sonnet / 4.5". */
const Name = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn("whitespace-nowrap", className)}>{children}</span>
);

/** Content box of an element, in CSS px. Null until the first measurement, so server and client agree. */
function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ w: number; h: number; family: string; phone: boolean } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      const family = getComputedStyle(el).fontFamily;
      const phone = window.matchMedia("(max-width: 639.98px)").matches;
      setBox((b) => (b && b.w === w && b.h === h && b.family === family && b.phone === phone ? b : { w, h, family, phone }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/* ── chart ───────────────────────────────────────────────────────────────── */

const M = { l: 40, r: 14, t: 30, b: 46 };
const LABEL_PX = 11.5;
/** Marks closer than NEAR px are dodged sideways by DODGE px each, with a hairline back to the true value. */
const NEAR = 10;
const DODGE = 7;
/** Pointer reach: a 24px target for a mouse, a fingertip for touch; the nearest mark inside it wins. */
const PICK = 12;
const PICK_TOUCH = 22;

type Box = { x0: number; y0: number; x1: number; y1: number };
type Anchor = "start" | "end" | "middle";
type Slot = { dx: number; dy: number; anchor: Anchor };
type Spot = { x: number; y: number; anchor: Anchor };

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

const S = {
  right: { dx: 12, dy: 4, anchor: "start" },
  left: { dx: -12, dy: 4, anchor: "end" },
  above: { dx: 0, dy: -12, anchor: "middle" },
  below: { dx: 0, dy: 21, anchor: "middle" },
  aboveRight: { dx: 9, dy: -9, anchor: "start" },
  aboveLeft: { dx: -9, dy: -9, anchor: "end" },
  belowRight: { dx: 9, dy: 18, anchor: "start" },
  belowLeft: { dx: -9, dy: 18, anchor: "end" },
} satisfies Record<string, Slot>;

// The stair leaves a frontier point to the right and arrives from below, so its open quadrant is up and left.
// Last resort before hiding: one line further out, still flush with the mark.
const FAR: Slot[] = [
  { dx: -3, dy: -22, anchor: "end" },
  { dx: 3, dy: -22, anchor: "start" },
  { dx: -3, dy: 31, anchor: "end" },
  { dx: 3, dy: 31, anchor: "start" },
];
const FRONTIER_SLOTS: Slot[] = [S.aboveLeft, S.left, S.above, S.aboveRight, S.belowRight, S.right, S.belowLeft, S.below, ...FAR];
const OTHER_SLOTS: Slot[] = [S.right, S.left, S.below, S.above, S.belowRight, S.aboveRight, S.belowLeft, S.aboveLeft, ...FAR];

let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, family: string) {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx || !family) return text.length * 6.3;
  measureCtx.font = `${LABEL_PX}px ${family}`;
  return measureCtx.measureText(text).width;
}

/** Tier marks share the glyph language: fast tier ◆, frontier ▲. */
function markPath(tier: EvalModel["tier"], r: number) {
  return tier === "fast"
    ? `M0,${-r}L${r},0L0,${r}L${-r},0Z`
    : `M0,${-r * 1.08}L${r * 0.98},${r * 0.62}L${-r * 0.98},${r * 0.62}Z`;
}
const tierColor = (tier: EvalModel["tier"]) => (tier === "fast" ? "var(--color-glacier-chart)" : "var(--color-amber-chart)");

/** Filled on the Pareto frontier, an outline once something cheaper is at least as good. */
function TierKey({ tier, dominated = false }: { tier: EvalModel["tier"]; dominated?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="-6 -6 12 12" aria-hidden className="shrink-0">
      <path
        d={markPath(tier, dominated ? 4.4 : 5)}
        fill={dominated ? "none" : tierColor(tier)}
        stroke={dominated ? tierColor(tier) : "none"}
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
    </svg>
  );
}

const labelText = (c: Candidate) => c.model.label + (c.isBaseline ? " · current" : "");

/**
 * Marks closer than NEAR px move apart along x by DODGE px each, the cheaper one to the left (ties keep model order).
 * The result depends only on the projected positions, so it never jitters between renders.
 */
function dodge(points: { x: number; y: number }[]) {
  const off = points.map(() => 0);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) >= NEAR) continue;
      const s = a.x <= b.x ? 1 : -1;
      off[i] -= s * DODGE;
      off[j] += s * DODGE;
    }
  }
  return off.map((o) => Math.max(-DODGE, Math.min(DODGE, o)));
}

function Chart({
  node,
  analysis,
  selected,
  onSelect,
}: {
  node: AgentNode;
  analysis: ReturnType<typeof analyse>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [ref, box] = useBox<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const [focusRing, setFocusRing] = useState<string | null>(null);
  const [, setFontsReady] = useState(false);
  const reduce = useReducedMotion();
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);

  // Points glide between agent nodes; a resize alone repositions them at once.
  const lastNode = useRef(node.id);
  const morph = lastNode.current !== node.id && !reduce;
  useEffect(() => {
    lastNode.current = node.id;
  });
  const move: Transition = morph ? { type: "spring", duration: 0.6, bounce: 0.12 } : { duration: 0 };

  return (
    <div ref={ref} className="absolute inset-0">
      {box && box.w > 0 && box.h > 0 ? (
        <Plot
          W={box.w}
          H={box.h}
          family={box.family}
          phone={box.phone}
          node={node}
          analysis={analysis}
          selected={selected}
          onSelect={onSelect}
          hover={hover}
          setHover={setHover}
          focusRing={focusRing}
          setFocusRing={setFocusRing}
          move={move}
          morph={morph}
        />
      ) : null}
    </div>
  );
}

function Plot({
  W,
  H,
  family,
  phone,
  node,
  analysis,
  selected,
  onSelect,
  hover,
  setHover,
  focusRing,
  setFocusRing,
  move,
  morph,
}: {
  W: number;
  H: number;
  family: string;
  phone: boolean;
  node: AgentNode;
  analysis: ReturnType<typeof analyse>;
  selected: string | null;
  onSelect: (id: string) => void;
  hover: string | null;
  setHover: (id: string | null) => void;
  focusRing: string | null;
  setFocusRing: (id: string | null) => void;
  move: Transition;
  morph: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pointer = useRef("mouse");
  const plotW = W - M.l - M.r;
  const plotH = H - M.t - M.b;

  // Domain fitted to this node's points, with a fixed pixel margin above and below so labels have room at any height.
  const costs = analysis.candidates.map((c) => c.cost);
  const accs = analysis.candidates.map((c) => c.accuracy);
  const X0 = Math.log10(Math.min(...costs) / 1.9);
  const X1 = Math.log10(Math.max(...costs) * 1.9);
  const PAD = 28;
  const lo = Math.min(...accs);
  const hi = Math.max(...accs);
  const dataSpan = Math.max(hi - lo, 0.02);
  const padV = (dataSpan * PAD) / Math.max(plotH - 2 * PAD, 1);
  const y0 = (lo + hi) / 2 - dataSpan / 2 - padV;
  const y1 = (lo + hi) / 2 + dataSpan / 2 + padV;
  const sx = (cost: number) => M.l + ((Math.log10(cost) - X0) / (X1 - X0)) * plotW;
  const sy = (acc: number) => M.t + (1 - (acc - y0) / (y1 - y0)) * plotH;

  const span = y1 - y0;
  const step = [0.01, 0.02, 0.05, 0.1].find((s) => (s / span) * plotH >= 48) ?? 0.1;
  const yTicks: number[] = [];
  for (let v = Math.ceil(y0 / step - 1e-9) * step; v <= Math.min(1, y1) + 1e-9; v += step) yTicks.push(Number(v.toFixed(2)));
  const inX = (t: number) => Math.log10(t) > X0 && Math.log10(t) < X1;
  const decades = [10, 100, 1_000, 10_000, 100_000].filter(inX);
  const halves = [30, 100, 300, 1_000, 3_000, 10_000, 30_000].filter(inX);
  const halvesFit = halves.length < 2 || sx(halves[1]) - sx(halves[0]) >= 48;
  const xTicks = phone || !halvesFit ? decades : halves;

  // Pareto frontier as a staircase through the non-dominated points
  const f = [...analysis.frontier].sort((a, b) => a.cost - b.cost);
  let stair = "";
  f.forEach((p, i) => {
    stair += i === 0 ? `M${sx(p.cost)},${sy(p.accuracy)}` : ` H${sx(p.cost)} V${sy(p.accuracy)}`;
  });
  const yBase = sy(analysis.baseline.accuracy);

  // Where each mark is drawn: its true position, dodged sideways when another mark would cover it.
  const truth = analysis.candidates.map((c) => ({ x: sx(c.cost), y: sy(c.accuracy) }));
  const off = dodge(truth);
  const at = truth.map((t, i) => ({ x: t.x + off[i], y: t.y, tx: t.x, off: off[i] }));
  const atOf = (c: Candidate) => at[analysis.candidates.indexOf(c)];
  const front = (c: Candidate) => analysis.frontierIds.has(c.model.id);

  // Greedy label placement. Marks, stair segments and the reference rule are obstacles, so no label is struck through.
  const labels = new Map<string, Slot | null>();
  const fallback = new Map<string, Slot>();
  const ruleText = `current ${fmtPct(analysis.baseline.accuracy)}`;
  let rule: Spot | null = null;
  {
    const ringed = (c: Candidate) => c.isBaseline || c.model.id === selected;
    const marks: Box[] = analysis.candidates.map((c, i) => {
      const r = ringed(c) ? 12 : 7;
      return { x0: at[i].x - r, y0: at[i].y - r, x1: at[i].x + r, y1: at[i].y + r };
    });
    const lines: Box[] = [];
    for (let i = 1; i < f.length; i++) {
      const xa = sx(f[i - 1].cost);
      const ya = sy(f[i - 1].accuracy);
      const xb = sx(f[i].cost);
      const yb = sy(f[i].accuracy);
      lines.push({ x0: xa, y0: ya - 4, x1: xb, y1: ya + 4 });
      lines.push({ x0: xb - 4, y0: Math.min(ya, yb), x1: xb + 4, y1: Math.max(ya, yb) });
    }
    lines.push({ x0: M.l, y0: yBase - 3, x1: W - M.r, y1: yBase + 3 });

    const placed: Box[] = [];
    const order = [...analysis.candidates].sort(
      (a, b) =>
        Number(b.isBaseline) - Number(a.isBaseline) ||
        Number(b.model.id === selected) - Number(a.model.id === selected) ||
        Number(front(b)) - Number(front(a)) ||
        b.accuracy - a.accuracy,
    );
    for (const c of order) {
      const own = analysis.candidates.indexOf(c);
      const { x: px, y: py, off: shift } = at[own];
      const w = textWidth(labelText(c), family);
      const grow = ringed(c) ? 5 : 0;
      // a dodged mark is named on the side it moved to, so neither name can be read as its neighbour's
      const side = Math.sign(shift);
      const base = front(c) ? FRONTIER_SLOTS : OTHER_SLOTS;
      const preferred = side ? [...base].sort((a, b) => Number(b.dx * side > 0) - Number(a.dx * side > 0)) : base;
      const slots = preferred.map((s) => ({
        ...s,
        dx: s.dx + Math.sign(s.dx) * grow,
        dy: s.dy === 4 ? s.dy : s.dy + Math.sign(s.dy) * grow,
      }));
      const boxOf = (s: Slot): Box => {
        const x0 = s.anchor === "start" ? px + s.dx : s.anchor === "end" ? px + s.dx - w : px - w / 2;
        return { x0: x0 - 2, y0: py + s.dy - 10, x1: x0 + w + 2, y1: py + s.dy + 3 };
      };
      const inside = (b: Box) => b.x0 >= M.l + 2 && b.x1 <= W - M.r && b.y0 >= M.t - 4 && b.y1 <= H - M.b - 2;
      fallback.set(c.model.id, slots.find((s) => inside(boxOf(s))) ?? slots[0]);
      // On a phone only the reference, the selection, the frontier and dodged pairs carry names; the rest show on hover.
      if (phone && !c.isBaseline && c.model.id !== selected && !front(c) && !shift) {
        labels.set(c.model.id, null);
        continue;
      }
      // a slot already clears its own mark, so only other marks count
      const clear = (b: Box, strict: boolean) =>
        inside(b) && !marks.some((m, j) => j !== own && overlaps(m, b)) && !placed.some((p) => overlaps(p, b)) && !(strict && lines.some((l) => overlaps(l, b)));
      // a dodged mark always keeps a name: it may sit on a rule before it is dropped
      const slot = slots.find((s) => clear(boxOf(s), true)) ?? (shift ? slots.find((s) => clear(boxOf(s), false)) : undefined);
      if (slot) placed.push(boxOf(slot));
      labels.set(c.model.id, slot ?? null);
    }

    // The reference rule is named at whichever end is clear; model names come first, so on a crowded phone it yields.
    const ruleW = ruleText.length * 6.3;
    const ruleBox = (r: Spot): Box => {
      const x0 = r.anchor === "start" ? r.x : r.x - ruleW;
      return { x0: x0 - 2, y0: r.y - 9, x1: x0 + ruleW + 2, y1: r.y + 3 };
    };
    const spots: Spot[] = [
      { x: M.l + 4, y: yBase - 5, anchor: "start" },
      { x: W - M.r - 4, y: yBase - 5, anchor: "end" },
      { x: M.l + 4, y: yBase + 13, anchor: "start" },
      { x: W - M.r - 4, y: yBase + 13, anchor: "end" },
    ];
    const stairs = lines.slice(0, -1);
    rule = spots.find((r) => [...marks, ...stairs, ...placed].every((b) => !overlaps(b, ruleBox(r)))) ?? null;
  }

  const hovered = analysis.candidates.find((c) => c.model.id === hover) ?? null;
  const TIP_W = 220;

  /** The nearest mark within reach of the pointer, so overlapping targets split down the middle instead of stacking. */
  const nearest = (clientX: number, clientY: number, reach: number, selectable: boolean) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return null;
    let best: string | null = null;
    let bestD = reach;
    for (let i = 0; i < at.length; i++) {
      const c = analysis.candidates[i];
      if (selectable && c.isBaseline) continue;
      const d = Math.hypot(at[i].x - (clientX - r.left), at[i].y - (clientY - r.top));
      if (d <= bestD) {
        bestD = d;
        best = c.model.id;
      }
    }
    return best;
  };
  const pickable = hovered && !hovered.isBaseline;
  // keyboard order follows the x axis, cheapest first
  const byX = [...analysis.candidates].sort((a, b) => atOf(a).x - atOf(b).x);
  // outlines draw last, so a hollow mark is never covered by a filled one
  const byLayer = [...analysis.candidates].sort((a, b) => Number(!front(a)) - Number(!front(b)));

  return (
    <>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block"
        role="group"
        aria-label={`Pass rate versus cost for ${node.label}`}
      >
        {/* grid */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={sy(t)} y2={sy(t)} stroke="var(--color-line)" shapeRendering="crispEdges" />
            <text x={M.l - 8} y={sy(t) + 3.5} textAnchor="end" className="fill-[var(--color-ink-3)] font-mono text-[10.5px]">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={M.t} y2={H - M.b} stroke="rgb(236 233 225 / 0.05)" shapeRendering="crispEdges" />
            <text x={sx(t)} y={H - M.b + 17} textAnchor="middle" className="fill-[var(--color-ink-3)] font-mono text-[10.5px]">
              {t >= 1000 ? `$${t / 1000}k` : `$${t}`}
            </text>
          </g>
        ))}
        <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--color-line-3)" shapeRendering="crispEdges" />
        <text x={W - M.r} y={H - 8} textAnchor="end" className="fill-[var(--color-ink-3)] font-mono text-[11px]">
          cost per 1M requests, log scale →
        </text>
        <text x={M.l} y={M.t - 14} className="fill-[var(--color-ink-3)] font-mono text-[11px]">
          ↑ eval pass rate, n = {SHADOW_SAMPLE}
        </text>

        {/* current model's pass rate, the bar every Δ is read against */}
        <line x1={M.l} x2={W - M.r} y1={yBase} y2={yBase} stroke="rgb(236 233 225 / 0.16)" shapeRendering="crispEdges" />
        <motion.path
          d={stair}
          fill="none"
          stroke="rgb(236 233 225 / 0.42)"
          strokeWidth={1.5}
          initial={false}
          animate={{ d: stair }}
          transition={morph ? { duration: 0.5, ease: EASE } : { duration: 0 }}
        />

        {/* marks, in three passes: knockouts, then dodge hairlines, then fills, so a hairline shows only in the gap it explains */}
        {byLayer.map((c) => {
          const id = c.model.id;
          const p = atOf(c);
          return (
            <motion.g key={id} initial={false} animate={{ x: p.x, y: p.y }} transition={move}>
              {c.isBaseline ? <circle r={11} fill="none" stroke="var(--color-ink-2)" strokeWidth={1.2} /> : null}
              {id === selected ? <circle r={11} fill="none" stroke="var(--color-ink-1)" strokeWidth={1.5} /> : null}
              {focusRing === id ? <circle r={15} fill="none" stroke="var(--color-ink-1)" strokeWidth={1} strokeDasharray="2 2" /> : null}
              <path d={markPath(c.model.tier, 6)} fill="var(--color-bg-1)" stroke="var(--color-bg-1)" strokeWidth={front(c) ? 2.5 : 3.5} strokeLinejoin="round" />
            </motion.g>
          );
        })}
        {analysis.candidates.map((c, i) =>
          at[i].off ? (
            <motion.g key={c.model.id} initial={false} animate={{ x: at[i].tx, y: at[i].y }} transition={move} aria-hidden>
              <line x2={at[i].off} stroke="var(--color-ink-3)" strokeWidth={1} />
              <circle r={1.6} fill="var(--color-ink-2)" />
            </motion.g>
          ) : null,
        )}
        {byLayer.map((c) => {
          const p = atOf(c);
          const filled = front(c);
          return (
            <motion.g key={c.model.id} initial={false} animate={{ x: p.x, y: p.y }} transition={move}>
              <path
                d={markPath(c.model.tier, filled ? 6 : 5.4)}
                fill={filled ? tierColor(c.model.tier) : "var(--color-bg-1)"}
                stroke={filled ? "none" : tierColor(c.model.tier)}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            </motion.g>
          );
        })}

        {/* names sit above every mark and line, knocked out of the strokes beneath them */}
        <g pointerEvents="none">
          {rule ? (
            <text
              x={rule.x}
              y={rule.y}
              textAnchor={rule.anchor}
              className="fill-[var(--color-ink-3)] font-mono text-[10.5px]"
              stroke="var(--color-bg-1)"
              strokeWidth={4}
              strokeLinejoin="round"
              paintOrder="stroke"
            >
              {ruleText}
            </text>
          ) : null}
          {analysis.candidates.map((c, i) => {
            const id = c.model.id;
            const isSel = id === selected;
            // the reference model is always named; a crowded label returns on selection, hover or focus
            const slot = labels.get(id) ?? (c.isBaseline || isSel || hover === id ? fallback.get(id) : null);
            if (!slot) return null;
            return (
              <motion.g key={id} initial={false} animate={{ x: at[i].x, y: at[i].y }} transition={move}>
                <text
                  x={slot.dx}
                  y={slot.dy}
                  textAnchor={slot.anchor}
                  fontSize={LABEL_PX}
                  fill={isSel ? "var(--color-ink-1)" : c.isBaseline ? "var(--color-ink-2)" : "var(--color-ink-3)"}
                  stroke="var(--color-bg-1)"
                  strokeWidth={4}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                >
                  {labelText(c)}
                </text>
              </motion.g>
            );
          })}
        </g>

        {/* keyboard and assistive-tech targets, one per mark at its drawn position; pointers go through the layer below */}
        {byX.map((c) => {
          const id = c.model.id;
          const p = atOf(c);
          return (
            <circle
              key={id}
              cx={p.x}
              cy={p.y}
              r={PICK}
              fill="transparent"
              pointerEvents="none"
              className="outline-none"
              role={c.isBaseline ? "img" : "button"}
              tabIndex={c.isBaseline ? undefined : 0}
              aria-pressed={c.isBaseline ? undefined : id === selected}
              aria-label={`${labelText(c)}: ${fmtPct(c.accuracy)} pass rate, ${fmtUsd(c.cost)} per million requests`}
              onClick={() => !c.isBaseline && onSelect(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!c.isBaseline) onSelect(id);
                }
              }}
              onFocus={(e) => {
                setHover(id);
                if (e.currentTarget.matches(":focus-visible")) setFocusRing(id);
              }}
              onBlur={() => {
                setHover(null);
                setFocusRing(null);
              }}
            />
          );
        })}
        <rect
          width={W}
          height={H}
          fill="transparent"
          aria-hidden
          style={{ cursor: pickable ? "pointer" : "default", touchAction: "manipulation" }}
          onPointerDown={(e) => {
            pointer.current = e.pointerType;
          }}
          onPointerMove={(e) => {
            if (e.pointerType === "mouse") setHover(nearest(e.clientX, e.clientY, PICK, false));
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setHover(null);
          }}
          onClick={(e) => {
            const id = nearest(e.clientX, e.clientY, pointer.current === "mouse" ? PICK : PICK_TOUCH, true);
            if (id) onSelect(id);
          }}
        />
      </svg>
      {hovered ? (
        <div
          className="glass pointer-events-none absolute z-10 rounded-lg px-3 py-2.5"
          style={{
            width: TIP_W,
            // a dodged mark's card opens away from its neighbour
            left: Math.max(4, Math.min(W - TIP_W - 4, (atOf(hovered).off ? atOf(hovered).off < 0 : atOf(hovered).x > W * 0.55) ? atOf(hovered).x - 18 - TIP_W : atOf(hovered).x + 18)),
            top: Math.max(64, Math.min(H - 64, atOf(hovered).y)),
            transform: "translateY(-50%)",
          }}
        >
          <p className="text-[12.5px] text-ink-1">{hovered.model.label}</p>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            {hovered.model.vendor} · {hovered.model.tier === "fast" ? "fast tier" : "frontier"}
            {front(hovered) ? "" : " · dominated"}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
            <dt className="text-ink-3">Pass rate</dt>
            <dd className="t-data text-right text-ink-1">{fmtPct(hovered.accuracy)}</dd>
            <dt className="text-ink-3">vs current</dt>
            <dd className="t-data whitespace-nowrap text-right text-ink-1">{hovered.isBaseline ? "—" : fmtPp(hovered.accuracy - analysis.baseline.accuracy)}</dd>
            <dt className="text-ink-3">$ / 1M req</dt>
            <dd className="t-data text-right text-ink-1">{fmtUsd(hovered.cost)}</dd>
            <dt className="text-ink-3">
              TTFT <span className="tok">p95</span>
            </dt>
            <dd className="t-data whitespace-nowrap text-right text-ink-1">{fmtInt(hovered.p95)}&#8239;ms</dd>
          </dl>
        </div>
      ) : null}
    </>
  );
}

/* ── replay matrix ───────────────────────────────────────────────────────── */

/**
 * The verdict tests the point estimate, so the ±1 pp band is drawn on the point's row only.
 * The 95% CI sits on its own row underneath: it is evidence about power, not the rule.
 */
function ForestPlot({ low, high, delta, tone }: { low: number; high: number; delta: number; tone?: Tone }) {
  const [ref, box] = useBox<HTMLDivElement>();
  const reduce = useReducedMotion();
  const w = box?.w ?? 220;
  const maxPp = Math.round(Math.max(Math.abs(low), Math.abs(high), Math.abs(delta)) * 1e6) / 1e4;
  // the axis widens until both interval labels fit outside their caps
  const ROOM = 32;
  let spanPp = Math.max(5, Math.ceil(maxPp + 1));
  while (spanPp < 50 && (spanPp - maxPp) * (w / (2 * spanPp)) < ROOM) spanPp++;
  const pos = (v: number) => ((Math.max(-spanPp, Math.min(spanPp, v * 100)) + spanPp) / (2 * spanPp)) * 100;
  const pxPerPp = w / (2 * spanPp);
  const every = [2, 4, 10, 20, 50].find((s) => s * pxPerPp >= 30) ?? 50;
  const ticks: number[] = [];
  for (let v = -Math.floor(spanPp / 2) * 2; v <= spanPp; v += 2) ticks.push(v);
  const t: Transition = reduce ? { duration: 0 } : { duration: 0.45, ease: EASE };
  const wide = low < -RULE || high > RULE;

  return (
    <figure>
      <figcaption className="text-[11.5px] leading-snug text-ink-3">
        Verdict rule: <Name>|Δ| &lt; 1&#8239;pp</Name> and{" "}
        <Name>
          <i>p</i> &gt; 0.05
        </Name>
      </figcaption>
      <div className="mt-2.5 flex" aria-hidden>
        <div className="t-data relative w-[46px] shrink-0 text-[10.5px] leading-none text-ink-3">
          <span className="absolute left-0 top-[4px]">Δ</span>
          <span className="absolute left-0 top-[27px] whitespace-nowrap">95% CI</span>
        </div>
        <div ref={ref} className="relative h-[70px] min-w-0 flex-1">
          {/* rule row: the band and the point estimate it tests */}
          <div
            className="absolute top-0 h-[18px] border-x border-dashed border-[rgb(236_233_225/0.24)] bg-[rgb(236_233_225/0.06)]"
            style={{ left: `${pos(-RULE)}%`, width: `${pos(RULE) - pos(-RULE)}%` }}
          />
          <div className="absolute -top-[3px] h-[47px] w-px bg-[rgb(236_233_225/0.24)]" style={{ left: `${pos(0)}%` }} />
          <motion.span
            className="absolute top-[9px] flex -translate-x-1/2 -translate-y-1/2 items-center justify-center"
            initial={false}
            animate={{ left: `${pos(delta)}%` }}
            transition={t}
          >
            {tone ? (
              <Glyph tone={tone} size={9} />
            ) : (
              <span className="block size-[9px] rounded-full bg-ink-1 shadow-[0_0_0_1.5px_var(--color-bg-1)]" />
            )}
          </motion.span>

          {/* interval row */}
          <motion.div
            className="absolute top-[26.5px] h-[9px] border-x border-ink-1 before:absolute before:inset-x-0 before:top-[3.75px] before:h-[1.5px] before:bg-ink-1"
            initial={false}
            animate={{ left: `${pos(low)}%`, width: `${pos(high) - pos(low)}%` }}
            transition={t}
          />
          <motion.span
            className="t-data absolute top-[26.5px] -translate-x-full whitespace-nowrap pr-[6px] text-[10.5px] leading-[9px] text-ink-2"
            initial={false}
            animate={{ left: `${pos(low)}%` }}
            transition={t}
          >
            {ppValue(low)}
          </motion.span>
          <motion.span
            className="t-data absolute top-[26.5px] whitespace-nowrap pl-[6px] text-[10.5px] leading-[9px] text-ink-2"
            initial={false}
            animate={{ left: `${pos(high)}%` }}
            transition={t}
          >
            {ppValue(high)}
          </motion.span>

          <div className="absolute inset-x-0 top-[48px] h-px bg-line-2" />
          {ticks.map((v) => {
            const labelled = v % every === 0;
            return (
              <div key={v}>
                <span
                  className={cn("absolute top-[48px] w-px bg-line-3", labelled ? "h-[5px]" : "h-[3px]")}
                  style={{ left: `${pos(v / 100)}%` }}
                />
                {labelled ? (
                  <span
                    className="t-data absolute top-[58px] -translate-x-1/2 whitespace-nowrap text-[10.5px] leading-none text-ink-3"
                    style={{ left: `${pos(v / 100)}%` }}
                  >
                    {v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-3" aria-hidden>
        Δ pass rate, candidate − current (pp)
      </p>
      {wide ? (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-2 [text-wrap:pretty]">
          CI wider than the band: underpowered for a <Name>±1&#8239;pp</Name> equivalence claim.
        </p>
      ) : null}
    </figure>
  );
}

function ReplayMatrix({ node, analysis, candidate }: { node: AgentNode; analysis: ReturnType<typeof analyse>; candidate: Candidate }) {
  const policy = useGateway((s) => s.policy);
  const stats = candidate.stats!;
  const ci = useMemo(() => deltaCI(stats, node), [stats, node]);
  const verdict = VERDICT[candidate.verdict!];
  const cut = saving(candidate, analysis.baseline);
  const speedup = analysis.baseline.p95 / candidate.p95;
  const applied = policy[node.id] === candidate.model.id;
  const canApply = candidate.verdict === "STATISTICALLY_SAFE_TO_DOWNGRADE" && cut > 0;
  const held = !canApply || applied;
  const [said, setSaid] = useState("");

  const cell = (v: number, caption?: string) => (
    <td className={cn("border border-line-2 px-1 py-2.5 align-middle", caption ? "bg-[rgb(236_233_225/0.05)]" : "")}>
      <span className={cn("t-figure block text-[20px]", caption ? "text-ink-1" : "text-ink-2")}>{v}</span>
      {caption ? <span className="mt-1.5 block whitespace-nowrap text-[10.5px] leading-none text-ink-2">{caption}</span> : null}
    </td>
  );
  const total = (v: ReactNode) => <td className="t-data whitespace-nowrap px-1 py-2 text-[11px] text-ink-3">{v}</td>;

  return (
    <div className="flex h-full flex-col md:grid md:grid-cols-2 md:gap-x-8 lg:flex lg:gap-x-0">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Micro>Shadow replay</Micro>
          <Chip tone={verdict.tone}>{verdict.label}</Chip>
        </div>
        <Label className="mt-3 block text-[15px] leading-snug">
          <Name>{analysis.baseline.model.label}</Name> <span className="text-ink-4">→</span> <Name>{candidate.model.label}</Name>
        </Label>
        <p className="mt-1 text-[12.5px] leading-snug text-ink-3">
          {SHADOW_SAMPLE}&nbsp;production traces replayed on both, graded by the same rubric.
        </p>

        <table className="mt-5 w-full table-fixed border-collapse text-center">
          <caption className="sr-only">
            Paired outcomes, current model by candidate, over {SHADOW_SAMPLE} traces
          </caption>
          <colgroup>
            <col className="w-16" />
            <col />
            <col />
            <col className="w-12" />
          </colgroup>
          <thead>
            <tr>
              <td />
              <th scope="colgroup" colSpan={2} className="pb-2 font-normal">
                <Micro>Candidate</Micro>
              </th>
              <td />
            </tr>
            <tr>
              <th scope="col" className="pb-1.5 text-left font-normal">
                <Micro>Current</Micro>
              </th>
              <th scope="col" className="pb-1.5 font-normal">
                <Micro>Pass</Micro>
              </th>
              <th scope="col" className="pb-1.5 font-normal">
                <Micro>Fail</Micro>
              </th>
              <th scope="col" className="pb-1.5 font-normal">
                <Micro>Σ</Micro>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="text-left font-normal">
                <Micro>Pass</Micro>
              </th>
              {cell(stats.n11)}
              {cell(stats.n10, "current only")}
              {total(stats.n11 + stats.n10)}
            </tr>
            <tr>
              <th scope="row" className="text-left font-normal">
                <Micro>Fail</Micro>
              </th>
              {cell(stats.n01, "candidate only")}
              {cell(stats.n00)}
              {total(stats.n01 + stats.n00)}
            </tr>
            <tr>
              <th scope="row" className="text-left font-normal">
                <Micro>Σ</Micro>
              </th>
              {total(stats.n11 + stats.n01)}
              {total(stats.n10 + stats.n00)}
              {total(
                <>
                  <i className="font-sans">n</i>&#8239;=&#8239;{stats.n}
                </>,
              )}
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] leading-snug text-ink-3">Only the shaded discordant pairs carry evidence.</p>
      </div>

      <div className="flex flex-1 flex-col">
        <dl className="mt-5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-[12.5px] md:mt-0 lg:mt-5">
          <dt className="text-ink-3">McNemar χ² (cc)</dt>
          <dd className="t-data whitespace-nowrap text-right text-ink-1">{stats.chi2.toFixed(3)}</dd>
          <dt className="text-ink-3">
            <i>p</i> · {stats.test === "exact" ? "exact binomial" : "χ², df 1"}
          </dt>
          <dd className="t-data whitespace-nowrap text-right text-ink-1">{fmtP(stats.p)}</dd>
          <dt className="text-ink-3">Δ pass rate</dt>
          <dd className="t-data whitespace-nowrap text-right text-ink-1">{fmtPp(stats.deltaAcc)}</dd>
          <dt className="text-ink-3">95% bootstrap CI</dt>
          <dd className="t-data whitespace-nowrap text-right text-ink-1">
            [{ppValue(ci.low)}, {ppValue(ci.high)}]&#8239;pp
          </dd>
        </dl>
        <div className="mt-5">
          <ForestPlot low={ci.low} high={ci.high} delta={stats.deltaAcc} tone={verdict.tone} />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
          <div className="bg-bg-1 px-3.5 py-3">
            <Micro>Cost</Micro>
            <p className="t-figure mt-1.5 whitespace-nowrap text-[22px] text-ink-1">{fmtSigned(-cut)}</p>
          </div>
          <div className="bg-bg-1 px-3.5 py-3">
            <Micro className="whitespace-nowrap">
              TTFT <span className="tok">p95</span>
            </Micro>
            <p className="mt-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="t-figure text-[22px] text-ink-1">{(speedup >= 1 ? speedup : 1 / speedup).toFixed(1)}×</span>
              <span className="text-[12.5px] text-ink-3">{speedup >= 1 ? "faster" : "slower"}</span>
            </p>
          </div>
        </div>

        <div className="mt-auto pt-5">
          <button
            type="button"
            aria-disabled={held || undefined}
            className={cn(
              "btn w-full",
              canApply && !applied ? "btn-primary" : "btn-secondary",
              HELD,
              // applied is a settled state, not an unavailable action: full strength, no hover
              applied && "text-ink-2 hover:border-line-2 hover:bg-bg-3 aria-disabled:cursor-default aria-disabled:opacity-100",
            )}
            onClick={() => {
              if (held) return;
              getController().applyPolicy(node.id, candidate.model.id);
              setSaid(`Routing policy applied: ${node.label} now routes to ${candidate.model.label}.`);
            }}
          >
            {applied ? (
              <>
                <CheckMark /> Routing policy applied
              </>
            ) : canApply ? (
              "Apply optimal routing policy"
            ) : (
              "Not eligible: keep current model"
            )}
          </button>
          <span role="status" className="sr-only">
            {said}
          </span>
        </div>
      </div>
    </div>
  );
}

function CheckMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path d="M2.4 6.3 4.9 8.7 9.6 3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── node evidence ───────────────────────────────────────────────────────── */

/** The replay panel's rule glyph in miniature: the point estimate in its band, the interval on its own line below. */
function RuleGlyph({ delta, ci }: { delta: number; ci: BootstrapCI }) {
  const SPAN = 6;
  const pos = (v: number) => ((Math.max(-SPAN, Math.min(SPAN, v * 100)) + SPAN) / (2 * SPAN)) * 100;
  return (
    <span aria-hidden className="t-data mt-auto hidden grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 pt-4 text-[10.5px] leading-none text-ink-3 xl:grid">
      <span>Δ</span>
      <span className="relative h-[9px]">
        <span
          className="absolute inset-y-0 border-x border-dashed border-[rgb(236_233_225/0.24)] bg-[rgb(236_233_225/0.06)]"
          style={{ left: `${pos(-RULE)}%`, width: `${pos(RULE) - pos(-RULE)}%` }}
        />
        <span className="absolute -bottom-[13px] -top-px w-px bg-[rgb(236_233_225/0.16)]" style={{ left: `${pos(0)}%` }} />
        <span
          className="absolute top-1/2 block size-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-1 shadow-[0_0_0_1.5px_var(--color-bg-1)]"
          style={{ left: `${pos(delta)}%` }}
        />
      </span>
      <span className="whitespace-nowrap text-right">{fmtPp(delta)}</span>
      <span>CI</span>
      <span className="relative h-[7px]">
        <span
          className="absolute inset-y-0 border-x border-ink-3 before:absolute before:inset-x-0 before:top-[3px] before:h-px before:bg-ink-3"
          style={{ left: `${pos(ci.low)}%`, width: `${pos(ci.high) - pos(ci.low)}%` }}
        />
      </span>
      <span className="whitespace-nowrap text-right">
        [{ppValue(ci.low)}, {ppValue(ci.high)}]
      </span>
    </span>
  );
}

/* ── summary status ──────────────────────────────────────────────────────── */

/**
 * Filled, ringed, dashed: applied, recommended, keep. Monochrome, because none of these is a signal.
 * A policy applied to something other than the cheapest safe model names it, so the row never implies the wrong swap.
 */
function Status({ applied, recommended }: { applied: Candidate | null; recommended: Candidate | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 text-[12px]">
      {applied ? (
        <>
          <span className="size-[7px] shrink-0 rounded-full bg-ink-1" />
          <span className="whitespace-nowrap text-ink-1">
            Applied{applied !== recommended ? <span className="text-ink-2"> · {applied.model.label}</span> : null}
          </span>
        </>
      ) : recommended ? (
        <>
          <span className="size-[7px] shrink-0 rounded-full border border-ink-2" />
          <span className="whitespace-nowrap text-ink-2">Recommended</span>
        </>
      ) : (
        <>
          <span className="h-px w-[7px] shrink-0 bg-ink-3" />
          <span className="whitespace-nowrap text-ink-3">Keep current</span>
        </>
      )}
    </span>
  );
}

/* ── section ─────────────────────────────────────────────────────────────── */

export function ParetoFrontierChart() {
  const policy = useGateway((s) => s.policy);
  const [nodeId, setNodeId] = useState(AGENT_NODES[3].id);
  const node = AGENT_NODES.find((n) => n.id === nodeId)!;
  const analyses = useMemo(() => Object.fromEntries(AGENT_NODES.map((n) => [n.id, analyse(n)])), []);
  /** Per node, the model it routes to (an applied policy wins over the recommendation) and that swap's evidence. */
  const targets = useMemo(
    () =>
      Object.fromEntries(
        AGENT_NODES.map((n) => {
          const a = analyses[n.id];
          const applied = policy[n.id] ? (a.candidates.find((c) => c.model.id === policy[n.id]) ?? null) : null;
          const target = applied ?? a.recommended;
          const ev = target?.stats ? { delta: target.stats.deltaAcc, ci: deltaCI(target.stats, n) } : null;
          return [n.id, { applied, target, ev }];
        }),
      ),
    [analyses, policy],
  );
  const analysis = analyses[nodeId];
  const [picked, setPicked] = useState<Record<string, string>>({});
  const selectedId =
    picked[nodeId] ?? analysis.recommended?.model.id ?? analysis.candidates.filter((c) => !c.isBaseline).sort((a, b) => b.accuracy - a.accuracy)[0].model.id;
  const candidate = analysis.candidates.find((c) => c.model.id === selectedId)!;

  const monthly = AGENT_NODES.reduce(
    (acc, n) => {
      const a = analyses[n.id];
      const applied = policy[n.id];
      const model = applied ? a.candidates.find((c) => c.model.id === applied)! : a.baseline;
      acc.before += a.baseline.cost;
      acc.after += model.cost;
      return acc;
    },
    { before: 0, after: 0 },
  );

  return (
    <section id="evals" className="mx-auto max-w-[1360px] px-4 pt-32 md:px-8 md:pt-40">
      <SectionHeader
        index="04"
        kicker="Online shadow evals"
        title="A cheaper model ships only after a paired test clears it"
        aside={
          <div className="text-left md:text-right">
            <Micro>Projected spend</Micro>
            <p className="t-figure mt-2 whitespace-nowrap text-[28px] text-ink-1">
              {fmtUsd(monthly.after)}
              {monthly.after < monthly.before ? <span className="ml-2 text-[15px] text-ink-3 line-through decoration-ink-4">{fmtUsd(monthly.before)}</span> : null}
            </p>
            <p className="t-data mt-1.5 whitespace-nowrap text-[11.5px] text-ink-3">per 1M requests on each node</p>
          </div>
        }
      >
        Ten percent of production traffic is replayed against cheaper candidates. A swap is recommended only when
        McNemar&apos;s paired test finds no significant difference and the pass rate moves by less than 1&#8239;pp.
      </SectionHeader>

      <Reveal>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          {/* agent nodes: a row of four below xl, a column that fills the row height at xl */}
          <div className="grid grid-cols-2 gap-2 lg:col-span-12 lg:grid-cols-4 xl:col-span-3 xl:flex xl:flex-col" role="group" aria-label="Agent node">
            {AGENT_NODES.map((n) => {
              const a = analyses[n.id];
              const active = n.id === nodeId;
              const { applied, target, ev } = targets[n.id];
              return (
                <button
                  key={n.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setNodeId(n.id)}
                  className={cn(
                    "bezel group flex flex-col p-4 text-left transition-[background-color,border-color] duration-150 xl:flex-1",
                    "before:absolute before:inset-y-4 before:left-0 before:w-[2px] before:rounded-r-[1px] before:bg-transparent before:transition-colors before:duration-150",
                    active ? "border-line-3 bg-bg-2 before:bg-ink-1" : "hover:border-line-2",
                  )}
                >
                  <span className="flex min-h-[22px] items-center justify-between gap-2">
                    <span className={cn("t-data text-[11px] transition-colors duration-150", active ? "text-ink-1" : "text-ink-3")}>0{n.index}</span>
                    {applied ? (
                      <Chip>Applied</Chip>
                    ) : target ? (
                      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
                        <Micro>Cost</Micro>
                        <span className="t-data text-[12px] text-ink-1">{fmtSigned(-saving(target, a.baseline))}</span>
                      </span>
                    ) : (
                      <span className="t-data text-[12px] text-ink-3">keep</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "mt-2 block text-[15px] font-[540] leading-snug transition-colors duration-150",
                      active ? "text-ink-1" : "text-ink-2 group-hover:text-ink-1",
                    )}
                  >
                    {n.label}
                  </span>
                  <span className="mt-0.5 hidden text-[12.5px] leading-snug text-ink-3 sm:block">{n.role}</span>
                  {ev ? <RuleGlyph delta={ev.delta} ci={ev.ci} /> : null}
                  <span className={cn("t-data block pt-3 text-[11.5px] leading-snug text-ink-3", ev ? "mt-auto xl:mt-0" : "mt-auto")}>
                    <Name>{a.baseline.model.label}</Name>
                    {target ? (
                      <>
                        {" "}
                        <span className="text-ink-4">→</span> <Name className="text-ink-1">{target.model.label}</Name>
                      </>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="bezel flex flex-col p-5 md:p-6 lg:col-span-7 xl:col-span-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <p className="flex min-w-0 items-baseline gap-2.5">
                <Micro className="shrink-0">Fig. 04</Micro>
                <Label>Pass rate vs. cost · {node.label}</Label>
              </p>
              <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
                <li className="flex items-center gap-1.5 whitespace-nowrap">
                  <TierKey tier="fast" /> Fast tier
                </li>
                <li className="flex items-center gap-1.5 whitespace-nowrap">
                  <TierKey tier="frontier" /> Frontier
                </li>
                <li className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="h-[1.5px] w-4 bg-[rgb(236_233_225/0.42)]" /> Pareto frontier
                </li>
                <li className="flex items-center gap-1.5 whitespace-nowrap">
                  <TierKey tier="fast" dominated /> Dominated
                </li>
              </ul>
            </div>
            <div className="relative mt-4 h-[320px] md:h-[400px] lg:h-auto lg:min-h-[380px] lg:flex-1">
              <Chart node={node} analysis={analysis} selected={selectedId} onSelect={(id) => setPicked((p) => ({ ...p, [nodeId]: id }))} />
            </div>
            <p className="mt-2 text-[12px] text-ink-3">Select a point to replay it against the current model.</p>
          </div>

          <div className="bezel p-5 md:p-6 lg:col-span-5 xl:col-span-3 xl:p-5">
            <ReplayMatrix node={node} analysis={analysis} candidate={candidate} />
          </div>
        </div>

        {/* summary: one block per node on phones, a table from md */}
        <ul className="bezel mt-3 md:hidden">
          {AGENT_NODES.map((n) => {
            const a = analyses[n.id];
            const rec = a.recommended;
            return (
              <li key={n.id} className="border-b border-line px-5 py-4 last:border-b-0">
                <p className="text-[14px] text-ink-1">{n.label}</p>
                <p className="t-data mt-1 text-[11.5px] leading-snug text-ink-3">
                  <Name>{a.baseline.model.label}</Name> <span className="text-ink-4">→</span>{" "}
                  {rec ? <Name className="text-ink-1">{rec.model.label}</Name> : <Name>none qualifies</Name>}
                </p>
                <dl className="mt-3 grid grid-cols-[repeat(3,auto)_minmax(0,1fr)] gap-x-5">
                  <div>
                    <dt>
                      <Micro>Δ</Micro>
                    </dt>
                    <dd className="t-data mt-1 whitespace-nowrap text-[12px] text-ink-1">{rec?.stats ? fmtPp(rec.stats.deltaAcc) : "—"}</dd>
                  </div>
                  <div>
                    <dt>
                      <Micro>
                        <i className="tok font-sans text-[12px]">p</i>
                      </Micro>
                    </dt>
                    <dd className="t-data mt-1 whitespace-nowrap text-[12px] text-ink-1">{rec?.stats ? fmtP(rec.stats.p) : "—"}</dd>
                  </div>
                  <div>
                    <dt>
                      <Micro>Cost</Micro>
                    </dt>
                    <dd className="t-data mt-1 whitespace-nowrap text-[12px] text-ink-1">{rec ? fmtSigned(-saving(rec, a.baseline)) : "—"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt>
                      <Micro>Status</Micro>
                    </dt>
                    <dd className="mt-1 flex">
                      <Status applied={targets[n.id].applied} recommended={rec} />
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>

        <div className="bezel mt-3 hidden overflow-x-auto md:block">
          <table className="w-full text-left">
            <thead>
              <tr className="[&>th]:whitespace-nowrap [&>th]:border-b [&>th]:border-line [&>th]:px-3 [&>th]:py-3 [&>th]:font-normal lg:[&>th]:px-5">
                <th scope="col">
                  <Micro>Agent node</Micro>
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  <Micro>Current</Micro>
                </th>
                <th scope="col">
                  <Micro>Cheapest safe</Micro>
                </th>
                <th scope="col" className="text-right">
                  <Micro>Δ pass rate</Micro>
                </th>
                <th scope="col" className="text-right">
                  <Micro>
                    <i className="tok font-sans text-[12px]">p</i>
                  </Micro>
                </th>
                <th scope="col" className="text-right">
                  <Micro>Cost</Micro>
                </th>
                <th scope="col" className="text-right">
                  <Micro>Status</Micro>
                </th>
              </tr>
            </thead>
            <tbody>
              {AGENT_NODES.map((n) => {
                const a = analyses[n.id];
                const rec = a.recommended;
                return (
                  <tr key={n.id} className="[&>td]:border-b [&>td]:border-line [&>td]:px-3 [&>td]:py-3 last:[&>td]:border-b-0 lg:[&>td]:px-5">
                    <td className="whitespace-nowrap text-[13px] text-ink-1">{n.label}</td>
                    <td className="t-data hidden whitespace-nowrap text-[12px] text-ink-2 lg:table-cell">{a.baseline.model.label}</td>
                    <td className="t-data whitespace-nowrap text-[12px] text-ink-1">{rec ? rec.model.label : <span className="text-ink-3">none qualifies</span>}</td>
                    <td className="t-data whitespace-nowrap text-right text-[12px] text-ink-2">{rec?.stats ? fmtPp(rec.stats.deltaAcc) : "—"}</td>
                    <td className="t-data whitespace-nowrap text-right text-[12px] text-ink-2">{rec?.stats ? fmtP(rec.stats.p) : "—"}</td>
                    <td className="t-data whitespace-nowrap text-right text-[12px] text-ink-1">{rec ? fmtSigned(-saving(rec, a.baseline)) : "—"}</td>
                    <td>
                      <div className="flex justify-end">
                        <Status applied={targets[n.id].applied} recommended={rec} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  );
}
