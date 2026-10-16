/**
 * Tier 2 — local 384-dim semantic vector cache with adaptive threshold and entity guard.
 *
 * The embedding is a deterministic, dependency-free stand-in for a MiniLM-class sentence encoder.
 * It deliberately reproduces that model family's best-known failure mode: paraphrases land close
 * together, but so do prompts that differ only in an entity, a number or a polarity word, because
 * those tokens mostly project onto a shared per-type direction. The entity guard exists to catch that.
 *
 *   text -> tokens -> lower-case -> phrase folding -> light stemming -> synonym clusters
 *        -> unigram (typed projection for ORG / QUARTER / YEAR / NUMBER / ... tokens)
 *         + bigram (order sensitivity, entity-abstracted) + character trigram features
 *        -> signed feature hashing (FNV-1a) into 384 dims -> L2 normalisation
 */
import { fnv1a, gaussian, mulberry32 } from "../utils/prng";
import { checkParity, extractEntities } from "./entity-guard";
import type { EntityParity, EntitySet } from "./entity-guard";
import { CAPITALISED_ONLY, CAPS_ONLY_TICKERS, MONTHS, NUMBER_WORDS, ORG_ALIASES, ORG_PHRASES, WEEKDAYS } from "./lexicon";

export const EMBEDDING_DIM = 384;
export const DEFAULT_THRESHOLD = 0.94;
export const SHORT_QUERY_THRESHOLD = 0.97;
export const SHORT_QUERY_TOKENS = 12;

// ---------------------------------------------------------------------------------------------
// Model hyper-parameters (hand-tuned against tests/embedding-calibration.test.ts)
// ---------------------------------------------------------------------------------------------

type TokenType =
  | "ORG"
  | "QUARTER"
  | "YEAR"
  | "NUMBER"
  | "MONEY"
  | "PERCENT"
  | "MONTH"
  | "SUPERLATIVE"
  | "COMPARATIVE"
  | "NEGATION"
  | "EXCLUDE"
  | "TEMPORAL"
  | "DIRECTION"
  | "ORDER"
  | "FORM";

/**
 * weight: contribution of one token of this type; share: fraction of its energy on the shared type
 * direction, i.e. the cosine between two different tokens of the same type ("apple" vs "microsoft").
 */
const TYPE_PARAMS: Record<TokenType, { weight: number; share: number }> = {
  ORG: { weight: 1.35, share: 0.84 },
  QUARTER: { weight: 1.0, share: 0.86 },
  YEAR: { weight: 0.9, share: 0.86 },
  NUMBER: { weight: 0.7, share: 0.82 },
  MONEY: { weight: 0.9, share: 0.86 },
  PERCENT: { weight: 0.8, share: 0.86 },
  MONTH: { weight: 0.8, share: 0.86 },
  SUPERLATIVE: { weight: 0.9, share: 0.9 },
  COMPARATIVE: { weight: 0.7, share: 0.88 },
  NEGATION: { weight: 0.45, share: 1 },
  EXCLUDE: { weight: 0.5, share: 0.9 },
  TEMPORAL: { weight: 0.6, share: 0.88 },
  DIRECTION: { weight: 0.8, share: 0.88 },
  ORDER: { weight: 0.5, share: 0.9 },
  FORM: { weight: 0.9, share: 0.86 },
};

const CONTENT_WEIGHT = 1.0;
const STOP_WEIGHT = 0.12;
const INTERROGATIVE_WEIGHT = 0.18;
const BIGRAM_WEIGHT = 0.34;
const TRIGRAM_WEIGHT = 0.45;
const UNIGRAM_SLOTS = 2;

// ---------------------------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a an the of in on at to for with by from into onto upon about as and or but if then than so is are was were be " +
    "been being am do does did done doing have has had having it its this that these those there here i me my mine " +
    "myself we us our ours you your yours he him his she her hers they them their theirs will would shall should can " +
    "could may might must please kindly just really very also too along via per any some such own same other another " +
    "up down out off over under above below again further once both either etc e.g i.e let lets ok okay hey hi hello " +
    "thanks thank like within whether while because although though yet basically actually s"
  ).split(/\s+/),
);

const INTERROGATIVES = new Set(["what", "which", "who", "whom", "whose", "when", "where", "why", "how"]);

