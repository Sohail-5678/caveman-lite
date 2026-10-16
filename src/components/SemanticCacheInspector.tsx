"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adaptiveThreshold, cosine, countTokens, DEFAULT_THRESHOLD, embed } from "@/lib/cache/semantic-cache";
import { checkParity, extractEntities, type EntityParity, type EntitySet, type SetDiff } from "@/lib/cache/entity-guard";
import { escapeRegExp, ORG_ALIASES } from "@/lib/cache/lexicon";
import { INSPECTOR_PRESETS, ORB_BACKGROUND } from "@/lib/workload-traces";
import { getController, useGateway } from "@/lib/gateway/use-gateway";
import { isBurstActive } from "@/lib/gateway/controller";
import type { Tone } from "@/lib/gateway/choreography";
import { cn, NBSP, plural } from "@/lib/format";
import { EmbeddingOrb } from "./EmbeddingOrb";
import { Chip, Glyph, Label, Micro, Reveal, SectionHeader } from "./ui";

type Decision = "hit" | "veto" | "miss";

/** Fixed-point with a typographic minus, for values that can go negative (cosine). */
const fixed = (v: number, digits: number) => v.toFixed(digits).replace("-", "−");

const CATEGORIES: Array<{ key: keyof EntitySet; label: string }> = [
  { key: "named", label: "Named" },
  { key: "numeric", label: "Numeric" },
  { key: "polarity", label: "Polarity" },
];

const PRESET_KIND: Record<string, string> = {
  entity: "Entity",
  numeric: "Number",
  polarity: "Negation",
  direction: "Direction",
  paraphrase: "Paraphrase",
};

/* ── the veto in words ─────────────────────────────────────────────────── */

/** Display casing for canonical names that are not simply capitalised. */
const ORG_DISPLAY: Record<string, string> = {
  aws: "AWS",
  nvidia: "NVIDIA",
  ibm: "IBM",
  amd: "AMD",
  sap: "SAP",
  tsmc: "TSMC",
  gcp: "GCP",
  openai: "OpenAI",
  jpmorgan: "JPMorgan",
  paypal: "PayPal",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  doordash: "DoorDash",
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  mongodb: "MongoDB",
  bigquery: "BigQuery",
  dynamodb: "DynamoDB",
  duckdb: "DuckDB",
  clickhouse: "ClickHouse",
  cockroachdb: "CockroachDB",
  mysql: "MySQL",
  sqlite: "SQLite",
  chatgpt: "ChatGPT",
  gpt: "GPT",
  bert: "BERT",
  huggingface: "Hugging Face",
  langchain: "LangChain",
  llamaindex: "LlamaIndex",
  crowdstrike: "CrowdStrike",
  iphone: "iPhone",
  ipad: "iPad",
  macbook: "MacBook",
};

const DIRECTION_DISPLAY: Record<string, string> = {
  max: "highest",
  min: "lowest",
  gt: "more than",
  lt: "less than",
  asc: "ascending",
  desc: "descending",
};

