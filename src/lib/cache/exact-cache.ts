/**
 * Tier 1 — exact canonical cache.
 *
 * Requests are reduced to a canonical JSON form (formatting noise, transport flags and tool order
 * removed), hashed with a dependency-free synchronous SHA-256 and stored in an O(1) LRU map.
 */
import type { ChatRequestBody } from "../types";

// ---------------------------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with recursively sorted keys; undefined / functions dropped, non-finite numbers -> null. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "function":
    case "symbol":
      return "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/** Trim and collapse internal whitespace runs to one space. */
function normaliseText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Message content may be a string or (OpenAI multi-part) an array of parts with `text`. */
function normaliseContent(content: unknown): unknown {
  if (typeof content === "string") return normaliseText(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return normaliseText(part);
      if (isPlainObject(part) && typeof part.text === "string") return { ...part, text: normaliseText(part.text) };
      return part;
    });
  }
  return content ?? "";
}

const MESSAGE_SEMANTIC_KEYS = ["name", "tool_call_id", "tool_calls", "function_call"] as const;

function normaliseMessage(message: unknown): Record<string, unknown> {
  const m = isPlainObject(message) ? message : {};
  const out: Record<string, unknown> = {
    role: typeof m.role === "string" ? m.role.trim().toLowerCase() : "user",
    content: normaliseContent(m.content),
  };
  for (const key of MESSAGE_SEMANTIC_KEYS) if (m[key] !== undefined && m[key] !== null) out[key] = m[key];
  return out;
}

function toolName(tool: unknown): string {
  if (isPlainObject(tool) && isPlainObject(tool.function) && typeof tool.function.name === "string") return tool.function.name;
  return "";
}

/**
 * Deterministic canonical JSON for a chat request:
 * - messages: role lower-cased, content trimmed with internal whitespace runs collapsed to one space
 * - tools sorted by function.name, and object keys sorted recursively
 * - keeps only semantic fields: model (default "auto"), temperature (rounded to 2 dp, default 1),
 *   messages, tools, tool_choice, response_format; drops stream, user, metadata, stream_options, etc.
 */
export function canonicalize(body: ChatRequestBody): string {
  const raw = (isPlainObject(body) ? body : {}) as Partial<ChatRequestBody> & Record<string, unknown>;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "auto";
  const t = typeof raw.temperature === "number" ? raw.temperature : Number(raw.temperature ?? NaN);
  const temperature = Number.isFinite(t) ? Math.round(t * 100) / 100 + 0 : 1; // "+ 0" folds -0 into 0

  const canonical: Record<string, unknown> = {
    model,
    temperature,
    messages: Array.isArray(raw.messages) ? raw.messages.map(normaliseMessage) : [],
  };
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    canonical.tools = raw.tools
      .map((tool) => ({ name: toolName(tool), json: stableStringify(tool), tool }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.json < b.json ? -1 : a.json > b.json ? 1 : 0))
      .map((entry) => entry.tool);
  }
  if (raw.tool_choice !== undefined) canonical.tool_choice = raw.tool_choice;
  if (raw.response_format !== undefined) canonical.response_format = raw.response_format;
  return stableStringify(canonical);
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), synchronous and dependency-free
// ---------------------------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 encode (lone surrogates become U+FFFD, matching TextEncoder / Node Buffer). */
function utf8Bytes(input: string): Uint8Array {
  const out = new Uint8Array(input.length * 3);
  let p = 0;
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) {
      out[p++] = c;
    } else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out[p++] = 0xf0 | (c >> 18);
        out[p++] = 0x80 | ((c >> 12) & 0x3f);
        out[p++] = 0x80 | ((c >> 6) & 0x3f);
        out[p++] = 0x80 | (c & 0x3f);
      } else {
        out[p++] = 0xef;
        out[p++] = 0xbf;
        out[p++] = 0xbd;
      }
    } else {
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    }
  }
  return out.subarray(0, p);
}

/** Synchronous, dependency-free SHA-256 of a UTF-8 string, lowercase hex (64 chars). */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const byteLength = bytes.length;
  const paddedLength = Math.ceil((byteLength + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[byteLength] = 0x80;
  const view = new DataView(buffer.buffer);
  // 64-bit big-endian message length in bits
  view.setUint32(paddedLength - 8, Math.floor(byteLength / 0x20000000));
  view.setUint32(paddedLength - 4, (byteLength << 3) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/** sha256Hex(canonicalize(body)). */
export function exactKey(body: ChatRequestBody): string {
  return sha256Hex(canonicalize(body));
}

// ---------------------------------------------------------------------------------------------
// LRU
// ---------------------------------------------------------------------------------------------

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * O(1) LRU map with hit/miss accounting. A JS Map iterates in insertion order, so re-inserting a
 * key on access keeps the least-recently-used entry first: eviction is a single iterator step.
 */
export class ExactCache<V> {
  private readonly map = new Map<string, V>();
  private readonly capacity: number;
  private counters: CacheStats = { hits: 0, misses: 0, evictions: 0 };

  constructor(capacity = 512) {
    this.capacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 512;
  }

  /** Counts a hit or miss and refreshes recency on hit. */
  get(key: string): V | undefined {
    if (!this.map.has(key)) {
      this.counters.misses++;
      return undefined;
    }
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    this.counters.hits++;
    return value;
  }

  /** Read without touching stats or recency. */
  peek(key: string): V | undefined {
    return this.map.get(key);
  }

  /** Inserts or replaces; evicts the least-recently-used entry when over capacity. */
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.counters.evictions++;
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Drops every entry and resets the counters. */
  clear(): void {
    this.map.clear();
    this.counters = { hits: 0, misses: 0, evictions: 0 };
  }

  get size(): number {
    return this.map.size;
  }

  get stats(): CacheStats {
    return { ...this.counters };
  }

  /** Keys from least- to most-recently used (the next eviction candidate first). */
  keys(): string[] {
    return [...this.map.keys()];
  }
}