/** Polarity / comparison words: typed tokens so that "highest" and "lowest" stay close. */
const TYPED_WORDS: ReadonlyMap<string, [TokenType, string]> = (() => {
  const map = new Map<string, [TokenType, string]>();
  const put = (type: TokenType, key: string, words: string) => {
    for (const w of words.split(/\s+/)) map.set(w, [type, key]);
  };
  put("SUPERLATIVE", "max", "highest maximum maximal max most top largest biggest greatest best peak");
  put("SUPERLATIVE", "min", "lowest minimum minimal min least bottom smallest fewest worst");
  put("NEGATION", "not", "not never no none nor neither nobody nothing");
  put("EXCLUDE", "exclude", "without excluding exclude excludes excluded except");
  put("TEMPORAL", "before", "before");
  put("TEMPORAL", "after", "after since");
  put("DIRECTION", "up", "increase increases increased increasing rise rises rising rose risen grow grows growing grew grown growth gain gains");
  put("DIRECTION", "down", "decrease decreases decreased decreasing decline declines declined declining drop drops dropped dropping fall falls falling fell fallen shrink shrinks shrank");
  put("ORDER", "asc", "ascending asc");
  put("ORDER", "desc", "descending desc");
  put("COMPARATIVE", "gt", "higher greater exceed exceeds exceeded exceeding");
  put("COMPARATIVE", "lt", "lower fewer");
  return map;
})();

/** Synonym clusters folded to one canonical concept token (matched on the stem). */
const SYNONYM_CLUSTERS: ReadonlyArray<readonly [string, string]> = [
  ["revenue", "revenue revenues sales sale income turnover topline"],
  ["profit", "profit profits earnings profitability"],
  ["refund", "refund refunds refunded reimbursement reimbursements reimburse repayment chargeback"],
  ["window", "window period timeframe deadline duration"],
  ["customer", "customer customers client clients user users account accounts buyer buyers subscriber subscribers consumer consumers"],
  ["cancel", "cancel cancels cancelled canceled cancelling canceling cancellation cancellations terminate terminated termination unsubscribe"],
  ["summarize", "summarize summarise summarizes summarized summary summaries overview recap tldr synopsis"],
  ["show", "show shows list lists display give find get fetch retrieve return provide enumerate"],
  ["compare", "compare compares compared comparing comparison versus vs contrast"],
  ["forecast", "expectation expectations estimate estimates consensus forecast forecasts guidance projection projections outlook prediction predictions"],
  ["churn", "churn churned attrition defection"],
  ["contract", "contract contracts agreement agreements subscription subscriptions"],
  ["all", "all every each entire whole"],
  ["explain", "explain explains explained explanation describe description elaborate clarify illustrate"],
  ["bug", "bug bugs error errors defect defects fault glitch"],
  ["fix", "fix fixes repair resolve patch remedy"],
  ["create", "create make build generate write compose draft produce"],
  ["delete", "delete remove erase purge"],
  ["company", "company companies firm firms business businesses organization organisation organizations corporation"],
  ["employee", "employee employees staff worker workers headcount personnel"],
  ["price", "price prices pricing"],
  ["region", "region regions area areas geography geographies territory territories"],
  ["column", "column columns field fields attribute attributes"],
  ["row", "row rows record records"],
  ["database", "database databases db datastore"],
  ["annual", "annual yearly annually"],
  ["report", "report reports filing filings"],
  ["risk", "risk risks threat threats hazard"],
  ["key", "key main primary principal core"],
  ["quick", "quick fast rapid speedy"],
  ["large", "large big huge massive"],
  ["small", "small little tiny"],
  ["help", "help assist assistance"],
  ["need", "need needs require requires want wants"],
  ["purchase", "purchase purchases buy buys bought"],
  ["start", "start begin launch initiate"],
  ["prevent", "prevent prevents avoid mitigate"],
  ["use", "use uses using utilize utilise leverage employ"],
  ["improve", "improve optimize optimise enhance boost"],
  ["analyze", "analyze analyse analysis examine evaluate assess review"],
  ["last", "last past previous recent preceding trailing"],
  ["renew", "renew renewal renewals"],
  ["translate", "translate translation"],
  ["question", "question questions query"],
];

/** Low-information content words (generic verbs, quantifiers). */
const GENERIC_WEIGHTS: ReadonlyMap<string, number> = new Map([
  ["show", 0.55],
  ["need", 0.5],
  ["help", 0.5],
  ["use", 0.6],
  ["all", 0.5],
  ["tell", 0.5],
  ["know", 0.5],
  ["want", 0.5],
  ["long", 0.6],
]);

