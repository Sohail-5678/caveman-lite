/**
 * Sub-4 ms learned complexity router: 12 features -> calibrated logistic P(complex | x).
 *
 * Every feature is a cheap lexical / structural count squashed into [0, 1] with 1 - exp(-x / k),
 * so a single strong signal saturates instead of dominating. The weights are hand-tuned (see
 * tests/router-pareto-security.test.ts for the calibration set) and exported with each result so
 * the UI can show per-feature contributions.
 */
import type { ChatRequestBody, Tier } from "../types";
import { estimateTokens } from "./prompt-compressor";

export const FEATURE_NAMES = [
  "token_length",
  "reasoning_markers",
  "multi_hop_constraints",
  "code_density",
  "ast_depth",
  "sql_density",
  "math_density",
  "tool_schema_complexity",
  "json_constraint_depth",
  "turn_depth",
  "question_count",
  "domain_jargon",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Short human labels for the UI, e.g. { token_length: "Context length", ... }. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  token_length: "Context length",
  reasoning_markers: "Reasoning markers",
  multi_hop_constraints: "Multi-hop constraints",
  code_density: "Code density",
  ast_depth: "AST nesting depth",
  sql_density: "SQL operators",
  math_density: "Math / LaTeX",
  tool_schema_complexity: "Tool schema",
  json_constraint_depth: "JSON constraints",
  turn_depth: "Conversation turns",
  question_count: "Sub-questions",
  domain_jargon: "Domain jargon",
};

export const ROUTER_THRESHOLD = 0.55;

export interface ComplexityResult {
  /** Each feature normalised to [0, 1]. */
  features: Record<FeatureName, number>;
  /** Same values in FEATURE_NAMES order. */
  vector: number[];
  weights: number[];
  bias: number;
  /** weights[i] * vector[i] */
  contributions: number[];
  logit: number;
  probability: number;
  tier: Tier;
  threshold: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------

/** Hand-tuned logistic weights, FEATURE_NAMES order. */
const WEIGHTS: readonly number[] = [
  1.6, // token_length
  2.4, // reasoning_markers
  1.4, // multi_hop_constraints
  2.0, // code_density
  0.8, // ast_depth
  1.6, // sql_density
  2.2, // math_density
  1.5, // tool_schema_complexity
  1.0, // json_constraint_depth
  0.8, // turn_depth
  1.0, // question_count
  2.4, // domain_jargon
];
const BIAS = -4.4;

const squash = (x: number, k: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / k));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------------------------
// Lexical signals
//
// One cheap tokenisation pass feeds every lexical feature: single words are looked up in weighted
// maps and multi-word phrases are found with indexOf on the space-joined token stream. Avoiding a
// few dozen large case-insensitive regexes keeps even the very first (cold) call well under 4 ms.
// ---------------------------------------------------------------------------------------------

type Weighted = ReadonlyMap<string, number>;

const weighted = (spec: string, weight = 1): Array<[string, number]> => spec.split(/\s+/).filter(Boolean).map((w) => [w, weight]);

/** Reasoning markers: words and phrases (prose only). */
const REASONING_WORDS: Weighted = new Map([
  ...weighted("prove proof derive derivation deduce infer step-by-step"),
  ...weighted("trade-off trade-offs tradeoff tradeoffs analyze analyse analysis evaluate assess critique justify"),
  ...weighted("design architect architecture estimate optimize optimise refactor debug diagnose implication implications"),
  ...weighted("compare comparison contrast versus vs", 0.6),
  ...weighted("why", 0.6),
  ...weighted("explain reasoning", 0.5),
]);
const REASONING_PHRASES: Weighted = new Map([
  ...weighted("step_by_step pros_and_cons root_cause find_the_bug find_the_error find_the_issue find_the_flaw"),
  ...weighted("think_through walk_through edge_case edge_cases failure_mode failure_modes"),
]);

/** Multi-hop constraints. */
const MULTI_HOP_WORDS: Weighted = new Map(
  weighted("then afterwards finally subsequently while whereas assuming must ensure guarantee constraint constraints requirement requirements per"),
);
const MULTI_HOP_PHRASES: Weighted = new Map(weighted("after_that such_that subject_to given_that provided_that for_each"));
const GROUPING_NOUNS = new Set(["cohort", "region", "segment", "month", "quarter", "customer", "group", "day", "week"]);

