/**
 * Entity-aware guard: hard parity on named entities, numerics and polarity before a semantic hit.
 *
 * Sentence embeddings are notoriously insensitive to the tokens that change an answer the most
 * ("Apple" -> "Microsoft", "Q3" -> "Q4", "renewed" -> "did not renew"). Before a semantic cache
 * entry may be served, the query and the cached prompt must agree exactly on three normalised sets.
 * Extraction is rule-based, deterministic and runs in well under a millisecond for typical prompts.
 */
import {
  ACRONYM_STOPLIST,
  CAPITALISED_ONLY,
  CAPS_ONLY_TICKERS,
  COMMON_WORDS,
  MONTHS,
  NUMBER_WORDS,
  ORG_ALIASES,
  ORG_PHRASES,
  POLARITY_WORDS,
  SEC_FORM_SOURCE,
  SQL_KEYWORDS,
  WEEKDAYS,
  escapeRegExp,
} from "./lexicon";

export interface EntitySet {
  /** Lower-cased canonical names: companies (aliases/tickers folded, e.g. "aapl" -> "apple"), products, SQL identifiers. */
  named: string[];
  /** Normalised numerics: "q3", "2026", "fy2026", "12.5%", "$4.2b", "5" (number words folded to digits), "h1". */
  numeric: string[];
  /** Normalised polarity: "not", "exclude", "max", "min", "before", "after", "gt", "lt", "up", "down", "asc", "desc". */
  polarity: string[];
}

export type ParityReason = "NAMED_ENTITY_MISMATCH" | "NUMERIC_MISMATCH" | "POLARITY_MISMATCH";

export interface SetDiff {
  shared: string[];
  onlyA: string[];
  onlyB: string[];
}

export interface EntityParity {
  ok: boolean;
  verdict: "PARITY_OK" | "ENTITY_GUARD_VETO";
  reasons: ParityReason[];
  diff: { named: SetDiff; numeric: SetDiff; polarity: SetDiff };
}

// ---------------------------------------------------------------------------------------------
// Span bookkeeping
// ---------------------------------------------------------------------------------------------

/** Once a region is consumed by a more specific rule, later (more generic) rules skip it. */
class SpanMask {
  private readonly bits: Uint8Array;
  constructor(length: number) {
    this.bits = new Uint8Array(length);
  }
  free(start: number, end: number): boolean {
    for (let i = start; i < end; i++) if (this.bits[i]) return false;
    return true;
  }
  claim(start: number, end: number): void {
    this.bits.fill(1, start, end);
  }
}

interface Ctx {
  src: string;
  mask: SpanMask;
  named: Set<string>;
  numeric: Set<string>;
  /** Spans (identifiers, SEC forms) hidden from the polarity scan, e.g. `max_tokens`. */
  opaque: Array<[number, number]>;
}

/** Iterate every match of a global regex, passing absolute [start, end). */
function scan(re: RegExp, text: string, fn: (m: RegExpMatchArray, start: number, end: number) => void): void {
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    fn(m, start, start + m[0].length);
  }
}

/** Claim [start, end) for a numeric value if still free. */
function takeNumeric(ctx: Ctx, start: number, end: number, ...values: string[]): void {
  if (!ctx.mask.free(start, end)) return;
  ctx.mask.claim(start, end);
  for (const v of values) if (v) ctx.numeric.add(v);
}

function takeNamed(ctx: Ctx, start: number, end: number, value: string, opaque = false): void {
  if (!ctx.mask.free(start, end)) return;
  ctx.mask.claim(start, end);
  ctx.named.add(value);
  if (opaque) ctx.opaque.push([start, end]);
}

// ---------------------------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------------------------

/** 1:1 character replacements only, so offsets stay aligned with the input. */
function normaliseChars(text: string): string {
  return text.replace(/[‘’ʼ′]/g, "'").replace(/[“”]/g, '"').replace(/[\u00A0\u2007\u202F]/g, " ");
}

/** "1,200.50" -> "1200.5", "007" -> "7". */
function normNumber(intPart: string, frac?: string): string {
  const int = intPart.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const f = (frac ?? "").replace(/0+$/, "");
  return f ? `${int}.${f}` : int;
}

function expandYear(y: string): string {
  return y.length === 2 ? `20${y}` : y;
}

