/**
 * Sub-10 ms pre-flight firewall: OWASP LLM01 injection blocking, spotlighting, PII redaction, canary scan.
 *
 * Detection runs on a "view" of the prompt with invisible characters removed and full-width ASCII
 * folded, so "ign\u200Bore previous instructions" cannot slip past the rules; every reported offset
 * is mapped back to the original text. Hidden ASCII encoded in Unicode tag characters is decoded and
 * scanned too.
 */

export type FirewallCategory =
  | "INSTRUCTION_OVERRIDE"
  | "SYSTEM_PROMPT_EXFIL"
  | "SECRET_EXFIL"
  | "JAILBREAK_PERSONA"
  | "UNICODE_SMUGGLING"
  | "DELIMITER_INJECTION";

export interface FirewallHit {
  ruleId: string;
  category: FirewallCategory;
  owasp: "LLM01" | "LLM02" | "LLM07";
  /** Short human description, e.g. "Instruction override". */
  label: string;
  /** Matched substring (tag characters rendered as \u{E00xx} escapes). */
  match: string;
  index: number;
}

export type PiiType = "SSN" | "CREDIT_CARD" | "API_KEY" | "EMAIL";

export interface Redaction {
  type: PiiType;
  original: string;
  /** "[REDACTED:SSN]" | "[REDACTED:CARD]" | "[REDACTED:API_KEY]" | "[REDACTED:EMAIL]" */
  replacement: string;
  /** Offsets into the original text. */
  start: number;
  end: number;
}

export type FirewallVerdict = "PASS" | "PASS_REDACTED" | "BLOCKED";

export interface FirewallResult {
  verdict: FirewallVerdict;
  allowed: boolean;
  hits: FirewallHit[];
  redactions: Redaction[];
  /** PII replaced, invisible/bidi/tag characters stripped. */
  sanitized: string;
  /** `<UNTRUSTED_PROMPT_${nonce}>\n${sanitized}\n</UNTRUSTED_PROMPT_${nonce}>` */
  spotlighted: string;
  /** 6 lowercase hex chars. */
  nonce: string;
  elapsedMs: number;
}

export const CANARY_TOKEN = "CANARY-GATEWAY-VAULT-99";

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

interface Rule {
  id: string;
  category: FirewallCategory;
  owasp: FirewallHit["owasp"];
  label: string;
  re: RegExp;
}

const TARGET_NOUN = String.raw`(?:instructions?|directions?|rules?|prompts?|guidelines?|directives?|commands?|guardrails?|constraints?|polic(?:y|ies))`;
const SECRET_OWNER = String.raw`(?:your|the|all|our|any|stored|saved|configured|internal|gateway|server|system|backend|admin|production|prod)`;
const SECRET_NOUN = String.raw`(?:api[\s_-]?keys?|secret[\s_-]?keys?|secrets(?!\s+(?:of|to|for|behind)\b)|access[\s_-]?tokens?|auth(?:entication)?[\s_-]?tokens?|bearer[\s_-]?tokens?|refresh[\s_-]?tokens?|session[\s_-]?tokens?|tokens|credentials?|passwords?|private[\s_-]?keys?|env(?:ironment)?\s+var(?:iable)?s?)`;
const DEVICE = String.raw`(?:android|ios|iphone|ipad|chrome|firefox|edge|safari|windows|mac|macos|linux|kindle|switch|playstation|ps\d|xbox|roku|firestick|your\s+(?:phone|device|browser)|my\s+(?:phone|device|browser))`;