/** SQL operators: strong signals anywhere (code included), weak vocabulary in prose. */
const SQL_STRONG_WORDS: Weighted = new Map(weighted("select join joins having cte ctes sql rolling"));
const SQL_STRONG_PHRASES: Weighted = new Map(
  weighted("group_by order_by partition_by window_function window_functions union_all insert_into create_table query_plan explain_analyze explain_analyse"),
);
const SQL_WEAK_WORDS: Weighted = new Map(weighted("table tables column columns row rows query queries schema index indexes where from", 0.4));

/** Math vocabulary (prose). */
const MATH_WORDS: Weighted = new Map(
  weighted(
    "prove proof theorem lemma corollary derive derivation equation integral derivative probability distribution statistic statistics " +
      "hypothesis variance chi-square chisquare matrix convergence converges asymptotic polynomial logarithm binomial gaussian bayesian " +
      "p-value big-o complexity eigenvalue eigenvalues eigenvector eigenvectors",
  ),
);
const MATH_PHRASES: Weighted = new Map(
  weighted("degrees_of_freedom degree_of_freedom expected_value standard_deviation confidence_interval continuity_correction"),
);
const MATH_SYMBOLS = /[=^∑∫√≤≥±×÷πλσμχ²³∞∂∆]/g;
const LATEX = /\\(?:frac|sum|int|sqrt|alpha|beta|sigma|chi|mu|lambda|theta|cdot|leq|geq|infty|partial|mathbb|begin)\b|\$[^$\n]{1,80}\$/g;

/** Domain jargon: each group counts once (distinct concepts), members are words or phrases. */
const JARGON_GROUPS: ReadonlyArray<readonly string[]> = [
  ["crdt", "crdts"],
  ["last-write-wins", "lww"],
  ["active-active"],
  ["multi-region"],
  ["replication"],
  ["conflict_resolution"],
  ["raft", "paxos", "consensus_protocol"],
  ["shard", "shards", "sharding", "sharded"],
  ["idempotent", "idempotency"],
  ["linearizable", "linearizability", "eventual_consistency", "eventually_consistent"],
  ["p95", "p99", "p999"],
  ["throughput", "tail_latency"],
  ["mcnemar"],
  ["chi-square", "chisquare"],
  ["degrees_of_freedom", "degree_of_freedom"],
  ["null_hypothesis"],
  ["continuity_correction"],
  ["test_statistic"],
  ["window_function", "window_functions"],
  ["retention"],
  ["cohort", "cohorts"],
  ["query_plan"],
  ["recursion", "recursive"],
  ["time_complexity", "big-o"],
  ["memoization", "memoisation", "dynamic_programming"],
  ["mutex", "deadlock", "race_condition"],
  ["gradient", "backprop", "backpropagation", "transformer", "attention_head"],
  ["bayesian", "posterior", "markov", "stochastic"],
  ["kubernetes", "terraform", "service_mesh"],
  ["acid", "isolation_level", "serializable", "mvcc"],
];

/** Verbs that open a sub-task when they start a clause ("..., then explain ..."). */
const IMPERATIVES = new Set(
  (
    "find explain refactor compute calculate compare estimate derive prove design write summarize summarise list describe " +
    "implement optimize optimise analyze analyse evaluate identify translate create build generate outline propose suggest " +
    "rank classify debug fix"
  ).split(" "),
);
const CLAUSE_JOINERS = new Set(["and", "then"]);

/** Lower-case word tokens (hyphenated compounds kept) plus clause punctuation. */
const TOKEN_RE = /[a-z0-9]+(?:['-][a-z0-9]+)*|[.!?;:,\n]/g;

interface Lexicon {
  words: string[];
  counts: Map<string, number>;
  /** " w1 w2 w3 " for phrase lookups. */
  joined: string;
}

function lexicon(text: string): Lexicon {
  const tokens = text.toLowerCase().match(TOKEN_RE) ?? [];
  const words = tokens.filter((t) => t.length > 1 || /[a-z0-9]/.test(t));
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return { words, counts, joined: ` ${words.join(" ")} ` };
}

function phraseCount(lex: Lexicon, phrase: string): number {
  const needle = ` ${phrase.replace(/_/g, " ")} `;
  let n = 0;
  for (let i = lex.joined.indexOf(needle); i >= 0; i = lex.joined.indexOf(needle, i + needle.length - 1)) n++;
  return n;
}

function score(lex: Lexicon, words: Weighted, phrases?: Weighted): number {
  let total = 0;
  for (const [w, weight] of words) total += (lex.counts.get(w) ?? 0) * weight;
  if (phrases) for (const [p, weight] of phrases) total += phraseCount(lex, p) * weight;
  return total;
}

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** Imperative verbs at the start of a clause: text start, after . ! ? ; : , newline, or after "and" / "then". */
function imperativeClauses(tokens: string[]): number {
  let n = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!IMPERATIVES.has(tokens[i])) continue;
    const prev = i > 0 ? tokens[i - 1] : ".";
    if (prev.length === 1 && ".!?;:,\n".includes(prev)) n++;
    else if (CLAUSE_JOINERS.has(prev)) n++;
  }
  return n;
}

