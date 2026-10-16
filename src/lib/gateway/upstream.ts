/**
 * Upstream transports for the server gateway.
 *
 * live       Groq and Gemini, both through their OpenAI-compatible streaming endpoints.
 * simulator  Deterministic token stream used when no key is configured: TTFT is drawn from each model's
 *            log-normal latency profile (seeded by the request, so a prompt always behaves the same way)
 *            and the text comes from the same response writer the in-browser engine uses.
 *
 * A transport yields content deltas only; the first yielded string is the first token.
 */
import type { ChatMessage, ProviderId } from "../types";
import { fnv1a, lognormal, mulberry32 } from "../utils/prng";
import { writeResponse } from "../workload-traces";
import { MODELS } from "./providers";

export interface UpstreamRequest {
  model: string;
  provider: ProviderId;
  messages: ChatMessage[];
  /** Provider API key; absent for the simulator. */
  apiKey?: string;
  /** Last user message after redaction, before spotlighting. Drives the simulator's text. */
  prompt: string;
  /** Stable request signature, seeds the simulator. */
  seed: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string | string[];
  signal: AbortSignal;
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

export type Transport = (request: UpstreamRequest) => AsyncIterable<string>;

/** Non-2xx from a provider. 429 and 5xx are breaker failures; 4xx auth errors are the caller's key. */
export class UpstreamHttpError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamHttpError";
  }

  get countsAgainstBreaker(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export const PROVIDER_ENDPOINTS: Partial<Record<ProviderId, string>> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
};

// ---------------------------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------------------------

/** Splits a byte stream into SSE `data:` payloads. Handles \n and \r\n framing and multi-line data. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------------------------
// Live transport
// ---------------------------------------------------------------------------------------------

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  error?: { message?: string };
}

export function createLiveTransport(fetchImpl: typeof fetch = (...args) => fetch(...args)): Transport {
  return async function* live(request) {
    const url = PROVIDER_ENDPOINTS[request.provider];
    if (!url) throw new UpstreamHttpError(request.provider, 501, `${request.provider} has no live adapter`);
    if (!request.apiKey) throw new UpstreamHttpError(request.provider, 401, `no ${request.provider} key`);

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content })),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
    if (request.topP !== undefined) payload.top_p = request.topP;
    if (request.stop !== undefined) payload.stop = request.stop;

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    if (!response.ok || !response.body) {
      // Provider error bodies can echo request details; keep only a short, key-free summary.
      const text = await response.text().catch(() => "");
      const detail = text.replace(/(gsk_|AIza|sk-)[A-Za-z0-9_-]+/g, "[key]").slice(0, 200);
      throw new UpstreamHttpError(request.provider, response.status || 502, `${request.provider} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    for await (const data of sseData(response.body)) {
      if (data === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new UpstreamHttpError(request.provider, 502, chunk.error.message ?? "stream error");
      const usage = chunk.usage ?? chunk.x_groq?.usage;
      if (usage && request.onUsage) {
        request.onUsage({ promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 });
      }
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) yield content;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Simulator transport
// ---------------------------------------------------------------------------------------------

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Per-token decode time, ms: Groq LPUs stream several times faster than the frontier models. */
const DECODE_MS: Partial<Record<ProviderId, number>> = { groq: 4, gemini: 11, claude: 14 };

/**
 * @param speed 1 = realistic latency, 0 = instant (tests). Values in between scale every sleep.
 */
export function createSimulatorTransport(speed = 1): Transport {
  return async function* simulate(request) {
    const spec = MODELS[request.model];
    const rand = mulberry32(fnv1a(`${request.seed}:${request.model}`));
    const ttft = spec ? lognormal(rand, spec.ttftMedianMs, spec.ttftSigma) : 200;
    await abortableSleep(ttft * speed, request.signal);

    const text = writeResponse(request.prompt, request.model);
    const pieces = text.match(/\S+\s*/g) ?? [text];
    const decode = (DECODE_MS[request.provider] ?? 8) * speed;
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) await abortableSleep(decode * (0.6 + rand() * 0.8), request.signal);
      yield pieces[i];
    }
  };
}