const RULES: Rule[] = [
  // --- LLM01: instruction override
  {
    id: "override-previous-instructions",
    category: "INSTRUCTION_OVERRIDE",
    owasp: "LLM01",
    label: "Instruction override",
    re: new RegExp(
      String.raw`\b(?:ignore|disregard|forget|override|bypass|discard|abandon)\b(?:\W+\w+){0,4}?\W+(?:previous|prior|above|earlier|preceding|former|original|initial|existing|all|your|any|system)\W+(?:\w+\W+){0,2}?${TARGET_NOUN}\b`,
      "i",
    ),
  },
  {
    id: "new-instructions",
    category: "INSTRUCTION_OVERRIDE",
    owasp: "LLM01",
    label: "Injected instruction block",
    re: /\b(?:new|updated|revised|real|actual|admin)\s+(?:system\s+)?instructions?\s*:/i,
  },
  {
    id: "from-now-on-ignore",
    category: "INSTRUCTION_OVERRIDE",
    owasp: "LLM01",
    label: "Persistent instruction override",
    re: /\bfrom\s+now\s+on\b(?:\W+\w+){0,6}?\W+(?:ignore|disregard|forget|bypass|override|no\s+longer\s+follow|not\s+follow)\b/i,
  },
  {
    id: "forget-everything",
    category: "INSTRUCTION_OVERRIDE",
    owasp: "LLM01",
    label: "Context wipe",
    re: /\bforget\s+(?:everything|all(?:\s+of\s+it)?)\s+(?:you\s+(?:were|have\s+been)\s+(?:told|given)|above|before|so\s+far)\b/i,
  },
  // --- LLM07: system prompt leakage
  {
    id: "reveal-system-prompt",
    category: "SYSTEM_PROMPT_EXFIL",
    owasp: "LLM07",
    label: "System prompt exfiltration",
    re: /\b(?:print|reveal|show|output|repeat|display|leak|dump|expose|recite|tell|give|write\s+out|spell\s+out|share)\b(?:\W+(?:me|us|your|the|my|its|exact|full|entire|whole|complete|current|verbatim|all|of|back)){0,4}?(?:\W+(?:system|hidden|initial|original|secret|internal|developer|confidential)){1,2}\W+(?:prompt|instructions?|message|rules|guidelines|directives|configuration)\b/i,
  },
  {
    id: "repeat-everything-above",
    category: "SYSTEM_PROMPT_EXFIL",
    owasp: "LLM07",
    label: "Context echo request",
    re: /\b(?:repeat|print|output|echo|reproduce)\s+(?:back\s+)?(?:everything|all(?:\s+of\s+it)?|the\s+(?:text|words|content|messages?|lines))\s+(?:above|before\s+this|so\s+far|preceding|verbatim)\b/i,
  },
  {
    id: "what-were-you-told",
    category: "SYSTEM_PROMPT_EXFIL",
    owasp: "LLM07",
    label: "Pre-conversation instruction probe",
    re: /\bwhat\s+(?:exactly\s+)?(?:were|was|have)\s+you\s+(?:been\s+)?(?:told|instructed|given|programmed|prompted)\b(?:\W+\w+){0,6}?\W+(?:before|prior|at\s+the\s+(?:start|beginning))\b|\bwhat\s+(?:instructions|rules|guidelines|prompt)\s+(?:were|have)\s+you\s+(?:been\s+)?(?:given|told|provided)\b/i,
  },
  {
    id: "whats-your-system-prompt",
    category: "SYSTEM_PROMPT_EXFIL",
    owasp: "LLM07",
    label: "System prompt probe",
    re: /\bwhat(?:'s|\s+is|\s+are|\s+was)\s+(?:in\s+)?your\s+(?:system\s+prompt|system\s+message|initial\s+instructions|hidden\s+instructions|original\s+instructions)\b/i,
  },
  // --- LLM02: secrets
  {
    id: "secret-exfil",
    category: "SECRET_EXFIL",
    owasp: "LLM02",
    label: "Secret exfiltration",
    re: new RegExp(
      String.raw`\b(?:reveal|print|show|list|dump|leak|output|display|expose|echo|cat|give\s+me|tell\s+me|send\s+me|read\s+out)\b[^.\n?!]{0,60}?(?:\b${SECRET_OWNER}\s+(?:[\w-]+\s+)?${SECRET_NOUN}\b|process\.env\b|\.env\s+file\b)`,
      "i",
    ),
  },
  {
    id: "gateway-secret-name",
    category: "SECRET_EXFIL",
    owasp: "LLM02",
    label: "Gateway secret name",
    re: /\b(?:GROQ_API_KEY|GEMINI_API_KEY|GATEWAY_ADMIN_TOKEN)\b/i,
  },
  // --- LLM01: jailbreak personas
  {
    id: "dan-persona",
    category: "JAILBREAK_PERSONA",
    owasp: "LLM01",
    label: "Jailbreak persona",
    re: /\byou\s+are\s+(?:now\s+)?(?:DAN|STAN|DUDE|AIM|an?\s+(?:unrestricted|unfiltered|uncensored|evil|rogue|jailbroken)\s+(?:AI|assistant|model|chatbot|LLM))\b/i,
  },
  { id: "do-anything-now", category: "JAILBREAK_PERSONA", owasp: "LLM01", label: "DAN jailbreak", re: /\bdo\s+anything\s+now\b/i },
  {
    id: "developer-mode",
    category: "JAILBREAK_PERSONA",
    owasp: "LLM01",
    label: "Developer-mode jailbreak",
    re: new RegExp(
      String.raw`\b(?:enable|activate|enter|switch\s+(?:to|into)|turn\s+on|you\s+are\s+(?:now\s+)?in)\s+(?:the\s+)?developer\s+mode\b(?!\s+(?:on|in|for)\s+${DEVICE})|\bdeveloper\s+mode\s+(?:enabled|activated|output|response)\b`,
      "i",
    ),
  },
  {
    id: "jailbreak-keyword",
    category: "JAILBREAK_PERSONA",
    owasp: "LLM01",
    label: "Jailbreak attempt",
    re: new RegExp(String.raw`\bjailbr(?:eak|oken|eaking|eaked)\b(?!\s+(?:(?:my|an?|the|your)\s+)?${DEVICE})`, "i"),
  },
  {
    id: "no-restrictions",
    category: "JAILBREAK_PERSONA",
    owasp: "LLM01",
    label: "Guardrail removal",
    re: /\b(?:without|with\s+no|free\s+(?:of|from))\s+(?:any\s+)?(?:restrictions|filters|limitations|censorship|guardrails|safety\s+(?:guidelines|rules|filters))\b|\b(?:pretend|act\s+as\s+if|imagine)\s+(?:that\s+)?you\s+(?:have|had)\s+no\s+(?:rules|restrictions|guidelines|filters|limits)\b/i,
  },
  // --- LLM01: delimiter / chat-template injection
  {
    id: "spotlight-delimiter",
    category: "DELIMITER_INJECTION",
    owasp: "LLM01",
    label: "Spotlight delimiter injection",
    re: /<\s*\/?\s*UNTRUSTED_PROMPT/i,
  },
  {
    id: "role-delimiter",
    category: "DELIMITER_INJECTION",
    owasp: "LLM01",
    label: "Chat-template role delimiter",
    re: /<\|im_(?:start|end)\|>|<\|(?:system|assistant|user)\|>|<<\/?SYS>>|\[\/?INST\]/i,
  },
];

// ---------------------------------------------------------------------------------------------
// Unicode handling
// ---------------------------------------------------------------------------------------------

const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const isBidi = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const isZeroWidth = (cp: number) => (cp >= 0x200b && cp <= 0x200d) || cp === 0x2060 || cp === 0xfeff;
/** Characters stripped from the sanitized text and the detection view. */
const isInvisible = (cp: number) => isTag(cp) || isBidi(cp) || isZeroWidth(cp) || cp === 0x00ad || cp === 0x200e || cp === 0x200f;

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");

/** Render invisible code points as \u{XXXX} escapes so they are visible in the UI. */
function renderInvisible(text: string, max = 120): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isInvisible(cp) ? `\\u{${hex(cp)}}` : ch;
    if (out.length >= max) return `${out.slice(0, max)}…`;
  }
  return out;
}