const MAGNITUDE: Record<string, string> = {
  thousand: "k",
  k: "k",
  million: "m",
  m: "m",
  mm: "m",
  billion: "b",
  b: "b",
  bn: "b",
  trillion: "t",
  t: "t",
};

const CURRENCY: Record<string, string> = {
  usd: "$",
  dollar: "$",
  dollars: "$",
  bucks: "$",
  eur: "€",
  euro: "€",
  euros: "€",
  gbp: "£",
  pound: "£",
  pounds: "£",
};

const ORDINAL_INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "inc", "ltd", "co", "jr", "sr", "st", "no", "fig", "approx", "dept", "est"]);

/** Is the word starting at `start` the first word of a sentence / line / list item? */
function isSentenceInitial(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && " \t\"'([{*#>-•–—_“‘".includes(text[i])) i--;
  if (i < 0) return true;
  return ".!?:;\n\r".includes(text[i]);
}

// ---------------------------------------------------------------------------------------------
// Regular expressions (all global; matchAll clones them, so sharing is safe)
// ---------------------------------------------------------------------------------------------

// Bounded repetitions keep every numeric pattern linear on adversarial input ("1,111,111,…" runs).
const NUM = String.raw`(\d{1,3}(?:,\d{3}){1,8}|\d{1,30})(?:\.(\d{1,15}))?`;
const MAG = String.raw`(?:\s?(thousand|million|billion|trillion|bn|mm)\b|([kmbt])(?![A-Za-z0-9_]))`;

