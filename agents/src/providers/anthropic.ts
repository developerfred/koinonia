import type { ContentBlock, LlmProvider, LlmRequest, LlmResponse, Message } from "../types.ts";
import { redactSecrets } from "../safety.ts";

export interface AnthropicOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. Never logged. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  version?: string;
  /** Retries on 429/5xx/network, with exponential backoff. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Anthropic Messages API with tool use + prompt caching, over plain fetch (no SDK dependency). */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private key: string;
  private base: string;
  private f: typeof fetch;

  constructor(private o: AnthropicOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const key = o.apiKey ?? env?.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    this.key = key;
    this.base = (o.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
  }

  /** Exposed for tests: the exact JSON body sent. */
  buildBody(req: LlmRequest): Record<string, unknown> {
    const cache = req.cache !== false;
    const tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      // breakpoint on the last tool caches the whole tools array (stable prefix)
      ...(cache && i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }],
      ...(tools.length ? { tools } : {}),
      messages: req.messages.map(toWire),
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = JSON.stringify(this.buildBody(req));
    const max = this.o.maxRetries ?? 2;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastErr = "";
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await this.f(`${this.base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.key,
            "anthropic-version": this.o.version ?? "2023-06-01",
          },
          body,
        });
        if (res.ok) return fromWire((await res.json()) as WireResponse, req.model);
        const txt = await res.text().catch(() => "");
        lastErr = `HTTP ${res.status}: ${redactSecrets(txt).slice(0, 300)}`;
        if (res.status !== 429 && res.status < 500) break;
      } catch (e) {
        lastErr = redactSecrets(String(e)).replaceAll(this.key, "***");
      }
      if (attempt < max) await sleep(500 * 2 ** attempt);
    }
    throw new Error(`Anthropic request failed: ${lastErr}`);
  }
}

function toWire(m: Message): unknown {
  return { role: m.role, content: m.content };
}

interface WireResponse {
  content: (ContentBlock | { type: string })[];
  stop_reason: string;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function fromWire(w: WireResponse, model: string): LlmResponse {
  const content = w.content.filter((b): b is ContentBlock => b.type === "text" || b.type === "tool_use");
  const sr = w.stop_reason;
  return {
    content,
    stopReason: sr === "end_turn" || sr === "tool_use" || sr === "max_tokens" ? sr : "other",
    model: w.model ?? model,
    usage: {
      inputTokens: w.usage?.input_tokens ?? 0,
      outputTokens: w.usage?.output_tokens ?? 0,
      cacheReadTokens: w.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: w.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