interface View {
  /** Text with invisible characters removed and full-width ASCII folded (1:1 per kept code unit). */
  text: string;
  /** view index -> original index (UTF-16 code units). */
  map: number[];
  /** ASCII payload hidden in tag characters, if any. */
  tagPayload: string;
  firstTagIndex: number;
  firstBidiIndex: number;
  zeroWidth: number[];
  tagRun: string;
}

function buildView(original: string): View {
  let text = "";
  const map: number[] = [];
  let tagPayload = "";
  let tagRun = "";
  let firstTagIndex = -1;
  let firstBidiIndex = -1;
  const zeroWidth: number[] = [];
  for (let i = 0; i < original.length; ) {
    const cp = original.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    if (isInvisible(cp)) {
      if (isTag(cp)) {
        if (firstTagIndex < 0) firstTagIndex = i;
        if (cp >= 0xe0020 && cp <= 0xe007e) tagPayload += String.fromCharCode(cp - 0xe0000);
        if (tagRun.length < 64) tagRun += original.slice(i, i + width);
      } else if (isBidi(cp)) {
        if (firstBidiIndex < 0) firstBidiIndex = i;
      } else if (isZeroWidth(cp)) {
        zeroWidth.push(i);
      }
    } else if (cp >= 0xff01 && cp <= 0xff5e) {
      text += String.fromCharCode(cp - 0xfee0); // full-width ASCII -> ASCII
      map.push(i);
    } else {
      for (let k = 0; k < width; k++) {
        text += original[i + k];
        map.push(i + k);
      }
    }
    i += width;
  }
  return { text, map, tagPayload, firstTagIndex, firstBidiIndex, zeroWidth, tagRun };
}

