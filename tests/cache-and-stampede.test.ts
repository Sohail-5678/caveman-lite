import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, ExactCache, exactKey, sha256Hex } from "@/lib/cache/exact-cache";
import { checkParity, extractEntities } from "@/lib/cache/entity-guard";
import { adaptiveThreshold, cosine, countTokens, embed, EMBEDDING_DIM, SemanticCache } from "@/lib/cache/semantic-cache";
import { Singleflight } from "@/lib/cache/stampede-lock";
import type { ChatRequestBody } from "@/lib/types";

const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const A = "What was Apple's total revenue in Q3 2026, and how did it compare to analyst expectations?";
const MSFT = "What was Microsoft's total revenue in Q3 2026, and how did it compare to analyst expectations?";
const PARAPHRASE = "In Q3 2026, what was Apple's total revenue and how did it compare with analyst expectations?";

// ---------------------------------------------------------------------------------------------
describe("sha256Hex", () => {
  it("matches node:crypto and the FIPS vectors for '' and 'abc'", () => {
    expect(sha256Hex("")).toBe(nodeSha(""));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(nodeSha("abc"));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches node:crypto for a 1,000-character unicode string (BMP, astral, combining, NUL)", () => {
    const alphabet = ["a", "é", "漢", "😀", "ß", "\n", "Ω", "ü", "\u0000", "e\u0301", "𝔘"];
    const text = Array.from({ length: 1000 }, (_, i) => alphabet[i % alphabet.length]).join("");
    expect(Array.from(text).length).toBeGreaterThanOrEqual(1000);
    expect(sha256Hex(text)).toBe(nodeSha(text));
  });

  it("is correct around the 55/56/64-byte padding boundaries and for long input", () => {
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const s = "x".repeat(n);
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
    const long = "caveman ".repeat(20_000);
    expect(sha256Hex(long)).toBe(nodeSha(long));
  });

  it("encodes lone surrogates as U+FFFD like Node's UTF-8 encoder", () => {
    for (const s of ["\uD800", "a\uDC00b", "\uD83D"]) expect(sha256Hex(s)).toBe(nodeSha(s));
  });
});

