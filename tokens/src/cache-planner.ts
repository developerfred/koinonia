import { estimateTokens } from "./estimate.js";

export type Stability = "static" | "session" | "volatile";

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface PromptBlock {
  text: string;
  /** static: never changes (rules, persona); session: changes rarely; volatile: per request. Default session. */
  stability?: Stability;
  /** Stable id for debugging. */
  id?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  [k: string]: unknown;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

export interface CachePlanInput {
  tools?: ToolDef[];
  system?: PromptBlock[];
  messages?: MessageParam[];
  /** Min tokens before a prefix is worth caching (API minimum ~1024; 2048 for small models). Default 1024. */
  minCacheTokens?: number;
  ttl?: "5m" | "1h";
  /** Cache the conversation history up to the last-but-one message. Default true. */
  cacheHistory?: boolean;
}

export interface CachePlan {
  tools: ToolDef[];
  system: Array<{ type: "text"; text: string; cache_control?: CacheControl }>;
  messages: MessageParam[];
  /** Where breakpoints were placed. */
  breakpoints: Array<{ at: "tools" | "system" | "messages"; index: number; prefixTokens: number }>;
  prefixTokens: number;
  volatileTokens: number;
}

const RANK: Record<Stability, number> = { static: 0, session: 1, volatile: 2 };
const MAX_BREAKPOINTS = 4;

/**
 * Orders prompt parts stable-first (tools -> system -> messages, the order the API hashes)
 * and places cache_control breakpoints at the end of each stable prefix segment.
 * Output spreads directly into `client.messages.create({...plan, model, max_tokens})`.
 */
export function planCache(input: CachePlanInput): CachePlan {
  const min = input.minCacheTokens ?? 1024;
  const cc: CacheControl = input.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const breakpoints: CachePlan["breakpoints"] = [];
  let running = 0;

  // tools: sorted by name for a deterministic prefix; breakpoint on last tool
  const tools = [...(input.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ ...t }));
  if (tools.length) {
    running += estimateTokens(tools);
    if (running >= min) {
      tools[tools.length - 1]!.cache_control = cc;
      breakpoints.push({ at: "tools", index: tools.length - 1, prefixTokens: running });
    }
  }

  // system: stable sort by stability rank
  const sys = (input.system ?? []).map((b, i) => ({ b, i })).sort((x, y) => RANK[x.b.stability ?? "session"] - RANK[y.b.stability ?? "session"] || x.i - y.i);
  const system: CachePlan["system"] = sys.map(({ b }) => ({ type: "text" as const, text: b.text }));
  let lastStable = -1;
  let volatileTokens = 0;
  sys.forEach(({ b }, idx) => {
    if ((b.stability ?? "session") === "volatile") volatileTokens += estimateTokens(b.text);
    else {
      running += estimateTokens(b.text);
      lastStable = idx;
    }
  });
  // static/session boundary gets its own breakpoint so rules survive session-block changes
  const firstSession = sys.findIndex(({ b }) => (b.stability ?? "session") === "session");
  if (firstSession > 0 && lastStable >= firstSession) {
    const staticTokens = sys.slice(0, firstSession).reduce((n, { b }) => n + estimateTokens(b.text), 0) + (breakpoints[0]?.prefixTokens ?? 0);
    if (staticTokens >= min) {
      system[firstSession - 1]!.cache_control = cc;
      breakpoints.push({ at: "system", index: firstSession - 1, prefixTokens: staticTokens });
    }
  }
  if (lastStable >= 0 && running >= min) {
    system[lastStable]!.cache_control = cc;
    breakpoints.push({ at: "system", index: lastStable, prefixTokens: running });
  }

  // messages: breakpoint on the last message of the reusable history (all but the newest)
  const messages: MessageParam[] = (input.messages ?? []).map((m) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map((c) => ({ ...c })) : m.content }));
  if ((input.cacheHistory ?? true) && messages.length >= 2) {
    const idx = messages.length - 2;
    const hist = messages.slice(0, idx + 1);
    const histTokens = estimateTokens(hist);
    if (running + histTokens >= min) {
      const m = messages[idx]!;
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      if (blocks.length) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: cc };
        m.content = blocks;
        running += histTokens;
        breakpoints.push({ at: "messages", index: idx, prefixTokens: running });
      }
    }
  }

  // enforce API limit: drop earliest breakpoints beyond 4
  while (breakpoints.length > MAX_BREAKPOINTS) {
    const bp = breakpoints.shift()!;
    const arr = bp.at === "tools" ? tools : bp.at === "system" ? system : null;
    if (arr) delete (arr[bp.index] as { cache_control?: CacheControl }).cache_control;
  }

  const last = messages[messages.length - 1];
  if (last) volatileTokens += estimateTokens(last);
  return { tools, system, messages, breakpoints, prefixTokens: breakpoints.at(-1)?.prefixTokens ?? 0, volatileTokens };
}
