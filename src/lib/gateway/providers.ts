import type { ProviderId, Tier } from "../types";

/** Upstream catalogue. Prices are public list prices (USD per 1M tokens) used for the cost model. */
export interface ModelSpec {
  id: string;
  label: string;
  provider: ProviderId;
  tier: Tier;
  ttftMedianMs: number;
  ttftSigma: number;
  inputPer1M: number;
  outputPer1M: number;
}

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  host: string;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  groq: { id: "groq", name: "Groq", host: "api.groq.com" },
  gemini: { id: "gemini", name: "Gemini", host: "generativelanguage.googleapis.com" },
  claude: { id: "claude", name: "Claude", host: "api.anthropic.com" },
};

export const PROVIDER_ORDER: ProviderId[] = ["groq", "gemini", "claude"];

export const MODELS: Record<string, ModelSpec> = {
  "llama-3.3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B",
    provider: "groq",
    tier: "fast",
    ttftMedianMs: 128,
    ttftSigma: 0.24,
    inputPer1M: 0.59,
    outputPer1M: 0.79,
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "gemini",
    tier: "frontier",
    ttftMedianMs: 390,
    ttftSigma: 0.25,
    inputPer1M: 0.3,
    outputPer1M: 2.5,
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "gemini",
    tier: "frontier",
    ttftMedianMs: 1150,
    ttftSigma: 0.28,
    inputPer1M: 1.25,
    outputPer1M: 10,
  },
  "claude-sonnet-4.5": {
    id: "claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    provider: "claude",
    tier: "frontier",
    ttftMedianMs: 860,
    ttftSigma: 0.25,
    inputPer1M: 3,
    outputPer1M: 15,
  },
};

/** Primary first, then failover. */
export const ROUTE_PLANS: Record<Tier, string[]> = {
  fast: ["llama-3.3-70b-versatile", "gemini-2.5-flash"],
  frontier: ["gemini-2.5-pro", "claude-sonnet-4.5"],
};

/** What every request would hit with no gateway in front of it. */
export const BASELINE_MODEL = "gemini-2.5-pro";
export const TTFT_SLA_MS = 1500;
export const SYSTEM_PROMPT_TOKENS = 420;

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const spec = MODELS[model];
  if (!spec) return 0;
  return (inputTokens * spec.inputPer1M + outputTokens * spec.outputPer1M) / 1_000_000;
}