// ---------------------------------------------------------------------------------------------
describe("canonicalize / exactKey", () => {
  const tools: NonNullable<ChatRequestBody["tools"]> = [
    { type: "function", function: { name: "zeta", parameters: { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } } } },
    { type: "function", function: { name: "alpha", description: "first", parameters: { properties: { q: { type: "string" } }, type: "object" } } },
  ];
  const base: ChatRequestBody = { model: "llama-3.1-8b", temperature: 0.3, messages: [{ role: "user", content: "Hello   world" }], tools };

  it("ignores whitespace, role case, tool order, key order and transport flags", () => {
    const key = exactKey(base);
    expect(exactKey({ ...base, messages: [{ role: "USER" as "user", content: "  Hello\n\tworld " }] })).toBe(key);
    expect(exactKey({ ...base, tools: [...tools].reverse() })).toBe(key);
    expect(exactKey({ ...base, stream: true, stream_options: { include_usage: true }, user: "u1", metadata: { a: 1 } })).toBe(key);
    expect(exactKey({ tools, messages: base.messages, temperature: 0.3, model: "llama-3.1-8b" })).toBe(key);
    expect(exactKey({ ...base, temperature: 0.3000004 })).toBe(key);
  });

  it("changes when semantics change", () => {
    const key = exactKey(base);
    expect(exactKey({ ...base, temperature: 0.7 })).not.toBe(key);
    expect(exactKey({ ...base, messages: [{ role: "user", content: "Hello there world" }] })).not.toBe(key);
    expect(exactKey({ ...base, messages: [{ role: "system", content: "Hello world" }] })).not.toBe(key);
    expect(exactKey({ ...base, model: "gemini-2.0-flash" })).not.toBe(key);
    expect(exactKey({ ...base, response_format: { type: "json_object" } })).not.toBe(key);
  });

  it("produces sorted canonical JSON with defaults", () => {
    const json = canonicalize({ messages: [{ role: "user", content: " hi " }] });
    expect(json).toBe('{"messages":[{"content":"hi","role":"user"}],"model":"auto","temperature":1}');
    const withTools = JSON.parse(canonicalize(base));
    expect(withTools.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(withTools.tools[1].function.parameters.properties)).toEqual(["a", "b"]);
    expect(exactKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("ExactCache (LRU)", () => {
  it("evicts the least-recently-used entry and keeps accounting", () => {
    const cache = new ExactCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1); // a becomes most recent
    cache.set("d", 4); // evicts b
    expect(cache.has("b")).toBe(false);
    expect(cache.keys()).toEqual(["c", "a", "d"]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.stats).toEqual({ hits: 1, misses: 1, evictions: 1 });
    cache.set("e", 5); // evicts c
    expect(cache.keys()).toEqual(["a", "d", "e"]);
    expect(cache.size).toBe(3);
    expect(cache.stats.evictions).toBe(2);
  });

  it("peek does not touch recency or stats; replace refreshes recency", () => {
    const cache = new ExactCache<string>(2);
    cache.set("x", "1");
    cache.set("y", "2");
    expect(cache.peek("x")).toBe("1");
    expect(cache.stats).toEqual({ hits: 0, misses: 0, evictions: 0 });
    cache.set("z", "3"); // x is still LRU despite peek
    expect(cache.has("x")).toBe(false);
    cache.set("y", "2b"); // replace -> most recent
    cache.set("w", "4"); // evicts z
    expect(cache.keys()).toEqual(["y", "w"]);
    expect(cache.delete("y")).toBe(true);
    expect(cache.delete("y")).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.stats).toEqual({ hits: 0, misses: 0, evictions: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("Singleflight", () => {
  it("coalesces 50 concurrent callers into exactly one upstream call", async () => {
    const sf = new Singleflight<string>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await sleep(10);
      return "shared";
    };
    const pending = Array.from({ length: 50 }, () => sf.run("k", fn));
    expect(calls).toBe(1); // leader registered and invoked synchronously
    expect(sf.isInFlight("k")).toBe(true);
    expect(sf.followers("k")).toBe(49);
    expect(sf.inFlightKeys()).toEqual(["k"]);
    const results = await Promise.all(pending);
    expect(calls).toBe(1);
    expect(sf.stats).toEqual({ leaders: 1, followers: 49, upstreamCalls: 1 });
    expect(results.filter((r) => r.role === "leader")).toHaveLength(1);
    expect(results.filter((r) => r.role === "follower")).toHaveLength(49);
    expect(new Set(results.map((r) => r.value))).toEqual(new Set(["shared"]));
    expect(results.every((r) => r.followers === 49 && r.key === "k")).toBe(true);
  });

  it("propagates a rejection to every waiter and releases the key", async () => {
    const sf = new Singleflight<string>();
    let calls = 0;
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        sf.run("boom", async () => {
          calls++;
          await sleep(5);
          throw new Error("upstream 503");
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(settled.every((s) => s.status === "rejected" && (s.reason as Error).message === "upstream 503")).toBe(true);
    expect(sf.isInFlight("boom")).toBe(false);
  });

  it("handles synchronous throws as rejections", async () => {
    const sf = new Singleflight<number>();
    await expect(
      sf.run("sync", () => {
        throw new Error("sync fail");
      }),
    ).rejects.toThrow("sync fail");
    expect(sf.isInFlight("sync")).toBe(false);
  });

  it("releases the key after settlement so the next call starts a new flight", async () => {
    const sf = new Singleflight<number>();
    let calls = 0;
    const fn = async () => {
      await sleep(2);
      return ++calls;
    };
    const first = await sf.run("x", fn);
    expect(first).toMatchObject({ value: 1, role: "leader", followers: 0 });
    expect(sf.isInFlight("x")).toBe(false);
    const second = await sf.run("x", fn);
    expect(second.value).toBe(2);
    expect(sf.stats.upstreamCalls).toBe(2);
    // waiters observe the released key as soon as they resume
    let seenInFlight: boolean | null = null;
    await sf.run("y", fn).then(() => {
      seenInFlight = sf.isInFlight("y");
    });
    expect(seenInFlight).toBe(false);
    sf.reset();
    expect(sf.stats).toEqual({ leaders: 0, followers: 0, upstreamCalls: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("extractEntities", () => {
  const cases: Array<[string, { named?: string[]; numeric?: string[]; polarity?: string[] }]> = [
    [A, { named: ["apple"], numeric: ["2026", "q3"], polarity: [] }],
    ["AAPL vs MSFT vs GOOGL vs Alphabet", { named: ["apple", "google", "microsoft"] }],
    ["Did SNOW beat estimates? The snow fell on the Snowflake campus.", { named: ["snowflake"], polarity: ["down"] }],
    ["Revenue in the third quarter of fiscal 2026 vs FY26 vs FY2026 vs fiscal year 2026", { numeric: ["fy2026", "q3"] }],
    ["Margin rose 12.5 percent to $4.2 billion (12.5%, $4.2B) in H1", { numeric: ["$4.2b", "12.5%", "h1"], polarity: ["up"] }],
    ["Show the top five accounts with 1,200 seats", { numeric: ["1200", "5"], polarity: ["max"] }],
    ["Orders between 2025-01-15 and March 3, 2025 in `orders_2025`", { named: ["orders_2025"], numeric: ["2025", "2025-01-15", "3", "mar"] }],
    ["Join users.created_at with orders.user_id", { named: ["orders.user_id", "users.created_at"] }],
    ["Which customers didn't renew, excluding trials, before 2024?", { numeric: ["2024"], polarity: ["before", "exclude", "not"] }],
    ["Customers with more than 50 seats but at most 10 admins, sorted descending", { numeric: ["10", "50"], polarity: ["desc", "gt", "lt"] }],
    ["Revenue over the last 6 months", { numeric: ["6"], polarity: [] }],
    ["Set up the cluster, then scale down the workers; is usage up?", { polarity: ["down", "up"] }],
    ["Break down revenue by region and back up the database", { polarity: [] }],
    ["Which accounts upgraded after the price drop?", { polarity: ["after", "down", "up"] }],
    ["Is the dashboard up to date with up to 5 widgets?", { numeric: ["5"], polarity: ["lt"] }],
    ["Revenue over $5M since 2023", { numeric: ["$5m", "2023"], polarity: ["after", "gt"] }],
    ["Explain how the singleflight pattern prevents cache stampedes in a distributed LLM gateway.", { named: [], numeric: [], polarity: [] }],
    ["Compare Postgres and PostgreSQL with Kafka on Oldcastle data", { named: ["kafka", "oldcastle", "postgres"] }],
    ["Use the GROQ_API_KEY and the ACME team's SLA for the KPI report", { named: ["acme", "groq_api_key"] }],
  ];
  it.each(cases)("%s", (text, expected) => {
    const e = extractEntities(text);
    if (expected.named) expect(e.named).toEqual(expected.named);
    if (expected.numeric) expect(e.numeric).toEqual(expected.numeric);
    if (expected.polarity) expect(e.polarity).toEqual(expected.polarity);
  });

  it("returns sorted, de-duplicated arrays", () => {
    const e = extractEntities("Apple and AAPL and apple: Q3, q3 and Q3 2026 2026");
    expect(e.named).toEqual(["apple"]);
    expect(e.numeric).toEqual(["2026", "q3"]);
  });

  it("does not treat sentence-initial capitals or acronyms as entities", () => {
    expect(extractEntities("Explain the SQL API JSON schema. Then list the KPIs.").named).toEqual([]);
    expect(extractEntities("Show annual Enterprise plans").named).toEqual(["enterprise"]);
  });
});

describe("checkParity", () => {
  it("vetoes named, numeric and polarity mismatches with diffs", () => {
    const named = checkParity(extractEntities(A), extractEntities(MSFT));
    expect(named).toMatchObject({ ok: false, verdict: "ENTITY_GUARD_VETO", reasons: ["NAMED_ENTITY_MISMATCH"] });
    expect(named.diff.named).toEqual({ shared: [], onlyA: ["apple"], onlyB: ["microsoft"] });
    expect(named.diff.numeric.shared).toEqual(["2026", "q3"]);

    const numeric = checkParity(extractEntities(A), extractEntities(A.replace("Q3", "Q4")));
    expect(numeric.reasons).toEqual(["NUMERIC_MISMATCH"]);

    const polarity = checkParity(
      extractEntities("Which enterprise customers renewed their contracts in 2025 after the price increase?"),
      extractEntities("Which enterprise customers did not renew their contracts in 2025 after the price increase?"),
    );
    expect(polarity.reasons).toEqual(["POLARITY_MISMATCH"]);
    expect(polarity.diff.polarity.onlyB).toEqual(["not"]);

    const all = checkParity(extractEntities("Top Apple accounts in 2025"), extractEntities("Bottom Oracle accounts in 2024"));
    expect(all.reasons).toEqual(["NAMED_ENTITY_MISMATCH", "NUMERIC_MISMATCH", "POLARITY_MISMATCH"]);
  });

  it("accepts paraphrases with identical entity sets", () => {
    const p = checkParity(extractEntities(A), extractEntities(PARAPHRASE));
    expect(p).toMatchObject({ ok: true, verdict: "PARITY_OK", reasons: [] });
  });
});

// ---------------------------------------------------------------------------------------------
describe("embedding primitives", () => {
  it("is deterministic, L2-normalised and 384-dimensional", () => {
    const v = embed(A);
    expect(v).toHaveLength(EMBEDDING_DIM);
    expect(Array.from(v)).toEqual(Array.from(embed(A)));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it("handles empty input and zero vectors", () => {
    const zero = embed("");
    expect(Array.from(zero).every((x) => x === 0)).toBe(true);
    expect(cosine(zero, embed(A))).toBe(0);
    expect(countTokens("")).toBe(0);
  });

  it("counts word tokens and applies the adaptive threshold", () => {
    expect(countTokens("Capital of France?")).toBe(3);
    expect(countTokens(A)).toBe(16);
    expect(adaptiveThreshold("Capital of France?")).toBe(0.97);
    expect(adaptiveThreshold(A)).toBe(0.94);
    expect(adaptiveThreshold(A, 0.9)).toBe(0.9);
  });

  it("embeds a ~2 KB prompt in under 3 ms", () => {
    const text = `${A} ${PARAPHRASE} `.repeat(12).slice(0, 2048);
    embed(text); // warm-up
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) embed(`${text}${i}`);
    expect((performance.now() - t0) / 50).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------------------------------------
describe("SemanticCache", () => {
  it("returns EMPTY on an empty cache", () => {
    const cache = new SemanticCache<string>();
    const r = cache.lookup(A);
    expect(r).toMatchObject({ verdict: "EMPTY", hit: false, best: null, candidate: false, parity: null, naiveHit: false });
    expect(r.neighbors).toEqual([]);
    expect(cache.stats).toEqual({ hits: 0, misses: 1, vetoes: 0 });
  });

  it("serves a paraphrase (HIT) with parity", () => {
    const cache = new SemanticCache<string>();
    const entry = cache.insert(A, "apple-q3");
    expect(entry.id).toBe("sem_0001");
    const r = cache.lookup(PARAPHRASE);
    expect(r.verdict).toBe("HIT");
    expect(r.hit).toBe(true);
    expect(r.best?.entry.value).toBe("apple-q3");
    expect(r.candidate).toBe(true);
    expect(r.parity?.ok).toBe(true);
    expect(r.threshold).toBe(0.94);
    expect(cache.stats).toEqual({ hits: 1, misses: 0, vetoes: 0 });
  });

  it("vetoes the Apple -> Microsoft trap that a naive cache would serve", () => {
    const cache = new SemanticCache<string>();
    cache.insert(A, "apple-q3");
    const r = cache.lookup(MSFT);
    expect(r.verdict).toBe("ENTITY_GUARD_VETO");
    expect(r.hit).toBe(false);
    expect(r.naiveHit).toBe(true);
    expect(r.candidate).toBe(true);
    expect(r.best?.similarity).toBeGreaterThanOrEqual(0.94);
    expect(r.parity?.reasons).toEqual(["NAMED_ENTITY_MISMATCH"]);
    expect(r.parity?.diff.named).toMatchObject({ onlyA: ["apple"], onlyB: ["microsoft"] });
    expect(cache.stats.vetoes).toBe(1);
  });

  it("skips a higher-ranked vetoed candidate and serves the next one with parity", () => {
    const cache = new SemanticCache<string>();
    cache.insert(MSFT, "microsoft-q3");
    cache.insert("In Q3 2026, what was the total revenue of Apple and how did it compare with analyst expectations?", "apple-q3");
    const r = cache.lookup(A);
    // the Microsoft template is the nearest neighbour, but fails parity
    expect(r.neighbors[0].entry.value).toBe("microsoft-q3");
    expect(r.neighbors[1].similarity).toBeGreaterThanOrEqual(r.threshold);
    expect(r.verdict).toBe("HIT");
    expect(r.best?.entry.value).toBe("apple-q3");
    expect(r.parity?.ok).toBe(true);
    expect(cache.stats).toEqual({ hits: 1, misses: 0, vetoes: 0 });
  });

  it("serves the trap when the entity guard is disabled", () => {
    const cache = new SemanticCache<string>({ entityGuard: false });
    cache.insert(A, "apple-q3");
    const r = cache.lookup(MSFT);
    expect(r.verdict).toBe("HIT");
    expect(r.parity?.ok).toBe(false);
  });

  it("misses below threshold and reports the nearest neighbour", () => {
    const cache = new SemanticCache<string>({ topK: 2 });
    cache.insert(A, "a");
    cache.insert("What is the refund window for customers on annual Enterprise plans who cancel mid-term?", "b");
    cache.insert("List every column in the orders_2025 table with its data type and nullability.", "c");
    const r = cache.lookup("Write a haiku about Postgres vacuum.");
    expect(r.verdict).toBe("MISS_BELOW_THRESHOLD");
    expect(r.candidate).toBe(false);
    expect(r.parity).toBeNull();
    expect(r.best).not.toBeNull();
    expect(r.threshold).toBe(0.97);
    expect(r.neighbors).toHaveLength(2);
    expect(r.neighbors[0].similarity).toBeGreaterThanOrEqual(r.neighbors[1].similarity);
    expect(r.naiveHit).toBe(false);
  });

  it("evicts least-recently-used entries at capacity and de-duplicates identical text", () => {
    const cache = new SemanticCache<number>({ capacity: 2 });
    cache.insert("first prompt about revenue", 1);
    cache.insert("second prompt about churn", 2);
    cache.insert("first prompt about revenue", 11); // replace, refresh
    cache.insert("third prompt about refunds", 3); // evicts "second"
    expect(cache.entries().map((e) => e.value)).toEqual([11, 3]);
    expect(cache.size).toBe(2);
    expect(cache.entries()[1].id).toBe("sem_0003");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("adversarial inputs stay linear (no catastrophic regex backtracking)", () => {
  it.each([
    ["extractEntities: '1,111,…' run", () => extractEntities(`1${",111".repeat(15_000)}`)],
    ["embed: '1,' x 30k", () => embed("1,".repeat(30_000))],
    ["embed + entities: 100 KB of prose", () => embed(`${A} `.repeat(1100)) && extractEntities(`${A} `.repeat(1100))],
  ] as Array<[string, () => unknown]>)("%s", (_name, fn) => {
    const t0 = performance.now();
    fn();
    expect(performance.now() - t0).toBeLessThan(400);
  });
});