// ---------------------------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------------------------

const API_KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|ant-(?:api\d{2}-)?|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
];
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
// bounded quantifiers keep matching linear on adversarial input ("a.a.a.a…" without an @)
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;

const REPLACEMENT: Record<PiiType, string> = {
  SSN: "[REDACTED:SSN]",
  CREDIT_CARD: "[REDACTED:CARD]",
  API_KEY: "[REDACTED:API_KEY]",
  EMAIL: "[REDACTED:EMAIL]",
};

export function luhnValid(digits: string): boolean {
  const clean = (digits ?? "").replace(/[\s-]/g, "");
  if (clean.length < 2 || !/^\d+$/.test(clean)) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface ViewSpan {
  type: PiiType;
  start: number;
  end: number;
}

function findPii(view: string): ViewSpan[] {
  const spans: ViewSpan[] = [];
  const overlaps = (s: number, e: number) => spans.some((x) => s < x.end && e > x.start);
  const add = (type: PiiType, s: number, e: number) => {
    if (!overlaps(s, e)) spans.push({ type, start: s, end: e });
  };
  for (const re of API_KEY_PATTERNS) for (const m of view.matchAll(re)) add("API_KEY", m.index ?? 0, (m.index ?? 0) + m[0].length);
  for (const m of view.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits) || !luhnValid(digits)) continue;
    add("CREDIT_CARD", m.index ?? 0, (m.index ?? 0) + m[0].length);
  }
  for (const m of view.matchAll(SSN_RE)) add("SSN", m.index ?? 0, (m.index ?? 0) + m[0].length);
  if (view.includes("@")) for (const m of view.matchAll(EMAIL_RE)) add("EMAIL", m.index ?? 0, (m.index ?? 0) + m[0].length);
  return spans.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function randomNonce(): string {
  const bytes = new Uint8Array(3);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function inspectPrompt(text: string, options?: { nonce?: string }): FirewallResult {
  const t0 = now();
  const original = text ?? "";
  const view = buildView(original);
  const hits: FirewallHit[] = [];

  /** Map a [start, end) range of the view back onto the original text. */
  const originalRange = (s: number, e: number): [number, number] => {
    if (view.map.length === 0) return [0, 0];
    const start = view.map[Math.min(s, view.map.length - 1)];
    const lastIndex = view.map[Math.min(e - 1, view.map.length - 1)];
    const lastCp = original.codePointAt(lastIndex) ?? 0;
    return [start, lastIndex + (lastCp > 0xffff ? 2 : 1)];
  };

  for (const rule of RULES) {
    const m = rule.re.exec(view.text);
    if (m) {
      const [s, e] = originalRange(m.index, m.index + m[0].length);
      hits.push({ ruleId: rule.id, category: rule.category, owasp: rule.owasp, label: rule.label, match: renderInvisible(original.slice(s, e)), index: s });
    } else if (view.tagPayload) {
      // instructions hidden in invisible tag characters
      const hidden = rule.re.exec(view.tagPayload);
      if (hidden) {
        hits.push({
          ruleId: rule.id,
          category: rule.category,
          owasp: rule.owasp,
          label: `${rule.label} (hidden in tag characters)`,
          match: renderInvisible(view.tagRun),
          index: view.firstTagIndex,
        });
      }
    }
  }

  if (view.firstTagIndex >= 0) {
    hits.push({
      ruleId: "unicode-tag-characters",
      category: "UNICODE_SMUGGLING",
      owasp: "LLM01",
      label: "Invisible Unicode tag characters",
      match: renderInvisible(view.tagRun),
      index: view.firstTagIndex,
    });
  }
  if (view.firstBidiIndex >= 0) {
    hits.push({
      ruleId: "unicode-bidi-override",
      category: "UNICODE_SMUGGLING",
      owasp: "LLM01",
      label: "Bidirectional override characters",
      match: renderInvisible(original.slice(view.firstBidiIndex, view.firstBidiIndex + 1)),
      index: view.firstBidiIndex,
    });
  }
  if (view.zeroWidth.length >= 3) {
    hits.push({
      ruleId: "unicode-zero-width",
      category: "UNICODE_SMUGGLING",
      owasp: "LLM01",
      label: `Zero-width characters (${view.zeroWidth.length})`,
      match: view.zeroWidth
        .slice(0, 12)
        .map((i) => `\\u{${hex(original.charCodeAt(i))}}`)
        .join(""),
      index: view.zeroWidth[0],
    });
  }
  hits.sort((a, b) => a.index - b.index || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));

  // PII is detected on the view (so invisible separators cannot hide a number); the sanitized text is
  // the original with invisible characters stripped (no other normalisation) and PII replaced.
  const pii = findPii(view.text);
  const stripped = view.map.map((i) => original[i]).join("");
  const redactions: Redaction[] = [];
  let sanitized = "";
  let cursor = 0;
  for (const span of pii) {
    const [start, end] = originalRange(span.start, span.end);
    redactions.push({ type: span.type, original: original.slice(start, end), replacement: REPLACEMENT[span.type], start, end });
    sanitized += stripped.slice(cursor, span.start) + REPLACEMENT[span.type];
    cursor = span.end;
  }
  sanitized += stripped.slice(cursor);

  const verdict: FirewallVerdict = hits.length > 0 ? "BLOCKED" : redactions.length > 0 ? "PASS_REDACTED" : "PASS";
  const nonce = options?.nonce ?? randomNonce();
  return {
    verdict,
    allowed: verdict !== "BLOCKED",
    hits,
    redactions,
    sanitized,
    spotlighted: `<UNTRUSTED_PROMPT_${nonce}>\n${sanitized}\n</UNTRUSTED_PROMPT_${nonce}>`,
    nonce,
    elapsedMs: now() - t0,
  };
}

/** Outbound check: canary exfiltration plus secret-shaped strings. */
export function scanResponse(text: string): { leaked: boolean; token: string | null; redacted: string } {
  const input = text ?? "";
  let leaked = false;
  let token: string | null = null;
  let redacted = input;

  const canary = new RegExp(CANARY_TOKEN.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"), "gi");
  if (canary.test(input)) {
    leaked = true;
    token = CANARY_TOKEN;
    redacted = redacted.replace(new RegExp(canary.source, "gi"), "[REDACTED:CANARY]");
  }
  const secretPatterns = [...API_KEY_PATTERNS, /\b(?:GROQ|GEMINI|OPENAI|ANTHROPIC)_API_KEY\s*[=:]\s*["']?[^\s"']{8,}/g];
  for (const re of secretPatterns) {
    redacted = redacted.replace(new RegExp(re.source, re.flags), (match) => {
      leaked = true;
      token ??= match;
      return "[REDACTED:API_KEY]";
    });
  }
  return { leaked, token, redacted };
}
