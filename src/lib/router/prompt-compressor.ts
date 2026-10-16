/**
 * Prefix-cache friendly prompt compressor (LLMLingua-style filler / redundancy pruning).
 *
 * Deletion-only: every removed character is reported as a span, so the UI can render a diff and
 * concatenating all spans reproduces the input byte-for-byte. Deterministic output also keeps
 * upstream prefix caches warm across turns.
 */
import type { ChatMessage } from "../types";
import { checkParity, extractEntities } from "../cache/entity-guard";

export type CompressionReason = "filler" | "politeness" | "redundant" | "whitespace";

export interface CompressionSpan {
  text: string;
  kept: boolean;
  reason?: CompressionReason;
}

export interface CompressionResult {
  original: string;
  compressed: string;
  /** Concatenating every span's text, kept or not, reproduces `original` exactly. */
  spans: CompressionSpan[];
  tokensBefore: number;
  tokensAfter: number;
  /** 1 - tokensAfter / tokensBefore */
  savedRatio: number;
}

// ---------------------------------------------------------------------------------------------
// Token estimate
// ---------------------------------------------------------------------------------------------

/** CJK ideographs / kana / hangul (one token per character) and emoji / pictographs (two tokens). */
const CJK = "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff";
const EMOJI = String.raw`\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}`;
const ESTIMATE_RE = new RegExp(String.raw`[${CJK}]|[${EMOJI}]|\p{L}+|\p{N}+|\n+|[ \t]{2,}|[^\s\p{L}\p{N}]+`, "gu");
const CJK_RE = new RegExp(`^[${CJK}]$`);
const EMOJI_RE = new RegExp(`^[${EMOJI}]$`, "u");

/**
 * Cheap BPE-like token estimate (cl100k-ish): common words are one token, long words split every
 * ~6 characters, digits group in threes, CJK is one token per character, punctuation runs pair up.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const m of text.matchAll(ESTIMATE_RE)) {
    const s = m[0];
    const c = s[0];
    if (CJK_RE.test(s)) tokens += 1;
    else if (EMOJI_RE.test(s)) tokens += 2;
    else if (c === "\n") tokens += 1;
    else if (c === " " || c === "\t") tokens += Math.ceil(s.length / 4);
    else if (c >= "0" && c <= "9") tokens += Math.ceil(s.length / 3);
    else if (/^\p{L}/u.test(s)) tokens += s.length <= 9 ? 1 : Math.ceil(s.length / 6);
    else if (/^\p{N}/u.test(s)) tokens += Math.ceil(s.length / 3);
    else tokens += Math.ceil(s.length / 2);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

interface PhraseRule {
  re: RegExp;
  reason: CompressionReason;
  /** Only applies after a blank, which is removed with the phrase ("report for me?" -> "report?"). */
  eatLeadingBlank?: boolean;
}