/** "by signup cohort", "per region": grouping constraints. */
function groupings(words: string[]): number {
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "by") continue;
    if (GROUPING_NOUNS.has(words[i + 1]) || GROUPING_NOUNS.has(words[i + 2])) n++;
  }
  return n;
}

/** Maximum nesting depth of a JSON-schema-like object. */
function objectDepth(value: unknown, depth = 0): number {
  if (depth > 32 || typeof value !== "object" || value === null) return depth;
  let max = depth + 1;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    if (typeof v === "object" && v !== null) max = Math.max(max, objectDepth(v, depth + 1));
  }
  return max;
}

function maxBracketDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") max = Math.max(max, ++depth);
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
  }
  return max;
}

function maxIndentLevel(code: string): number {
  let max = 0;
  for (const line of code.split("\n")) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const width = indent.replace(/\t/g, "    ").length;
    max = Math.max(max, Math.floor(width / 4) + (width % 4 >= 2 ? 1 : 0));
  }
  return max;
}

const CODE_LINE_START = /^\s*(?:def |class |function |async |const |let |var |import |from \S+ import|return\b|if\s*\(|for\s*\(|while\s*\(|#include|public |private |fn |func |package |SELECT\b)/;

/** A prose line that looks like code (keyword start, or ends with { ; } ) ]). */
function isCodeLine(line: string): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1];
  return last === "{" || last === ";" || /^\s*[}\])];?$/.test(trimmed) || CODE_LINE_START.test(trimmed);
}

// ---------------------------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------------------------

interface Parsed {
  text: string;
  turns: number;
  tools: unknown[];
  responseFormat: unknown;
}

function parseInput(input: string | ChatRequestBody): Parsed {
  if (typeof input === "string") return { text: input, turns: 1, tools: [], responseFormat: undefined };
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const text = messages
    .map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")))
    .join("\n\n");
  const turns = messages.filter((m) => m?.role === "user" || m?.role === "assistant").length;
  return { text, turns, tools: Array.isArray(input?.tools) ? input.tools : [], responseFormat: input?.response_format };
}