const RE = {
  backtick: /`([^`\n]{1,80})`/g,
  identifierFull: /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$/,
  snake: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  dotted: /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,3}\b/g,
  camel: /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g,
  orgPhrase: new RegExp(
    String.raw`\b(?:${[...ORG_PHRASES]
      .map(([p]) => p)
      .sort((a, b) => b.length - a.length)
      .map((p) => escapeRegExp(p).replace(/ /g, String.raw`\s+`))
      .join("|")})\b`,
    "gi",
  ),
  secForm: new RegExp(SEC_FORM_SOURCE, "gi"),
  isoDate: /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
  yearMonth: /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])\b(?!-\d)/g,
  usDate: /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})\b/g,
  fy: /(^|[^A-Za-z])(FY\s?'?(\d{4}|\d{2}))(?![0-9])/gi,
  fiscal: /\bfiscal\s+(?:year\s+)?'?(\d{4}|\d{2})(?![0-9])/gi,
  quarter: /\bQ([1-4])(?![0-9])(?:\s?'(\d{2})(?![0-9]))?/gi,
  // "3Q26" / "3Q 2026" — upper-case Q only, so "3q" typos and units are left alone
  quarterAlt: /\b([1-4])Q(?:\s?'?((?:19|20)\d{2}|\d{2}))?(?![A-Za-z0-9])/g,
  quarterWord: /\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:fiscal\s+)?quarter\b/gi,
  // "H1" / "h2" / "1H" — but never "2h" (two hours)
  half: /\b[Hh]([12])(?![A-Za-z0-9])|\b([12])H(?![A-Za-z0-9])/g,
  halfWord: /\b(first|second|1st|2nd)\s+half\b/gi,
  percentile: /\bp(50|75|90|95|99|999|99\.9)(?![0-9A-Za-z])/gi,
  money: new RegExp(String.raw`([$€£¥])\s?${NUM}${MAG}?`, "gi"),
  moneyCode: new RegExp(String.raw`\b(usd|eur|gbp)\s?${NUM}${MAG}?`, "gi"),
  magnitude: new RegExp(String.raw`\b${NUM}${MAG}(?:\s+(dollars?|usd|bucks|euros?|eur|pounds?|gbp)\b)?`, "gi"),
  dollars: new RegExp(String.raw`\b${NUM}\s+(dollars?|usd|bucks|euros?|eur|pounds?|gbp)\b`, "gi"),
  percent: new RegExp(String.raw`\b${NUM}(?:\s?%|\s?(?:percent|per\s?cent|pct)\b)`, "gi"),
  bps: new RegExp(String.raw`\b${NUM}\s?(?:bps|basis\s+points?)\b`, "gi"),
  number: new RegExp(String.raw`\b${NUM}([A-Za-z]{1,3})?(?![A-Za-z0-9_])`, "g"),
  // groups: 1 tens + 2 unit ("twenty-five") | 3 single word; 4 optional scale ("five hundred")
  numberWord: new RegExp(
    String.raw`\b(?:(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b|(${[
      ...NUMBER_WORDS.keys(),
    ]
      .sort((a, b) => b.length - a.length)
      .join("|")})\b)(?:\s+(hundred|thousand|million|billion)\b)?`,
    "gi",
  ),
  month: /\b(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi,
  weekday: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi,
  word: /[A-Za-z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*'?/g,
};

const SCALE_WORDS: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const ORDINAL_SUFFIX = /^(?:st|nd|rd|th)?$/;
const ORG_PHRASE_CANONICAL: ReadonlyMap<string, string> = new Map(ORG_PHRASES.map(([p, c]) => [p, c] as const));
const ONE_EXCLUDED_PREV = new Set(["which", "each", "every", "any", "no", "some", "this", "that", "the", "someone", "anyone", "everyone", "last"]);
const ONE_EXCLUDED_NEXT = new Set(["of", "another"]);

// ---------------------------------------------------------------------------------------------
// Polarity: a single left-to-right pass over lower-case tokens. Multi-word expressions are
// checked at their first token and consume what they cover ("no more than" is "lt", never "not");
// context-sensitive words ("over", "up", "since", "min") look at their neighbours.
// ---------------------------------------------------------------------------------------------

const POLARITY_TOKEN_RE = /[a-z]+(?:['-][a-z]+)*|[$€£¥]?\d[\d,]*(?:\.\d+)?%?|[<>≤≥]=?/g;

const POLARITY_SINGLE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const put = (value: string, words: string) => {
    for (const w of words.split(" ")) map.set(w, value);
  };
  put("not", "not never none nor neither nobody nothing cannot dont doesnt didnt isnt arent wasnt werent hasnt havent hadnt wont wouldnt shouldnt couldnt cant aint");
  put("exclude", "without excluding exclude excludes excluded except");
  put("max", "highest maximum maximal max most top largest biggest greatest");
  put("min", "lowest minimum minimal least bottom smallest fewest");
  put("up", "increase increases increased increasing rise rises rising rose risen grow grows growing grown growth grew upward upwards upgrade upgrades upgraded upgrading");
  put("down", "decrease decreases decreased decreasing decline declines declined declining drop drops dropped dropping fall falls falling fallen fell downward downwards downgrade downgrades downgraded downgrading");
  put("asc", "ascending asc");
  put("desc", "descending desc");
  put("before", "before");
  put("after", "after");
  put("gt", "higher exceed exceeds exceeded exceeding");
  put("lt", "lower");
  return map;
})();

const MORE_WORDS = new Set(["more", "greater", "higher", "larger", "bigger"]);
const LESS_WORDS = new Set(["less", "fewer", "lower", "smaller"]);
const SCALE_VERBS = new Set(["scale", "scales", "scaled", "scaling", "ramp", "ramps", "ramped", "ramping"]);
/** Phrasal verbs whose particle is not a direction ("set up", "break down", "follow up", "back up"). */
const PHRASAL_VERB =
  /^(?:drill|break|broke|shut|set|sign|follow|look|wrap|clean|make|made|pick|show|end|back|sum|hold|held|line|mix|give|gave|take|took|catch|caught|put|keep|kept|settle|narrow|write|wrote|calm|track|hunt|let|tidy|fill|warm|cool)(?:s|ed|d|ing|ting|ped|ping|ning|ming)?$/;
const UP_TO_IDIOMS = new Set(["date", "speed", "you", "me", "us", "them", "now", "par", "scratch"]);
const DROP_OBJECTS = new Set([
  "table", "tables", "column", "columns", "index", "indexes", "database", "databases", "view", "views", "schema",
  "schemas", "constraint", "constraints", "trigger", "triggers", "function", "functions", "row", "rows", "key", "keys",
]);
const ARTICLES = new Set(["the", "a", "an", "our", "their", "its"]);
const SEASON_NOUNS = new Set(["semester", "term", "season"]);
const PRONOUNS = new Set(["we", "i", "you", "they", "it", "he", "she", "this", "that", "there", "these", "those"]);
const THRESHOLD_NOUNS = new Set([
  "average", "median", "mean", "threshold", "target", "baseline", "benchmark", "limit", "quota", "budget", "sla",
  "forecast", "expectation", "expectations", "consensus", "plan", "guidance",
]);
const SCALE_NOUNS = new Set(["hundred", "thousand", "million", "billion", "dozen"]);
function extractPolarity(lowered: string, opaque: Array<[number, number]>): Set<string> {
  let work = lowered;
  if (opaque.length) {
    const chars = lowered.split("");
    for (const [s, e] of opaque) for (let i = s; i < e; i++) chars[i] = " ";
    work = chars.join("");
  }
  const toks: string[] = [];
  const pos: number[] = [];
  for (const m of work.matchAll(POLARITY_TOKEN_RE)) {
    toks.push(m[0]);
    pos.push(m.index ?? 0);
  }
  const at = (k: number) => toks[k] ?? "";
  const isNumber = (t: string) => /^[$€£¥]?\d/.test(t);
  const numberish = (k: number) => {
    const t = at(k);
    if (isNumber(t) || t === "half" || NUMBER_WORDS.has(t)) return true;
    return t === "a" && (NUMBER_WORDS.has(at(k + 1)) || SCALE_NOUNS.has(at(k + 1)));
  };
  const threshold = (k: number) => THRESHOLD_NOUNS.has(ARTICLES.has(at(k)) ? at(k + 1) : at(k));

  const out = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const n1 = at(k + 1);
    const n2 = at(k + 2);

    // comparison operators in front of a number ("amount > 100", "≤ 5%"), but not arrows ("->", "=>")
    if (t[0] === ">" || t[0] === "≥") {
      if (isNumber(n1) && !/[-=]/.test(work[pos[k] - 1] ?? "")) out.add("gt");
      continue;
    }
    if (t[0] === "<" || t[0] === "≤") {
      if (isNumber(n1)) out.add("lt");
      continue;
    }

    // multi-word expressions
    if ((t === "no" || t === "not") && n2 === "than" && (MORE_WORDS.has(n1) || LESS_WORDS.has(n1))) {
      out.add(MORE_WORDS.has(n1) ? "lt" : "gt");
      k += 2;
      continue;
    }
    if (t === "on" && n1 === "top" && n2 === "of") {
      k += 2;
      continue;
    }
    if (t === "at" && (n1 === "most" || n1 === "least")) {
      out.add(n1 === "most" ? "lt" : "gt");
      k++;
      continue;
    }
    if (t === "up" && n1 === "to" && (numberish(k + 2) || UP_TO_IDIOMS.has(n2))) {
      if (numberish(k + 2)) out.add("lt");
      k++;
      continue;
    }
    if (n1 === "than" && (MORE_WORDS.has(t) || LESS_WORDS.has(t) || t === "earlier" || t === "later")) {
      out.add(MORE_WORDS.has(t) ? "gt" : LESS_WORDS.has(t) ? "lt" : t === "earlier" ? "before" : "after");
      k++;
      continue;
    }
    if (t === "prior" && n1 === "to") {
      out.add("before");
      k++;
      continue;
    }
    if (SCALE_VERBS.has(t) && (n1 === "up" || n1 === "down")) {
      out.add(n1);
      k++;
      continue;
    }
    if ((PHRASAL_VERB.test(t) && (n1 === "up" || n1 === "down")) || (t === "not" && n1 === "only") || ((t === "top" || t === "bottom") && n1 === "line")) {
      k++;
      continue;
    }
    if (/^drop(?:s|ped|ping)?$/.test(t) && (DROP_OBJECTS.has(n1) || (ARTICLES.has(n1) && DROP_OBJECTS.has(n2)))) {
      k += DROP_OBJECTS.has(n1) ? 1 : 2;
      continue;
    }
    if (t === "fall" && (/^(?:19|20)\d{2}$/.test(n1) || SEASON_NOUNS.has(n1))) {
      k++;
      continue;
    }

    // context-sensitive single words
    if (t === "above" || t === "over" || t === "below" || t === "under") {
      if (numberish(k + 1) || threshold(k + 1)) out.add(t === "above" || t === "over" ? "gt" : "lt");
      continue;
    }
    if (t === "since") {
      if (!PRONOUNS.has(n1)) out.add("after");
      continue;
    }
    if (t === "min") {
      if (!isNumber(at(k - 1))) out.add("min");
      continue;
    }
    if (t === "up" || t === "down") {
      out.add(t); // bare direction ("revenue is up", "down 5%"); phrasal idioms were consumed above
      continue;
    }
    if (t === "no" || t.endsWith("n't")) {
      out.add("not");
      continue;
    }
    const value = POLARITY_SINGLE.get(t);
    if (value) out.add(value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Extraction passes
// ---------------------------------------------------------------------------------------------

function passIdentifiers(ctx: Ctx): void {
  const { src } = ctx;
  scan(RE.backtick, src, (m, s, e) => {
    const inner = m[1].trim();
    if (RE.identifierFull.test(inner)) takeNamed(ctx, s, e, inner.toLowerCase(), true);
  });
  // table.column before snake_case, so "orders.created_at" stays one identifier
  scan(RE.dotted, src, (m, s, e) => {
    const parts = m[0].split(".");
    if (parts.some((p) => p.length < 2)) return;
    if (ABBREVIATIONS.has(m[0].toLowerCase())) return;
    if (parts.slice(1).some((p) => /^[A-Z]/.test(p))) return; // "end.The" — a missing space, not table.column
    if (s > 0 && /[@./\\]/.test(src[s - 1])) return; // part of an e-mail / path / longer dotted run
    const lower = m[0].toLowerCase();
    takeNamed(ctx, s, e, ORG_ALIASES.get(lower) ?? lower, true);
  });
  scan(RE.snake, src, (m, s, e) => takeNamed(ctx, s, e, m[0].toLowerCase(), true));
  scan(RE.camel, src, (m, s, e) => {
    const lower = m[0].toLowerCase();
    takeNamed(ctx, s, e, ORG_ALIASES.get(lower) ?? lower, true);
  });
}

function passOrgPhrases(ctx: Ctx): void {
  scan(RE.orgPhrase, ctx.src, (m, s, e) => {
    const value = ORG_PHRASE_CANONICAL.get(m[0].toLowerCase().replace(/\s+/g, " "));
    if (value) takeNamed(ctx, s, e, value);
  });
  scan(RE.secForm, ctx.src, (m, s, e) => takeNamed(ctx, s, e, m[0].toLowerCase().replace(/\s+/g, ""), true));
}

function passDatesAndPeriods(ctx: Ctx): void {
  const { src } = ctx;
  scan(RE.isoDate, src, (m, s, e) => takeNumeric(ctx, s, e, `${m[1]}-${m[2]}-${m[3]}`));
  scan(RE.usDate, src, (m, s, e) => takeNumeric(ctx, s, e, `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`));
  scan(RE.yearMonth, src, (m, s, e) => takeNumeric(ctx, s, e, `${m[1]}-${m[2]}`));
  scan(RE.fy, src, (m, s) => {
    const start = s + m[1].length;
    takeNumeric(ctx, start, start + m[2].length, `fy${expandYear(m[3])}`);
  });
  scan(RE.fiscal, src, (m, s, e) => takeNumeric(ctx, s, e, `fy${expandYear(m[1])}`));
  scan(RE.quarterWord, src, (m, s, e) => takeNumeric(ctx, s, e, `q${ORDINAL_INDEX[m[1].toLowerCase()]}`));
  scan(RE.halfWord, src, (m, s, e) => takeNumeric(ctx, s, e, `h${ORDINAL_INDEX[m[1].toLowerCase()]}`));
  scan(RE.quarter, src, (m, s, e) => takeNumeric(ctx, s, e, `q${m[1]}`, m[2] ? expandYear(m[2]) : ""));
  scan(RE.quarterAlt, src, (m, s, e) => takeNumeric(ctx, s, e, `q${m[1]}`, m[2] ? expandYear(m[2]) : ""));
  scan(RE.half, src, (m, s, e) => takeNumeric(ctx, s, e, `h${m[1] ?? m[2]}`));
  scan(RE.percentile, src, (m, s, e) => takeNumeric(ctx, s, e, `p${m[1]}`));
}

function passMoney(ctx: Ctx): void {
  const { src } = ctx;
  const mag = (word?: string, letter?: string) => MAGNITUDE[(word ?? letter ?? "").toLowerCase()] ?? "";
  scan(RE.money, src, (m, s, e) => takeNumeric(ctx, s, e, `${m[1]}${normNumber(m[2], m[3])}${mag(m[4], m[5])}`));
  scan(RE.moneyCode, src, (m, s, e) =>
    takeNumeric(ctx, s, e, `${CURRENCY[m[1].toLowerCase()]}${normNumber(m[2], m[3])}${mag(m[4], m[5])}`),
  );
  scan(RE.magnitude, src, (m, s, e) => {
    const symbol = m[5] ? CURRENCY[m[5].toLowerCase()] ?? "" : "";
    takeNumeric(ctx, s, e, `${symbol}${normNumber(m[1], m[2])}${mag(m[3], m[4])}`);
  });
  scan(RE.dollars, src, (m, s, e) => takeNumeric(ctx, s, e, `${CURRENCY[m[3].toLowerCase()] ?? "$"}${normNumber(m[1], m[2])}`));
  scan(RE.percent, src, (m, s, e) => takeNumeric(ctx, s, e, `${normNumber(m[1], m[2])}%`));
  scan(RE.bps, src, (m, s, e) => takeNumeric(ctx, s, e, `${normNumber(m[1], m[2])}bps`));
}

function passNumbers(ctx: Ctx): void {
  const { src } = ctx;
  scan(RE.number, src, (m, s, e) => {
    // ordinals fold to the number ("3rd" -> "3"); units and multipliers stay attached ("200ms", "10x", "1990s")
    const value = normNumber(m[1], m[2]);
    const suffix = (m[3] ?? "").toLowerCase();
    takeNumeric(ctx, s, e, ORDINAL_SUFFIX.test(suffix) ? value : `${value}${suffix}`);
  });

  scan(RE.numberWord, src, (m, s, e) => {
    const end = e;
    let value = m[1]
      ? (NUMBER_WORDS.get(m[1].toLowerCase()) ?? 0) + (NUMBER_WORDS.get(m[2].toLowerCase()) ?? 0)
      : NUMBER_WORDS.get(m[3].toLowerCase()) ?? 0;
    if (m[4]) value *= SCALE_WORDS[m[4].toLowerCase()] ?? 1;
    if (m[3]?.toLowerCase() === "one" && !m[4]) {
      const prev = /([A-Za-z-]+)\s*$/.exec(src.slice(Math.max(0, s - 16), s))?.[1]?.toLowerCase() ?? "";
      const next = /^\s*([A-Za-z]+)/.exec(src.slice(end, end + 16))?.[1]?.toLowerCase() ?? "";
      if (ONE_EXCLUDED_PREV.has(prev) || ONE_EXCLUDED_NEXT.has(next) || src[end] === "-") {
        ctx.mask.claim(s, end);
        return;
      }
    }
    const pct = /^\s?(?:%|percent\b|per\s?cent\b)/i.exec(src.slice(end, end + 10));
    if (pct) takeNumeric(ctx, s, end + pct[0].length, `${value}%`);
    else takeNumeric(ctx, s, end, String(value));
  });

  scan(RE.month, src, (m, s, e) => {
    const raw = m[1];
    const lower = raw.toLowerCase();
    const key = MONTHS.get(lower);
    if (!key) return;
    const capitalised = /^[A-Z]/.test(raw);
    const nearNumber = /^\.?,?\s*\d/.test(src.slice(e, e + 6)) || /\d\s*$/.test(src.slice(Math.max(0, s - 4), s));
    if (lower === "may" || lower === "march") {
      if (!((capitalised && !isSentenceInitial(src, s)) || nearNumber)) return;
    } else if (lower.length <= 4 && !capitalised && !nearNumber) {
      return;
    }
    takeNumeric(ctx, s, e, key);
  });
  scan(RE.weekday, src, (m, s, e) => takeNumeric(ctx, s, e, WEEKDAYS.get(m[1].toLowerCase()) ?? ""));
}

/** Strip possessives and contractions: "Apple's" -> "Apple", "don't" -> "do". */
function stripClitic(word: string): string {
  if (/^can't$/i.test(word)) return word.slice(0, 3);
  if (/^won't$/i.test(word)) return "will";
  return word.replace(/'(?:s|re|ve|ll|d|m)$/i, "").replace(/n't$/i, "").replace(/'$/, "");
}

function passWords(ctx: Ctx): void {
  const { src } = ctx;
  scan(RE.word, src, (m, s, e) => {
    if (s > 0 && /[A-Za-z0-9_$€£]/.test(src[s - 1])) return; // mid-token (e.g. the "x" in "10x")
    if (!ctx.mask.free(s, e)) return;
    const base = stripClitic(m[0]);
    if (!base) return;
    const lower = base.toLowerCase();

    const ticker = CAPS_ONLY_TICKERS.get(base);
    if (ticker) return takeNamed(ctx, s, e, ticker);
    const org = ORG_ALIASES.get(lower);
    if (org) return takeNamed(ctx, s, e, org);
    const capOnly = CAPITALISED_ONLY.get(lower);
    if (capOnly && /^[A-Z]/.test(base)) return takeNamed(ctx, s, e, capOnly);

    if (NUMBER_WORDS.has(lower) || MONTHS.has(lower) || WEEKDAYS.has(lower) || POLARITY_WORDS.has(lower)) return;
    if (!/^[A-Z]/.test(base)) return; // lower-case words are vocabulary

    // ALL-CAPS tokens (plural acronyms like "CRDTs" / "APIs" are folded to the singular first)
    const caps = /^[A-Z][A-Z0-9]+s$/.test(base) ? base.slice(0, -1) : base;
    if (caps.length >= 2 && caps === caps.toUpperCase()) {
      const capsLower = caps.toLowerCase();
      if (ACRONYM_STOPLIST.has(caps) || SQL_KEYWORDS.has(caps) || COMMON_WORDS.has(capsLower)) return;
      if (caps.length <= 6) return takeNamed(ctx, s, e, capsLower);
      // longer ALL-CAPS words are treated like shouted Capitalised words below
    }

    if (isSentenceInitial(src, s)) return;
    if (COMMON_WORDS.has(lower) || ACRONYM_STOPLIST.has(base.toUpperCase())) return;
    takeNamed(ctx, s, e, lower);
  });
}

const sorted = (set: Set<string>) => [...set].sort();

/** Each array is de-duplicated and sorted. */
export function extractEntities(text: string): EntitySet {
  const src = normaliseChars(text ?? "");
  const ctx: Ctx = { src, mask: new SpanMask(src.length), named: new Set(), numeric: new Set(), opaque: [] };
  passIdentifiers(ctx);
  passOrgPhrases(ctx);
  passDatesAndPeriods(ctx);
  passMoney(ctx);
  passNumbers(ctx);
  passWords(ctx);
  const polarity = extractPolarity(src.toLowerCase(), ctx.opaque);
  return { named: sorted(ctx.named), numeric: sorted(ctx.numeric), polarity: sorted(polarity) };
}

function setDiff(a: readonly string[], b: readonly string[]): SetDiff {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    shared: [...setA].filter((x) => setB.has(x)).sort(),
    onlyA: [...setA].filter((x) => !setB.has(x)).sort(),
    onlyB: [...setB].filter((x) => !setA.has(x)).sort(),
  };
}

/** Strict set equality per category; any difference vetoes. */
export function checkParity(a: EntitySet, b: EntitySet): EntityParity {
  const diff = {
    named: setDiff(a.named, b.named),
    numeric: setDiff(a.numeric, b.numeric),
    polarity: setDiff(a.polarity, b.polarity),
  };
  const reasons: ParityReason[] = [];
  if (diff.named.onlyA.length || diff.named.onlyB.length) reasons.push("NAMED_ENTITY_MISMATCH");
  if (diff.numeric.onlyA.length || diff.numeric.onlyB.length) reasons.push("NUMERIC_MISMATCH");
  if (diff.polarity.onlyA.length || diff.polarity.onlyB.length) reasons.push("POLARITY_MISMATCH");
  const ok = reasons.length === 0;
  return { ok, verdict: ok ? "PARITY_OK" : "ENTITY_GUARD_VETO", reasons, diff };
}