/** Multi-word expressions folded before classification (longest match wins). */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["how long", "__q:how_long"],
  ["how many", "__q:how_many"],
  ["how much", "__q:how_much"],
  ["in order to", "__stop:to"],
  ["along with", "__stop:with"],
  ["as well as", "__stop:and"],
  ["prior to", "__t:TEMPORAL:before"],
  ["earlier than", "__t:TEMPORAL:before"],
  ["later than", "__t:TEMPORAL:after"],
  ["more than", "__t:COMPARATIVE:gt"],
  ["greater than", "__t:COMPARATIVE:gt"],
  ["higher than", "__t:COMPARATIVE:gt"],
  ["at least", "__t:COMPARATIVE:gt"],
  ["less than", "__t:COMPARATIVE:lt"],
  ["fewer than", "__t:COMPARATIVE:lt"],
  ["lower than", "__t:COMPARATIVE:lt"],
  ["at most", "__t:COMPARATIVE:lt"],
  ["no more than", "__t:COMPARATIVE:lt"],
  ["first quarter", "__t:QUARTER:q1"],
  ["second quarter", "__t:QUARTER:q2"],
  ["third quarter", "__t:QUARTER:q3"],
  ["fourth quarter", "__t:QUARTER:q4"],
  ["first half", "__t:QUARTER:h1"],
  ["second half", "__t:QUARTER:h2"],
  ["time frame", "window"],
  ["money back", "refund"],
  ["walk through", "explain"],
  ["sum up", "summarize"],
  ["top line", "revenue"],
  ["step by step", "stepbystep"],
  ["last write wins", "lww"],
  ["kick off", "start"],
  ...ORG_PHRASES.map(([phrase, canonical]) => [phrase.replace(/-/g, " "), `__t:ORG:${canonical}`] as const),
];

const PHRASE_INDEX: ReadonlyMap<string, Array<{ words: string[]; emit: string }>> = (() => {
  const index = new Map<string, Array<{ words: string[]; emit: string }>>();
  for (const [phrase, emit] of PHRASES) {
    const words = phrase.split(" ");
    const list = index.get(words[0]) ?? [];
    list.push({ words, emit });
    index.set(words[0], list);
  }
  for (const list of index.values()) list.sort((a, b) => b.words.length - a.words.length);
  return index;
})();

const SEC_FORM = /^(?:10-k|10-q|8-k|6-k|11-k|s-1|s-3|s-4|20-f|40-f|13f|13d|13g)$/;
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "dr", "inc", "ltd"]);

// ---------------------------------------------------------------------------------------------
// Light stemmer + synonym folding
// ---------------------------------------------------------------------------------------------

function undouble(w: string): string {
  const n = w.length;
  if (n >= 3 && w[n - 1] === w[n - 2] && !"aeiouylsfz".includes(w[n - 1])) return w.slice(0, -1);
  return w;
}

/** Suffix-stripping stemmer: plural, -ed, -ing and a final silent "e" (porter-lite). */
function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.endsWith("ied") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ed") && w.length > 4) w = undouble(w.slice(0, -2));
  else if (w.endsWith("ing") && w.length > 5) w = undouble(w.slice(0, -3));
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

const STEM_SYNONYMS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [canonical, members] of SYNONYM_CLUSTERS) {
    map.set(stem(canonical), canonical);
    for (const m of members.split(/\s+/)) map.set(stem(m), canonical);
  }
  return map;
})();

// ---------------------------------------------------------------------------------------------
// Tokenisation & classification
// ---------------------------------------------------------------------------------------------

interface Token {
  key: string;
  type: TokenType | null;
  weight: number;
  /** Participates in bigrams (content and typed tokens; not stop words / interrogatives). */
  content: boolean;
  /** Contributes character trigrams (untyped content words only). */
  subword: boolean;
}

