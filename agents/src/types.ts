export type JsonObject = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export type ModelTier = "small" | "medium" | "large";

export const MODEL_IDS: Record<ModelTier, string> = {
  small: "claude-haiku-5-5",
  medium: "claude-sonnet-5-5",
  large: "claude-opus-5-5",
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LlmRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: Message[];
  maxTokens: number;
  /** Mark stable prefixes (system + tools) for prompt caching. */
  cache?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: Usage;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export function textOf(r: ToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}
export function textResult(o: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) };
}