/** Ordered: whole clauses before single words. Removed spans swallow their trailing blanks. */
const PHRASE_RULES: PhraseRule[] = [
  {
    reason: "politeness",
    re: /\b(?:thank\s+you|thanks)(?:\s+(?:so|very)\s+much|\s+a\s+(?:lot|bunch|ton))?(?:\s+in\s+advance)?(?:\s+for\s+(?:your|the)\s+(?:help|time|assistance))?(?=[ \t]*(?:[.!]+|$))[ \t]*/gim,
  },
  { reason: "politeness", re: /\bthank\s+you\s+so\s+much\s+in\s+advance\b[ \t]*/gi },
  { reason: "politeness", re: /\bas\s+an?\s+(?:AI|artificial\s+intelligence)(?:\s+language)?\s+model\b,?[ \t]*/gi },
  { reason: "politeness", re: /\bI\s+was\s+wondering\s+if\s+you\s+(?:could|can|would|might)\b[ \t]*/gi },
  { reason: "politeness", re: /\bI\s+would\s+(?:really\s+)?appreciate\s+(?:it\s+)?if\s+you\s+(?:could|can|would)\b[ \t]*/gi },
  { reason: "politeness", re: /\b(?:I\s+would|I'd|I’d)\s+like\s+you\s+to\b[ \t]*/gi },
  { reason: "politeness", re: /\b(?:could|can|would)\s+you\s+(?:please|kindly)\b[ \t]*/gi },
  { reason: "politeness", re: /(?:,[ \t]*)?\bplease\b,?[ \t]*/gi },
  { reason: "politeness", re: /\bkindly\b[ \t]*/gi },
  { reason: "politeness", re: /(?:,[ \t]*)?\bif\s+possible\b,?[ \t]*/gi },
  // "…the report for me?" (mid-sentence only; the preceding blank is removed with it, see eatLeadingBlank)
  { reason: "politeness", re: /\bfor\s+me\b(?=[ \t]*(?:[?.!,;:]|$))/gim, eatLeadingBlank: true },
  { reason: "filler", re: /\bneedless\s+to\s+say\b,?[ \t]*/gi },
  { reason: "filler", re: /\bit\s+is\s+(?:important|worth)\s+(?:to\s+note|noting)\s+that\b[ \t]*/gi },
  { reason: "filler", re: /\bas\s+(?:I\s+)?(?:mentioned|said)\s+(?:before|above|earlier)\b,?[ \t]*/gi },
  { reason: "filler", re: /\bin\s+order\s+(?=to\b)/gi },
  { reason: "filler", re: /\bbasically\b,?[ \t]*/gi },
  { reason: "filler", re: /\bactually\b,?[ \t]*/gi },
  { reason: "filler", re: /\bliterally\b[ \t]*/gi },
  { reason: "filler", re: /\bhonestly\b,?[ \t]*/gi },
  { reason: "filler", re: /\bjust\b(?![-'’])[ \t]*/gi },
  { reason: "filler", re: /\breally\b(?![-'’])[ \t]*/gi },
  { reason: "filler", re: /\bvery\b(?![-'’])[ \t]*/gi },
];

const NEGATION_RE = /\b(?:not|no|never|none|nor|neither|cannot|without)\b|n['’]t\b/i;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Code fences (``` ... ```, unterminated runs to the end), inline code and quotations are never touched. */
function protectedMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const mark = (s: number, e: number) => mask.fill(1, s, e);
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) mark(m.index ?? 0, (m.index ?? 0) + m[0].length);
  for (const m of text.matchAll(/`[^`\n]+`/g)) mark(m.index ?? 0, (m.index ?? 0) + m[0].length);
  for (const m of text.matchAll(/"[^"\n]{1,200}"|“[^”\n]{1,200}”/g)) mark(m.index ?? 0, (m.index ?? 0) + m[0].length);
  // single-quoted quotations: opening quote after a blank / bracket, closing quote before a non-letter
  for (const m of text.matchAll(/(^|[\s(\[])('[^'\n]{1,200}')(?![\p{L}\p{N}])/gmu)) {
    const start = (m.index ?? 0) + m[1].length;
    mark(start, start + m[2].length);
  }
  return mask;
}

/** First word of the text, a line, or a sentence (after . ! ? : and blanks / quotes / brackets). */
function isSentenceStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && " \t\"'([*-“‘".includes(text[i])) i--;
  return i < 0 || ".!?:;\n\r".includes(text[i]);
}

function anyIn(mask: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (mask[i]) return true;
  return false;
}

/** Sentence-ish units: text up to and including terminal punctuation or a newline. */
function sentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/[^.!?\n]+(?:[.!?]+|(?=\n)|$)|[.!?]+/g)) {
    if (m[0].length) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return out;
}

const normaliseSentence = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Collapse whitespace outside code fences; fences are copied verbatim. */
function tidy(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  const out = parts.map((part, i) =>
    i % 2 === 1
      ? part
      : part
          .replace(/[ \t]{2,}/g, " ")
          .replace(/[ \t]+([,.!?;:])/g, "$1")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n"),
  );
  return out.join("").trim();
}

// ---------------------------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------------------------

/** Never removes negations, numbers, named entities or fenced code. */
export function compressPrompt(text: string): CompressionResult {
  const original = text ?? "";
  const n = original.length;
  const reasons: Array<CompressionReason | null> = new Array(n).fill(null);
  const locked = protectedMask(original);
  const entities = extractEntities(original);
  const guarded = new Set([...entities.named, ...entities.numeric]);

  const removable = (start: number, end: number): boolean => {
    if (start >= end || anyIn(locked, start, end)) return false;
    for (let i = start; i < end; i++) if (reasons[i] !== null) return false;
    const segment = original.slice(start, end);
    if (/\d/.test(segment) || NEGATION_RE.test(segment)) return false;
    // a Capitalised filler word mid-sentence is probably part of a name ("Just Eat", "Very Good Co")
    if (/^[A-Z]/.test(segment) && !/^I\b/.test(segment) && !isSentenceStart(original, start)) return false;
    for (const word of segment.toLowerCase().match(/[\p{L}\p{N}_.'-]+/gu) ?? []) {
      if (guarded.has(word.replace(/'s$/, ""))) return false;
    }
    return true;
  };
  const mark = (start: number, end: number, reason: CompressionReason) => {
    for (let i = start; i < end; i++) reasons[i] = reason;
  };

  // 1. filler and politeness phrases
  for (const rule of PHRASE_RULES) {
    for (const m of original.matchAll(rule.re)) {
      let start = m.index ?? 0;
      const end = start + m[0].length;
      if (rule.eatLeadingBlank) {
        if (start === 0 || (original[start - 1] !== " " && original[start - 1] !== "\t")) continue;
        start--;
      }
      if (removable(start, end)) mark(start, end, rule.reason);
    }
  }

  // 2. redundant sentences (exact or near-duplicate repeats with identical entities)
  const units = sentences(original);
  const seen: Array<{ words: string[]; set: Set<string>; text: string }> = [];
  for (const [s, e] of units) {
    if (anyIn(locked, s, e)) continue;
    let kept = "";
    for (let i = s; i < e; i++) if (reasons[i] === null) kept += original[i];
    const words = normaliseSentence(kept);
    if (words.length < 3) continue;
    const set = new Set(words);
    const duplicate = seen.some((prev) => {
      if (prev.words.join(" ") === words.join(" ")) return true;
      if (words.length < 6) return false;
      let inter = 0;
      for (const w of set) if (prev.set.has(w)) inter++;
      const jaccard = inter / (set.size + prev.set.size - inter);
      return jaccard >= 0.85 && checkParity(extractEntities(prev.text), extractEntities(kept)).ok;
    });
    if (duplicate) {
      let end = e;
      while (end < n && (original[end] === " " || original[end] === "\t") && !locked[end]) end++;
      for (let i = s; i < end; i++) if (reasons[i] === null) reasons[i] = "redundant";
    } else {
      seen.push({ words, set, text: kept });
    }
  }

  // 3. a sentence whose every word was removed loses its dangling punctuation too
  for (const [s, e] of units) {
    if (anyIn(locked, s, e)) continue;
    let keptWord = false;
    const removedReasons = new Map<CompressionReason, number>();
    for (let i = s; i < e; i++) {
      const r = reasons[i];
      if (r === null) {
        if (/[\p{L}\p{N}]/u.test(original[i])) keptWord = true;
      } else removedReasons.set(r, (removedReasons.get(r) ?? 0) + 1);
    }
    if (keptWord || removedReasons.size === 0) continue;
    const dominant = [...removedReasons.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (let i = s; i < e; i++) if (reasons[i] === null) reasons[i] = dominant;
  }

  // 4. excess whitespace: leading / trailing blanks, runs of blanks, more than one empty line.
  //    Indentation after the last newline of a run is structure (nested lists) and is kept.
  for (const m of original.matchAll(/\s+/g)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (anyIn(locked, s, e)) continue;
    const strip = (i: number) => {
      if (reasons[i] === null) reasons[i] = "whitespace";
    };
    if (s === 0 || e === n) {
      for (let i = s; i < e; i++) strip(i);
      continue;
    }
    const lastNewline = m[0].lastIndexOf("\n");
    if (lastNewline < 0) {
      let keptOne = false;
      for (let i = s; i < e; i++) {
        if (reasons[i] !== null) continue;
        if (keptOne) strip(i);
        else keptOne = true;
      }
      continue;
    }
    let newlinesKept = 0;
    for (let i = s; i <= s + lastNewline; i++) {
      if (reasons[i] !== null) continue;
      if (original[i] === "\n" && newlinesKept < 2) newlinesKept++;
      else strip(i);
    }
  }

  // 5. spans + compressed text
  const spans: CompressionSpan[] = [];
  let keptText = "";
  for (let i = 0; i < n; ) {
    const r = reasons[i];
    let j = i + 1;
    while (j < n && reasons[j] === r) j++;
    const chunk = original.slice(i, j);
    if (r === null) {
      spans.push({ text: chunk, kept: true });
      keptText += chunk;
    } else {
      spans.push({ text: chunk, kept: false, reason: r });
    }
    i = j;
  }
  const compressed = tidy(keptText);
  const tokensBefore = estimateTokens(original);
  const tokensAfter = estimateTokens(compressed);
  const savedRatio = tokensBefore > 0 ? Math.max(0, 1 - tokensAfter / tokensBefore) : 0;
  return { original, compressed, spans, tokensBefore, tokensAfter, savedRatio };
}

export interface MessageCompression {
  messages: ChatMessage[];
  /** null for messages preserved verbatim (system prompt / static prefix). */
  results: Array<CompressionResult | null>;
  tokensBefore: number;
  tokensAfter: number;
  savedRatio: number;
  preservedPrefixTokens: number;
}

/**
 * System messages (the static prefix) are kept byte-identical so upstream prefix caching still applies.
 * Tool outputs are data and are also passed through verbatim (results[i] = null, not counted as prefix);
 * a message that would compress to nothing is kept as-is.
 */
export function compressMessages(messages: ChatMessage[]): MessageCompression {
  const out: ChatMessage[] = [];
  const results: Array<CompressionResult | null> = [];
  let tokensBefore = 0;
  let tokensAfter = 0;
  let preservedPrefixTokens = 0;

  for (const message of messages ?? []) {
    const content = message.content;
    if (typeof content !== "string") {
      out.push({ ...message });
      results.push(null);
      continue;
    }
    const tokens = estimateTokens(content);
    tokensBefore += tokens;
    if (message.role === "system" || message.role === "tool") {
      out.push({ ...message });
      results.push(null);
      tokensAfter += tokens;
      if (message.role === "system") preservedPrefixTokens += tokens;
      continue;
    }
    const result = compressPrompt(content);
    if (!result.compressed && content.trim()) {
      out.push({ ...message });
      results.push(null);
      tokensAfter += tokens;
      continue;
    }
    out.push({ ...message, content: result.compressed });
    results.push(result);
    tokensAfter += result.tokensAfter;
  }

  const savedRatio = tokensBefore > 0 ? Math.max(0, 1 - tokensAfter / tokensBefore) : 0;
  return { messages: out, results, tokensBefore, tokensAfter, savedRatio, preservedPrefixTokens };
}