// Numeric repetitions are bounded so that a pathological "1,1,1,…" run cannot trigger quadratic backtracking.
const TOKEN_RE =
  /[$€£¥]\s?\d[\d,]{0,24}(?:\.\d{1,12})?(?:\s?(?:thousand|million|billion|trillion|bn|mm)\b|[kmbt]\b)?|\d[\d,]{0,24}(?:\.\d{1,12})?\s?(?:%|percent\b)|[\p{L}\p{N}_]+(?:['.\-][\p{L}\p{N}_]+)*/giu;

interface RawToken {
  lower: string;
  raw: string;
}

function normNumber(text: string): string {
  const cleaned = text.replace(/,/g, "");
  const [int, frac = ""] = cleaned.split(".");
  const i = int.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

const MAGNITUDE: Record<string, string> = { thousand: "k", k: "k", million: "m", m: "m", mm: "m", billion: "b", b: "b", bn: "b", trillion: "t", t: "t" };

/** Split one regex token into words: contractions, hyphenated compounds, possessives. */
function expandRawToken(raw: string, out: RawToken[]): void {
  const lower = raw.toLowerCase();
  if (/^[$€£¥]/.test(raw) || /(?:%|percent)$/i.test(raw)) {
    out.push({ lower, raw });
    return;
  }
  if (lower.includes("'")) {
    const m = /^(.*?)(n't|'s|'re|'ve|'ll|'d|'m|')$/.exec(lower);
    if (m) {
      let base = m[1];
      let baseRaw = raw.slice(0, base.length);
      if (m[2] === "n't") {
        if (base === "ca") base = baseRaw = "can";
        else if (base === "wo") base = baseRaw = "will";
      }
      if (base) expandRawToken(baseRaw || base, out);
      if (m[2] === "n't") out.push({ lower: "not", raw: "not" });
      return;
    }
  }
  if (lower.includes("-") && !SEC_FORM.test(lower)) {
    for (const part of raw.split("-")) if (part) expandRawToken(part, out);
    return;
  }
  out.push({ lower, raw });
}

function classify(t: RawToken): Token {
  const w = t.lower;
  const typed = (type: TokenType, key: string): Token => ({ key, type, weight: TYPE_PARAMS[type].weight, content: true, subword: false });
  const stop = (key: string, weight = STOP_WEIGHT): Token => ({ key, type: null, weight, content: false, subword: false });

  if (/^[$€£¥]/.test(w)) {
    const m = /^([$€£¥])\s?([\d,]+(?:\.\d+)?)\s?([a-z]*)$/.exec(w);
    return typed("MONEY", m ? `${m[1]}${normNumber(m[2])}${MAGNITUDE[m[3]] ?? ""}` : w);
  }
  if (/(?:%|percent)$/.test(w)) return typed("PERCENT", `${normNumber(w.replace(/\s?(?:%|percent)$/, ""))}%`);
  if (/^\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?$/.test(w)) {
    const n = normNumber(w.replace(/(?:st|nd|rd|th)$/, ""));
    const v = Number(n);
    return Number.isInteger(v) && v >= 1990 && v <= 2039 ? typed("YEAR", n) : typed("NUMBER", n);
  }
  if (/^\d+(?:ms|s|m|h|d|w|x|k|gb|mb|kb|tb|b)$/.test(w)) return typed("NUMBER", w);
  const numberWord = NUMBER_WORDS.get(w);
  if (numberWord !== undefined) return typed("NUMBER", String(numberWord));
  if (/^q[1-4]$/.test(w) || /^h[12]$/.test(w)) return typed("QUARTER", w);
  if (/^[1-4]q$/.test(w)) return typed("QUARTER", `q${w[0]}`);
  const fy = /^fy'?(\d{2}|\d{4})$/.exec(w);
  if (fy) return typed("YEAR", `fy${fy[1].length === 2 ? `20${fy[1]}` : fy[1]}`);
  if (/^p(?:50|75|90|95|99|999)$/.test(w)) return typed("NUMBER", w);
  if (SEC_FORM.test(w)) return typed("FORM", w);

  const org = CAPS_ONLY_TICKERS.get(t.raw) ?? ORG_ALIASES.get(w) ?? (/^[A-Z]/.test(t.raw) ? CAPITALISED_ONLY.get(w) : undefined);
  if (org) return typed("ORG", org);
  const month = MONTHS.get(w);
  if (month && ((w !== "may" && w !== "march" && w.length > 3) || /^[A-Z]/.test(t.raw))) return typed("MONTH", month);
  const weekday = WEEKDAYS.get(w);
  if (weekday) return typed("MONTH", weekday);
  const polar = TYPED_WORDS.get(w);
  if (polar) return typed(polar[0], polar[1]);

  if (STOPWORDS.has(w)) return stop(w);
  if (INTERROGATIVES.has(w)) return stop(w, INTERROGATIVE_WEIGHT);
  if (ABBREVIATIONS.has(w)) return stop(w);

  // identifiers (snake_case, table.column, file.ext) are kept verbatim
  const key = /[_.]/.test(w) ? w : STEM_SYNONYMS.get(stem(w)) ?? stem(w);
  return { key, type: null, weight: GENERIC_WEIGHTS.get(key) ?? CONTENT_WEIGHT, content: true, subword: true };
}

function fromPhrase(emit: string, raw: string): Token | RawToken {
  if (emit.startsWith("__q:")) return { key: emit.slice(4), type: null, weight: INTERROGATIVE_WEIGHT, content: false, subword: false };
  if (emit.startsWith("__stop:")) return { key: emit.slice(7), type: null, weight: STOP_WEIGHT, content: false, subword: false };
  if (emit.startsWith("__t:")) {
    const [, type, ...rest] = emit.split(":");
    const t = type as TokenType;
    return { key: rest.join(":"), type: t, weight: TYPE_PARAMS[t].weight, content: true, subword: false };
  }
  return { lower: emit, raw };
}

function isToken(x: Token | RawToken): x is Token {
  return (x as Token).weight !== undefined;
}

/** Text -> classified tokens (exported for diagnostics / tests via `analyzeForEmbedding`). */
function analyze(text: string): Token[] {
  const normalised = text.replace(/[‘’ʼ]/g, "'").normalize("NFKC");
  const raws: RawToken[] = [];
  for (const m of normalised.matchAll(TOKEN_RE)) expandRawToken(m[0].replace(/[.']+$/, ""), raws);

  const tokens: Token[] = [];
  for (let i = 0; i < raws.length; i++) {
    const w = raws[i].lower;
    // "fiscal year 2026" / "fiscal 2026" / "fy 26"
    if ((w === "fiscal" || w === "fy") && i + 1 < raws.length) {
      let j = i + 1;
      if (raws[j].lower === "year" && j + 1 < raws.length) j++;
      const y = raws[j].lower;
      if (/^\d{2}$|^\d{4}$/.test(y)) {
        tokens.push(classify({ lower: `fy${y.length === 2 ? `20${y}` : y}`, raw: `fy${y}` }));
        i = j;
        continue;
      }
    }
    const candidates = PHRASE_INDEX.get(w);
    let matched = false;
    if (candidates) {
      for (const { words, emit } of candidates) {
        if (i + words.length > raws.length) continue;
        let ok = true;
        for (let k = 1; k < words.length && ok; k++) ok = raws[i + k].lower === words[k];
        if (!ok) continue;
        const produced = fromPhrase(emit, raws[i].raw);
        tokens.push(isToken(produced) ? produced : classify(produced));
        i += words.length - 1;
        matched = true;
        break;
      }
    }
    if (!matched) tokens.push(classify(raws[i]));
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Feature hashing
// ---------------------------------------------------------------------------------------------

const SLOT_SEEDS = [0x811c9dc5, 0x01000193 ^ 0x5bd1e995, 0x2545f491, 0x9e3779b9];

function addHashed(acc: Float64Array, feature: string, weight: number, slots: number): void {
  const scale = weight / Math.sqrt(slots);
  for (let j = 0; j < slots; j++) {
    const h = fnv1a(feature, SLOT_SEEDS[j]);
    const sign = ((h >>> 11) ^ (h >>> 27)) & 1 ? -1 : 1;
    acc[h % EMBEDDING_DIM] += sign * scale;
  }
}

/** Shared unit direction per entity type (dense, seeded, deterministic). */
const TYPE_VECTORS: Record<TokenType, Float64Array> = (() => {
  const out = {} as Record<TokenType, Float64Array>;
  for (const type of Object.keys(TYPE_PARAMS) as TokenType[]) {
    const rand = mulberry32(fnv1a(`type-direction:${type}`));
    const v = new Float64Array(EMBEDDING_DIM);
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      v[i] = gaussian(rand);
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
    out[type] = v;
  }
  return out;
})();

function addToken(acc: Float64Array, t: Token): void {
  if (t.type) {
    const { share } = TYPE_PARAMS[t.type];
    const shared = t.weight * Math.sqrt(share);
    const dir = TYPE_VECTORS[t.type];
    for (let i = 0; i < EMBEDDING_DIM; i++) acc[i] += shared * dir[i];
    if (share < 1) addHashed(acc, `t:${t.type}:${t.key}`, t.weight * Math.sqrt(1 - share), UNIGRAM_SLOTS);
    return;
  }
  addHashed(acc, `u:${t.key}`, t.weight, UNIGRAM_SLOTS);
  if (t.subword && t.key.length >= 3) {
    const padded = `#${t.key}#`;
    const n = padded.length - 2;
    const w = (t.weight * TRIGRAM_WEIGHT) / Math.sqrt(n);
    for (let i = 0; i < n; i++) addHashed(acc, `c:${padded.slice(i, i + 3)}`, w, 1);
  }
}

/** Deterministic L2-normalised embedding (feature-hashed n-grams + semantic lexicon projection), < 3 ms. */
export function embed(text: string): Float32Array {
  const acc = new Float64Array(EMBEDDING_DIM);
  const tokens = analyze(text ?? "");
  for (const t of tokens) addToken(acc, t);

  // bigrams over the content sequence; typed tokens are abstracted to their type so that an
  // entity swap does not also rewrite the surrounding structure
  let prev: Token | null = null;
  for (const t of tokens) {
    if (!t.content) continue;
    if (prev) {
      const a = prev.type ? `<${prev.type}>` : prev.key;
      const b = t.type ? `<${t.type}>` : t.key;
      addHashed(acc, `b:${a}|${b}`, BIGRAM_WEIGHT * Math.sqrt(prev.weight * t.weight), 1);
    }
    prev = t;
  }

  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += acc[i] * acc[i];
  const out = new Float32Array(EMBEDDING_DIM);
  if (norm === 0) return out;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = acc[i] * inv;
  return out;
}

/** Diagnostics: the token stream the embedding sees (key, type, weight). Not used on the hot path. */
export function analyzeForEmbedding(text: string): Array<{ key: string; type: string | null; weight: number }> {
  return analyze(text).map(({ key, type, weight }) => ({ key, type, weight }));
}

/** Cosine similarity; safe for zero vectors (returns 0). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / Math.sqrt(na * nb);
  return Math.max(-1, Math.min(1, sim));
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu;

/** Word-level token count used by the adaptive threshold. */
export function countTokens(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const _ of text.matchAll(WORD_RE)) n++;
  return n;
}

/** SHORT_QUERY_THRESHOLD when countTokens(text) < SHORT_QUERY_TOKENS, otherwise `base`. */
export function adaptiveThreshold(text: string, base: number = DEFAULT_THRESHOLD): number {
  return countTokens(text) < SHORT_QUERY_TOKENS ? SHORT_QUERY_THRESHOLD : base;
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

export type SemanticVerdict = "HIT" | "MISS_BELOW_THRESHOLD" | "ENTITY_GUARD_VETO" | "EMPTY";

export interface SemanticEntry<V> {
  id: string;
  text: string;
  vector: Float32Array;
  entities: EntitySet;
  value: V;
  insertedAt: number;
}

export interface SemanticNeighbor<V> {
  entry: SemanticEntry<V>;
  similarity: number;
}

export interface SemanticLookup<V> {
  verdict: SemanticVerdict;
  hit: boolean;
  /** HIT: the matched entry. VETO: highest-similarity vetoed candidate. MISS: nearest neighbour. EMPTY: null. */
  best: SemanticNeighbor<V> | null;
  /** Threshold actually applied (adaptive). */
  threshold: number;
  /** best.similarity >= threshold */
  candidate: boolean;
  /** Parity of `best` against the query (HIT / VETO only). */
  parity: EntityParity | null;
  /** Top-k neighbours, similarity descending. */
  neighbors: SemanticNeighbor<V>[];
  vector: Float32Array;
  entities: EntitySet;
  /** Would a naive cache (fixed base threshold, no entity guard) have served a hit? */
  naiveHit: boolean;
}

export interface SemanticCacheOptions {
  baseThreshold?: number;
  capacity?: number;
  entityGuard?: boolean;
  topK?: number;
}

/**
 * Brute-force cosine index (exact; a few thousand entries scan in ~1 ms) with LRU capacity eviction.
 * Parity is computed as checkParity(cached entry, query): diff.onlyA = cached, diff.onlyB = query.
 */
export class SemanticCache<V> {
  private readonly baseThreshold: number;
  private readonly capacity: number;
  private readonly entityGuard: boolean;
  private readonly topK: number;
  /** Least-recently-used first. */
  private items: SemanticEntry<V>[] = [];
  private seq = 0;
  private counters = { hits: 0, misses: 0, vetoes: 0 };

  constructor(options?: SemanticCacheOptions) {
    this.baseThreshold = options?.baseThreshold ?? DEFAULT_THRESHOLD;
    this.capacity = Math.max(1, Math.floor(options?.capacity ?? 1000));
    this.entityGuard = options?.entityGuard !== false;
    this.topK = Math.max(1, Math.floor(options?.topK ?? 5));
  }

  /** Candidates (sim >= threshold) are checked in similarity order; the first with parity wins. */
  lookup(text: string): SemanticLookup<V> {
    const vector = embed(text);
    const entities = extractEntities(text);
    const threshold = adaptiveThreshold(text, this.baseThreshold);

    if (this.items.length === 0) {
      this.counters.misses++;
      return { verdict: "EMPTY", hit: false, best: null, threshold, candidate: false, parity: null, neighbors: [], vector, entities, naiveHit: false };
    }

    const ranked: SemanticNeighbor<V>[] = this.items
      .map((entry) => ({ entry, similarity: cosine(vector, entry.vector) }))
      .sort((a, b) => b.similarity - a.similarity || b.entry.insertedAt - a.entry.insertedAt);
    const neighbors = ranked.slice(0, this.topK);
    const naiveHit = ranked[0].similarity >= this.baseThreshold;
    const base = { threshold, neighbors, vector, entities, naiveHit };

    const candidates = ranked.filter((n) => n.similarity >= threshold);
    if (candidates.length === 0) {
      this.counters.misses++;
      return { ...base, verdict: "MISS_BELOW_THRESHOLD", hit: false, best: ranked[0], candidate: false, parity: null };
    }

    if (!this.entityGuard) {
      const best = candidates[0];
      this.touch(best.entry);
      this.counters.hits++;
      // parity is still reported so a UI can show what the guard would have said
      return { ...base, verdict: "HIT", hit: true, best, candidate: true, parity: checkParity(best.entry.entities, entities) };
    }

    let firstVeto: { best: SemanticNeighbor<V>; parity: EntityParity } | null = null;
    for (const candidate of candidates) {
      const parity = checkParity(candidate.entry.entities, entities);
      if (parity.ok) {
        this.touch(candidate.entry);
        this.counters.hits++;
        return { ...base, verdict: "HIT", hit: true, best: candidate, candidate: true, parity };
      }
      firstVeto ??= { best: candidate, parity };
    }
    this.counters.vetoes++;
    const veto = firstVeto as { best: SemanticNeighbor<V>; parity: EntityParity };
    return { ...base, verdict: "ENTITY_GUARD_VETO", hit: false, best: veto.best, candidate: true, parity: veto.parity };
  }

  /** Inserting text that is already cached replaces its value (and refreshes recency) instead of duplicating it. */
  insert(text: string, value: V, insertedAt: number = Date.now()): SemanticEntry<V> {
    const existing = this.items.findIndex((e) => e.text === text);
    if (existing >= 0) {
      const [entry] = this.items.splice(existing, 1);
      const updated: SemanticEntry<V> = { ...entry, value, insertedAt };
      this.items.push(updated);
      return updated;
    }
    this.seq++;
    const entry: SemanticEntry<V> = {
      id: `sem_${String(this.seq).padStart(4, "0")}`,
      text,
      vector: embed(text),
      entities: extractEntities(text),
      value,
      insertedAt,
    };
    this.items.push(entry);
    while (this.items.length > this.capacity) this.items.shift();
    return entry;
  }

  /** Entries from least- to most-recently used. */
  entries(): SemanticEntry<V>[] {
    return [...this.items];
  }

  /** Drops every entry and resets the counters (ids keep increasing). */
  clear(): void {
    this.items = [];
    this.counters = { hits: 0, misses: 0, vetoes: 0 };
  }

  get size(): number {
    return this.items.length;
  }

  /** misses include EMPTY lookups; vetoes are counted separately from misses. */
  get stats(): { hits: number; misses: number; vetoes: number } {
    return { ...this.counters };
  }

  private touch(entry: SemanticEntry<V>): void {
    const index = this.items.indexOf(entry);
    if (index >= 0 && index !== this.items.length - 1) {
      this.items.splice(index, 1);
      this.items.push(entry);
    }
  }
}
