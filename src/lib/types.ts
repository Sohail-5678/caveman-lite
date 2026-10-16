/** Shared OpenAI-compatible request types and gateway primitives. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequestBody {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
  [key: string]: unknown;
}

export type ProviderId = "groq" | "gemini" | "claude";
export type Tier = "fast" | "frontier";