/** A canonical value as the prompts spell it ("apple" → "Apple", "q3" → "Q3"); unknown values stay as they are. */
function displayToken(v: string, source: string): string {
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(v)})(?![\\p{L}\\p{N}])`, "iu").exec(source);
  if (m && /\p{Lu}/u.test(m[2])) return m[2];
  if (ORG_DISPLAY[v]) return ORG_DISPLAY[v];
  if (/^(q[1-4]|h[12]|fy\d+)$/.test(v)) return v.toUpperCase();
  if (ORG_ALIASES.has(v)) return v.replace(/(^|[\s-])\p{Ll}/gu, (c) => c.toUpperCase());
  return v;
}

type Show = (v: string) => string;

const an = (noun: string) => (/^[aeiou]/.test(noun) ? "an" : "a");

/** Always from B's side: B's value first, then A's. */
function differs(kind: string, onlyA: readonly string[], onlyB: readonly string[], show: Show): string {
  const a = onlyA.map(show).join(", ");
  const b = onlyB.map(show).join(", ");
  if (a && b) return `${kind[0].toUpperCase()}${kind.slice(1)} differs: ${b} (B) vs ${a} (A)`;
  return b ? `B adds ${an(kind)} ${kind}: ${b}` : `B drops the ${kind}: ${a}`;
}

/** One reason per kind of value, so "q3 2026 → q4" reads as a quarter change plus a dropped year. */
function byKind(d: SetDiff, kindOf: (v: string) => string, show: Show): string[] {
  const kinds = [...new Set([...d.onlyA, ...d.onlyB].map(kindOf))];
  return kinds.map((k) =>
    differs(
      k,
      d.onlyA.filter((v) => kindOf(v) === k),
      d.onlyB.filter((v) => kindOf(v) === k),
      show,
    ),
  );
}

function numericKind(v: string): string {
  if (/^q[1-4]$/.test(v)) return "quarter";
  if (/^h[12]$/.test(v)) return "half";
  if (/^fy\d{4}$/.test(v)) return "fiscal year";
  if (/^(19|20)\d{2}$/.test(v)) return "year";
  if (/^\d{4}-\d{2}/.test(v)) return "date";
  if (/(%|bps)$/.test(v)) return "rate";
  if (/^[$€£¥]/.test(v)) return "amount";
  if (/^p\d/.test(v)) return "percentile";
  return "number";
}

function polarityReasons({ onlyA, onlyB }: SetDiff, show: Show): string[] {
  const out: string[] = [];
  if (onlyB.includes("not")) out.push("B adds a negation");
  if (onlyA.includes("not")) out.push("B drops the negation");
  if (onlyB.includes("exclude")) out.push("B adds an exclusion");
  if (onlyA.includes("exclude")) out.push("B drops the exclusion");
  const direction = (xs: readonly string[]) => xs.filter((v) => v !== "not" && v !== "exclude");
  const dirA = direction(onlyA);
  const dirB = direction(onlyB);
  if (dirA.length || dirB.length) out.push(differs("direction", dirA, dirB, show));
  return out;
}

/**
 * Why the entity guard vetoes, one reason per difference, always from B's side:
 * "Company differs: Microsoft (B) vs Apple (A)", "B adds a year: 2026", "B drops the negation".
 * "prose" sets names in display case (pass both prompts to keep their own spelling);
 * "code" keeps the canonical lower-case values the guard compares, for mono lines.
 */
export function vetoReasons(parity: EntityParity, mode: "prose" | "code" = "prose", prompts?: { a: string; b: string }): string[] {
  const source = prompts ? `${prompts.a}\n${prompts.b}` : "";
  const show: Show = mode === "prose" ? (v) => displayToken(v, source) : (v) => v;
  const showDirection: Show = mode === "prose" ? (v) => DIRECTION_DISPLAY[v] ?? v : (v) => v;
  return [
    ...byKind(parity.diff.named, (v) => (ORG_ALIASES.has(v) ? "company" : "name"), show),
    ...byKind(parity.diff.numeric, numericKind, show),
    ...polarityReasons(parity.diff.polarity, showDirection),
  ];
}

/** The reasons as sentences. */
const sentences = (reasons: readonly string[]) =>
  (reasons.length ? reasons : ["The entities differ"]).map((r) => `${r}.`).join(" ");

/* ── pieces ────────────────────────────────────────────────────────────── */

function EntityRows({
  entities,
  diff,
  side,
  className,
}: {
  entities: EntitySet;
  diff: Record<keyof EntitySet, SetDiff>;
  side: "a" | "b";
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-line border-y border-line", className)}>
      {CATEGORIES.map(({ key, label }) => {
        const values = entities[key];
        const only = side === "a" ? diff[key].onlyA : diff[key].onlyB;
        return (
          <div key={key} className="grid grid-cols-[76px_1fr] items-center gap-3 py-2.5">
            <dt>
              <Micro>{label}</Micro>
            </dt>
            <dd className="flex min-h-[22px] flex-wrap items-center gap-1.5">
              {values.length === 0 ? <span className="text-[12px] text-ink-3">none</span> : null}
              {values.map((v) => {
                const mismatch = only.includes(v);
                return (
                  <span
                    key={v}
                    className={cn(
                      "t-data inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border px-1.5 text-[11.5px] transition-colors duration-200",
                      mismatch
                        ? "border-[rgb(241_97_89/0.45)] bg-[rgb(241_97_89/0.1)] text-[#fbc3bf]"
                        : "border-line-2 bg-[rgb(236_233_225/0.03)] text-ink-1",
                    )}
                  >
                    {mismatch ? <Glyph tone="cinnabar" size={6} /> : null}
                    {v}
                    {mismatch ? <span className="sr-only">{side === "a" ? " (not in B)" : " (not in A)"}</span> : null}
                  </span>
                );
              })}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function PromptField({
  id,
  label,
  hint,
  value,
  onChange,
  footer,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  footer: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id}>
          <Label>{label}</Label>
        </label>
        <Micro>{hint}</Micro>
      </div>
      {/* a compose box: it grows into whatever height the orb gives the row, and its footer says what the gateway counts */}
      <div className="field flex min-h-[136px] flex-1 flex-col p-0">
        <textarea
          id={id}
          rows={3}
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-3.5 pt-3 text-[15px] leading-[1.5] text-ink-1 outline-none focus-visible:outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
        <div className="t-data flex items-center justify-between gap-3 border-t border-line px-3.5 py-2 text-[11px] text-ink-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

/** Mono advance of JetBrains Mono at the axis label size, used to keep labels from touching. */
const AXIS_CH = 6.4;
const AXIS_LO = 0.8;
const AXIS_TICKS = [0.8, 0.85, 0.9, 0.95, 1];

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function SimilarityScale({ similarity, tau, decision }: { similarity: number; tau: number; decision: Decision }) {
  const [ref, w] = useWidth<HTMLDivElement>(320);
  const frac = (v: number) => Math.max(0, Math.min(1, (v - AXIS_LO) / (1 - AXIS_LO)));
  /** Left offset that keeps a mark of `px` width inside the track at both ends. */
  const at = (v: number, px: number) => `calc(${frac(v) * 100}% - ${frac(v) * px}px)`;
  const short = tau !== DEFAULT_THRESHOLD;
  const below = similarity < AXIS_LO;
  // the region past τ is a definition, not an outcome: the verdict shows only in the glyph by the value
  const zone = "rgb(236 233 225 / 0.05)";

  // τ labels claim their place first; a tick label that would touch one already placed is dropped
  type AxisLabel = { v: number; text: string; className: string; left: number; width: number };
  const candidates = [
    { v: tau, text: `τ ${tau.toFixed(2)}`, className: "text-ink-1" },
    ...(short ? [{ v: DEFAULT_THRESHOLD, text: `τ ${DEFAULT_THRESHOLD.toFixed(2)}`, className: "text-ink-3" }] : []),
    ...[AXIS_TICKS[0], AXIS_TICKS[AXIS_TICKS.length - 1], ...AXIS_TICKS.slice(1, -1)].map((v) => ({
      v,
      text: v.toFixed(2),
      className: "text-ink-3",
    })),
  ];
  const labels: AxisLabel[] = [];
  for (const c of candidates) {
    const width = c.text.length * AXIS_CH;
    const left = c.v <= AXIS_LO ? 0 : c.v >= 1 ? w - width : Math.max(0, Math.min(w - width, frac(c.v) * w - width / 2));
    if (labels.some((p) => left < p.left + p.width + 8 && p.left < left + width + 8)) continue;
    labels.push({ ...c, left, width });
  }
  const tauLabel = labels[0];
  /** Centred on v, held inside the track at both ends. */
  const centred = (v: number, px: number) => `clamp(0px, calc(${frac(v) * 100}% - ${px / 2}px), calc(100% - ${px}px))`;
  const labelLeft = (l: AxisLabel) => (l.v <= AXIS_LO ? "0px" : l.v >= 1 ? `calc(100% - ${l.width}px)` : centred(l.v, l.width));

  const glyph: Tone | null = decision === "hit" ? "malachite" : decision === "veto" ? "cinnabar" : null;
  const valueText = below ? `◂ ${fixed(similarity, 2)}` : fixed(similarity, 3);
  const valueWidth = valueText.length * 6.7 + (glyph && !below ? 11 : 0);

  return (
    <div ref={ref} role="img" aria-label={`Cosine ${fixed(similarity, 3)} against a threshold of ${tau.toFixed(2)}`}>
      <div className="relative h-[38px]" aria-hidden>
        <div className="absolute top-[23px] h-[9px]" style={{ left: `${frac(tau) * 100}%`, right: 0, background: zone }} />
        <div className="absolute inset-x-0 top-[27px] h-px bg-line-3" />
        {AXIS_TICKS.map((t) => (
          <span key={t} className="absolute top-[28px] h-[4px] w-px bg-line-3" style={{ left: at(t, 1) }} />
        ))}
        {short ? <span className="absolute top-[20px] h-[16px] w-px bg-ink-4" style={{ left: at(DEFAULT_THRESHOLD, 1) }} /> : null}
        <span className="absolute top-[20px] h-[16px] w-px bg-ink-2" style={{ left: at(tau, 1) }} />
        {below ? null : (
          <span
            className="absolute top-[18px] h-[18px] w-[2px] bg-ink-1 motion-safe:transition-[left] motion-safe:duration-500 motion-safe:ease-[var(--ease-out)]"
            style={{ left: at(similarity, 2) }}
          />
        )}
        <span
          className="t-data absolute top-0 flex h-[14px] items-center gap-1 text-[11px] text-ink-1 motion-safe:transition-[left] motion-safe:duration-500 motion-safe:ease-[var(--ease-out)]"
          style={{ left: below ? "0px" : centred(similarity, valueWidth) }}
        >
          {glyph && !below ? <Glyph tone={glyph} size={7} /> : null}
          {valueText}
        </span>
      </div>
      <div className={cn("t-data relative mt-1 text-[10.5px]", short ? "h-[30px]" : "h-[14px]")} aria-hidden>
        {labels.map((l) => (
          <span key={l.text} className={cn("absolute top-0 whitespace-nowrap", l.className)} style={{ left: labelLeft(l) }}>
            {l.text}
          </span>
        ))}
        {short && tauLabel ? (
          <span
            className="absolute top-[15px] whitespace-nowrap font-sans text-[11px] text-ink-3"
            style={{ left: centred(tauLabel.v, 64), width: 64, textAlign: "center" }}
          >
            short query
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Verdict({
  title,
  rule,
  decision,
  tone,
  judgment,
  wrong,
  children,
  code,
}: {
  title: string;
  rule: string;
  decision: string;
  tone?: Tone;
  judgment: string;
  wrong?: boolean;
  children: ReactNode;
  code?: string;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 pb-5 pt-5 md:px-6 md:pb-6">
      <div>
        <div className="flex items-center justify-between gap-4">
          <Label className="whitespace-nowrap">{title}</Label>
          <Chip tone={tone}>{decision}</Chip>
        </div>
        <p className="t-data mt-1 whitespace-nowrap text-[11.5px] text-ink-3">{rule}</p>
      </div>
      <div className={cn("mt-1", wrong && "border-l border-ink-1 pl-3")}>
        <p className={cn("t-micro", wrong && "text-ink-1")}>{judgment}</p>
        <p className="mt-1.5 text-[13.5px] leading-snug text-ink-2 [text-wrap:pretty]">{children}</p>
      </div>
      {code ? <p className="t-data mt-auto pt-1 text-[11px] text-ink-3">{code}</p> : null}
    </div>
  );
}

/** The guard in full, set as the section's aside. */
function GuardRule() {
  const op = "text-ink-3";
  return (
    <div className="md:hidden xl:block">
      <Micro>Guard rule</Micro>
      <pre className="t-data mt-3 text-[12px] leading-[1.8] text-ink-2">
        <span className="text-ink-1">hit</span>
        <span className={op}>{"  ⇔  "}</span>cos(A, B) <span className={op}>≥</span> τ{"\n"}
        <span className={op}>{"     ∧  "}</span>named(A) <span className={op}>=</span> named(B){"\n"}
        <span className={op}>{"     ∧  "}</span>numeric(A) <span className={op}>=</span> numeric(B){"\n"}
        <span className={op}>{"     ∧  "}</span>polarity(A) <span className={op}>=</span> polarity(B)
      </pre>
    </div>
  );
}

/* ── section ───────────────────────────────────────────────────────────── */

export function SemanticCacheInspector() {
  const inspector = useGateway((s) => s.inspector);
  const burstActive = isBurstActive(useGateway((s) => s.burst));
  const [a, setA] = useState<string>(inspector.a);
  const [b, setB] = useState<string>(inspector.b);
  const [preset, setPreset] = useState<string | null>("entity");
  const [pulse, setPulse] = useState(false);

  // the corridor's "entity trap" button loads its pair here
  useEffect(() => {
    if (inspector.nonce === 0) return;
    setA(inspector.a);
    setB(inspector.b);
    setPreset(INSPECTOR_PRESETS.find((p) => p.a === inspector.a && p.b === inspector.b)?.id ?? null);
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 600);
    return () => clearTimeout(id);
  }, [inspector]);

  const da = useDeferredValue(a);
  const db = useDeferredValue(b);
  const background = useMemo(() => ORB_BACKGROUND.map((t) => embed(t)), []);
  const analysis = useMemo(() => {
    const va = embed(da);
    const vb = embed(db);
    const ea = extractEntities(da);
    const eb = extractEntities(db);
    const parity = checkParity(ea, eb);
    const similarity = cosine(va, vb);
    const tau = adaptiveThreshold(db);
    const reasons = parity.ok ? "" : sentences(vetoReasons(parity, "prose", { a: da, b: db }));
    return { va, vb, ea, eb, parity, similarity, tau, reasons, tokensA: countTokens(da), tokensB: countTokens(db) };
  }, [da, db]);

  const { similarity, tau, parity, reasons } = analysis;
  const short = tau !== DEFAULT_THRESHOLD;
  const naiveHit = similarity >= DEFAULT_THRESHOLD;
  const candidate = similarity >= tau;
  const guardDecision: Decision = candidate ? (parity.ok ? "hit" : "veto") : "miss";
  const orbTone: Tone = guardDecision === "hit" ? "malachite" : guardDecision === "veto" ? "cinnabar" : "bone";
  const theta = (Math.acos(Math.max(-1, Math.min(1, similarity))) * 180) / Math.PI;
  const naiveJudgment = naiveHit ? (parity.ok ? "Correct" : "Wrong answer served") : "Sent upstream";
  const guardWord = guardDecision === "hit" ? "Hit" : guardDecision === "veto" ? "Veto" : "Miss";

  // both verdicts, read out once typing settles; the first render is not news
  const summary =
    `Caveman-Lite: ${guardWord.toLowerCase()}.` +
    (guardDecision === "veto" ? ` ${reasons}` : "") +
    ` Naive vector cache: ${naiveHit ? "hit" : "miss"}, ${naiveJudgment.toLowerCase()}.`;
  const [announced, setAnnounced] = useState("");
  const spoken = useRef(summary);
  useEffect(() => {
    const id = setTimeout(() => {
      if (spoken.current === summary) return;
      spoken.current = summary;
      setAnnounced(summary);
    }, 700);
    return () => clearTimeout(id);
  }, [summary]);

  const choose = (id: string) => {
    const p = INSPECTOR_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    setA(p.a);
    setB(p.b);
  };

  const sendThroughCorridor = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const corridor = document.querySelector<HTMLElement>("#corridor figure") ?? document.getElementById("corridor");
    corridor?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    // focus follows the viewport, so the keyboard is not left two screens below what it just showed
    corridor?.focus({ preventScroll: true });
    void getController().sendPair(a, b, 900);
  };

  // At md the two bezels sit side by side and subgrid two rows; at lg the figure joins them between.
  const sideBezel = cn(
    "bezel flex flex-col outline-1 outline-transparent transition-[outline-color] duration-200 md:row-span-2 md:grid md:grid-rows-subgrid",
    pulse && "outline-cinnabar/60",
  );

  const naiveVerdict = (
    <Verdict
      title="Naive vector cache"
      rule={`cos ≥ ${DEFAULT_THRESHOLD.toFixed(2)}`}
      decision={naiveHit ? "Hit" : "Miss"}
      tone={naiveHit ? "malachite" : undefined}
      judgment={naiveJudgment}
      wrong={naiveHit && !parity.ok}
      code={`cos ${fixed(similarity, 3)} ${naiveHit ? "≥" : "<"} ${DEFAULT_THRESHOLD.toFixed(2)} · entities not checked`}
    >
      {naiveHit ? (
        parity.ok ? (
          "Serves A's answer, and it happens to fit: B asks the same thing."
        ) : (
          <>
            Serves A&apos;s answer to B at full confidence. <span className="text-ink-1">{reasons}</span>
          </>
        )
      ) : (
        `Below ${DEFAULT_THRESHOLD.toFixed(2)}, so B goes upstream.`
      )}
    </Verdict>
  );

  return (
    <section id="cache" className="mx-auto max-w-[1360px] px-4 pt-32 md:px-8 md:pt-40">
      <SectionHeader
        index="03"
        kicker="Semantic cache inspector"
        title="A cosine of 0.97 is close enough to be wrong"
        aside={<GuardRule />}
      >
        Embeddings barely move when a company, a quarter or a negation changes, so a plain vector cache serves the wrong
        answer at full confidence. <span className="whitespace-nowrap">Caveman-Lite</span> requires entity, numeric and
        polarity parity before it trusts a semantic hit.
      </SectionHeader>

      <Reveal>
        <div className="mb-4 flex flex-col gap-2.5 md:flex-row md:items-start md:gap-4">
          {/* one button-height tall, so the label stays on the first row when the pairs wrap */}
          <span className="flex shrink-0 items-center md:h-[30px] [@media(pointer:coarse)]:md:h-11">
            <Micro>Try a pair</Micro>
          </span>
          {/* py-1 keeps focus rings whole: overflow-x clips vertically too */}
          <div
            role="group"
            aria-label="Example pairs"
            className="-mx-4 -my-1 flex snap-x snap-mandatory scroll-px-4 gap-1.5 overflow-x-auto px-4 py-1 [scrollbar-width:none] md:mx-0 md:my-0 md:min-w-0 md:flex-1 md:flex-wrap md:overflow-visible md:px-0 md:py-0 [&::-webkit-scrollbar]:hidden"
          >
            {INSPECTOR_PRESETS.map((p) => {
              const on = preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choose(p.id)}
                  aria-pressed={on}
                  className={cn(
                    "btn btn-sm shrink-0 snap-start gap-0 border [@media(pointer:coarse)]:h-11",
                    on ? "border-line-3 bg-bg-3 text-ink-1" : "border-line bg-transparent text-ink-2 hover:text-ink-1",
                  )}
                >
                  <span className={cn("text-[12px]", on ? "text-ink-3-raised" : "text-ink-3")}>
                    {PRESET_KIND[p.id] ?? p.kind}
                    <span className="mx-1.5" aria-hidden>
                      ·
                    </span>
                  </span>
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Phones: A → orb → B → both verdicts, so neither verdict mentions a query the reader has not met.
            md: A and B side by side, the orb below. lg: three bezels subgridding the same two rows, so the
            entity tables' bottom rule and the readouts' top rule fall on one line and both verdicts share a row
            with the scale. */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-y-0 lg:grid-cols-3">
          <div className={sideBezel}>
            <div className="flex flex-1 flex-col gap-5 px-5 pt-5 md:px-6 md:pt-6">
              <PromptField
                id="prompt-a"
                label="A · cached key"
                hint="already answered"
                value={a}
                onChange={(v) => {
                  setA(v);
                  setPreset(null);
                }}
                footer={<span>{plural(analysis.tokensA, "token")}</span>}
              />
              <EntityRows entities={analysis.ea} diff={parity.diff} side="a" className="mt-auto" />
            </div>
            <div className="hidden md:contents">{naiveVerdict}</div>
          </div>

          <figure className="bezel flex flex-col md:order-last md:col-span-2 md:mt-3 lg:order-none lg:col-span-1 lg:row-span-2 lg:mt-0 lg:grid lg:grid-rows-subgrid">
            <div className="flex flex-col px-5 pb-3 pt-5 md:px-6 md:pt-6">
              <figcaption>
                <Micro className="text-accent">
                  Fig. 03 — Embedding space, <span className="tok">384-d</span>
                </Micro>
              </figcaption>
              <div className="mx-auto mt-2 w-full max-w-[380px] md:max-w-[420px] lg:max-w-[320px]">
                <EmbeddingOrb
                  a={analysis.va}
                  b={analysis.vb}
                  background={background}
                  tau={tau}
                  naiveTau={DEFAULT_THRESHOLD}
                  tone={orbTone}
                  similarity={similarity}
                />
              </div>
            </div>
            <div className="mx-5 flex flex-col border-t border-line md:mx-6">
              <dl className="grid grid-cols-3 gap-3 py-5 text-center">
                <div>
                  <dt>
                    <Micro>Cosine</Micro>
                  </dt>
                  <dd className="t-figure mt-2 text-[24px] tabular-nums text-ink-1">{fixed(similarity, 3)}</dd>
                </div>
                <div>
                  <dt>
                    <Micro>Angle</Micro>
                  </dt>
                  <dd className="t-figure mt-2 text-[24px] tabular-nums text-ink-1">{theta.toFixed(1)}°</dd>
                </div>
                <div>
                  <dt>
                    <Micro>
                      Threshold <span className="tok">τ</span>
                    </Micro>
                  </dt>
                  <dd className="t-figure mt-2 text-[24px] tabular-nums text-ink-1">{tau.toFixed(2)}</dd>
                </div>
              </dl>
              <div className="border-t border-line pb-5 pt-4 md:pb-6">
                <SimilarityScale similarity={similarity} tau={tau} decision={guardDecision} />
                <p className="mt-3 text-[12.5px] leading-snug text-ink-3 [text-wrap:balance]">
                  {short
                    ? `Under 12 tokens there is less context to disambiguate, so the threshold tightens to${NBSP}0.97.`
                    : `Prompts of 12 or more tokens use the base threshold of${NBSP}${DEFAULT_THRESHOLD.toFixed(2)}.`}
                </p>
              </div>
            </div>
          </figure>

          <div className={sideBezel}>
            <div className="flex flex-1 flex-col gap-5 px-5 pt-5 md:px-6 md:pt-6">
              <PromptField
                id="prompt-b"
                label="B · incoming query"
                hint="just arrived"
                value={b}
                onChange={(v) => {
                  setB(v);
                  setPreset(null);
                }}
                footer={
                  <>
                    <span>{plural(analysis.tokensB, "token")}</span>
                    <span>
                      {short ? "short query · " : ""}τ {tau.toFixed(2)}
                    </span>
                  </>
                }
              />
              <EntityRows entities={analysis.eb} diff={parity.diff} side="b" className="mt-auto" />
            </div>
            <div className="md:hidden">
              {naiveVerdict}
              <div className="mx-5 h-px bg-line" />
            </div>
            <Verdict
              title="Caveman-Lite"
              rule={`cos ≥ τ ${tau.toFixed(2)} ∧${NBSP}entity${NBSP}parity`}
              decision={guardWord}
              tone={guardDecision === "hit" ? "malachite" : guardDecision === "veto" ? "cinnabar" : undefined}
              judgment={guardDecision === "hit" ? "Correct" : "Sent upstream"}
              code={
                guardDecision === "hit"
                  ? "x-cache: HIT-T2"
                  : guardDecision === "veto"
                    ? "x-cache: VETO · CACHE_BYPASS_ENTITY_MISMATCH"
                    : "x-cache: MISS"
              }
            >
              {guardDecision === "hit" ? (
                "Serves A's answer. Entities, numbers and polarity all match."
              ) : guardDecision === "veto" ? (
                <>
                  Close enough to match, but the guard vetoes it. <span className="text-ink-1">{reasons}</span>
                </>
              ) : short ? (
                `Below the short-query threshold of ${tau.toFixed(2)}, so B goes upstream.`
              ) : (
                `Below ${tau.toFixed(2)}, so B goes upstream.`
              )}
            </Verdict>
          </div>
        </div>

        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announced}
        </p>

        <div className="mt-4 flex flex-col items-start gap-2 text-[12.5px] text-ink-3 md:flex-row md:items-center md:gap-4">
          <p className="flex items-start gap-2">
            <Glyph tone="cinnabar" size={7} className="mt-[5.5px]" />
            <span>
              Mismatched entities are marked. Edit either prompt and everything recomputes in the browser with the
              gateway&apos;s own embedder and guard.
            </span>
          </p>
          <button
            type="button"
            className="inline-flex shrink-0 items-center text-ink-2 underline-offset-4 hover:text-ink-1 hover:underline disabled:cursor-not-allowed disabled:opacity-40 md:ml-auto [@media(pointer:coarse)]:min-h-11"
            disabled={burstActive}
            title={burstActive ? "Wait for the burst to finish" : undefined}
            onClick={sendThroughCorridor}
          >
            Send B through the corridor ↑
          </button>
        </div>
      </Reveal>
    </section>
  );
}