function computeFeatures(parsed: Parsed): number[] {
  const { text } = parsed;
  const fences = text.match(/```[\s\S]*?(?:```|$)/g) ?? [];
  const fencedChars = fences.reduce((sum, f) => sum + f.length, 0);
  const prose = fences.length ? text.replace(/```[\s\S]*?(?:```|$)/g, " ") : text;
  const codeBody = fences.map((f) => f.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")).join("\n");
  const proseLex = lexicon(prose);
  const allLex = fences.length ? lexicon(text) : proseLex;
  const proseTokens = prose.toLowerCase().match(TOKEN_RE) ?? [];

  // 1. context length
  const tokenLength = squash(estimateTokens(text), 150);

  // 2. reasoning markers
  const reasoning = squash(score(proseLex, REASONING_WORDS, REASONING_PHRASES), 2);

  // 3. multi-hop constraints: sequencing words, ", and" / ", then" joins, groupings, lists, semicolons
  const joins = count(prose, /,\s*(?:and|then)\s/g);
  const listItems = count(prose, /^[ \t]*(?:\d{1,3}[.)]|[-*•])[ \t]+/gm);
  const semicolons = count(prose, /;/g);
  const multiHop = squash(
    score(proseLex, MULTI_HOP_WORDS, MULTI_HOP_PHRASES) + joins + groupings(proseLex.words) + 0.5 * (listItems + semicolons),
    3,
  );

  // 4. code density: fenced share, code-looking lines, inline code, symbol density
  const fencedShare = text.length ? fencedChars / text.length : 0;
  const codeLines = prose.split("\n").filter(isCodeLine).length;
  const inlineCode = count(prose, /`[^`\n]+`/g);
  const symbols = count(prose, /[{}()[\];=<>]/g);
  const symbolsPer100 = prose.length ? (symbols / prose.length) * 100 : 0;
  const code = clamp01(
    Math.max(Math.min(1, fencedShare * 1.5), squash(codeLines, 4), squash(inlineCode, 3) * 0.6, squash(symbolsPer100 - 1, 6)),
  );

  // 5. AST nesting depth: bracket nesting or indentation inside code
  const depth = Math.max(maxBracketDepth(text), fences.length ? maxIndentLevel(codeBody) + 1 : 0);
  const ast = squash(depth - 1, 2.5);

  // 6. SQL operators
  const overParen = count(text, /\bover\s*\(/gi);
  const sql = squash(score(allLex, SQL_STRONG_WORDS, SQL_STRONG_PHRASES) + overParen + score(proseLex, SQL_WEAK_WORDS), 3);

  // 7. math / LaTeX
  const eigen = proseLex.words.filter((w) => w.startsWith("eigen") && !MATH_WORDS.has(w)).length;
  const math = squash(score(proseLex, MATH_WORDS, MATH_PHRASES) + eigen + 0.5 * count(prose, MATH_SYMBOLS) + count(text, LATEX), 3);

  // 8. tool schema complexity
  let toolScore = 0;
  for (const tool of parsed.tools) {
    const fn = (tool as { function?: { parameters?: { properties?: Record<string, unknown> } } })?.function;
    const props = fn?.parameters?.properties ? Object.keys(fn.parameters.properties).length : 0;
    toolScore += 1 + props / 3 + Math.max(0, objectDepth(fn?.parameters) - 2) / 2;
  }
  const toolSchema = squash(toolScore, 4);

  // 9. JSON constraints: response_format depth + explicit format demands in the prose
  const rf = parsed.responseFormat as { type?: string; json_schema?: { schema?: unknown } } | undefined;
  const rfDepth = rf?.type === "json_schema" ? 1 + objectDepth(rf.json_schema?.schema ?? rf.json_schema) : rf?.type === "json_object" ? 1 : 0;
  const formatMentions = ["json", "schema", "yaml", "xml"].reduce((n, w) => n + (proseLex.counts.get(w) ?? 0), 0);
  const json = squash(rfDepth + 0.5 * formatMentions, 3);

  // 10. conversation turns
  const turns = squash(Math.max(0, parsed.turns - 1), 3);

  // 11. sub-questions: question marks plus imperative clauses
  const asks = count(prose, /\?/g) + imperativeClauses(proseTokens);
  const questions = squash(Math.max(0, asks - 1), 2);

  // 12. domain jargon (distinct concepts, code included)
  let jargonHits = 0;
  for (const group of JARGON_GROUPS) {
    if (group.some((m) => (m.includes("_") ? phraseCount(allLex, m) > 0 : allLex.counts.has(m)))) jargonHits++;
  }
  const jargon = squash(jargonHits, 3);

  return [tokenLength, reasoning, multiHop, code, ast, sql, math, toolSchema, json, turns, questions, jargon].map(clamp01);
}

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/** 12 normalised features in FEATURE_NAMES order. Strings are treated as a single user message. */
export function extractFeatures(input: string | ChatRequestBody): number[] {
  return computeFeatures(parseInput(input));
}

export function classifyComplexity(input: string | ChatRequestBody, threshold: number = ROUTER_THRESHOLD): ComplexityResult {
  const t0 = now();
  const vector = extractFeatures(input);
  const contributions = vector.map((x, i) => WEIGHTS[i] * x);
  const logit = BIAS + contributions.reduce((a, b) => a + b, 0);
  const probability = 1 / (1 + Math.exp(-logit));
  const features = Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, vector[i]])) as Record<FeatureName, number>;
  return {
    features,
    vector,
    weights: [...WEIGHTS],
    bias: BIAS,
    contributions,
    logit,
    probability,
    tier: probability >= threshold ? "frontier" : "fast",
    threshold,
    elapsedMs: now() - t0,
  };
}
