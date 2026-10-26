import { estimateTokens } from "../../tokens/src/index.ts";
import type { AgentDefinition, AgentState, AgentStatus, RunResult } from "./agent.ts";
import { DEFAULT_LIMITS, SAFETY_PREAMBLE } from "./agent.ts";
import type { ApprovalGate } from "./approval.ts";
import type { AuditLog } from "./audit.ts";
import type { Throttle, TokenEconomist } from "./economist.ts";
import type { BusEvent } from "./eventbus.ts";
import { LoopGuard, RateLimiter, detectInjection, wrapUntrusted } from "./safety.ts";
import type { Clock, ContentBlock, JsonObject, LlmProvider, Message, ToolResult, ToolSpec } from "./types.ts";
import { textOf, textResult } from "./types.ts";
import type { WebMcpClient } from "./webmcp.ts";

export interface RunnerDeps {
  client: WebMcpClient;
  provider: LlmProvider;
  economist: TokenEconomist;
  approvals: ApprovalGate;
  audit: AuditLog;
  clock: Clock;
  sensitiveTools: ReadonlySet<string>;
  /** Tools whose output may contain viewer-authored text. Output is fenced as untrusted. */
  untrustedOutputTools: ReadonlySet<string>;
  tools: () => ToolSpec[];
}

/** Runtime wrapper around one AgentDefinition: lifecycle, limits, the tool-use loop. */
export class AgentRuntime {
  state: AgentState = "stopped";
  throttle: Throttle = { level: 0 };
  readonly stats = { runs: 0, skipped: 0, llmCalls: 0, toolCalls: 0, blockedCalls: 0, tokens: 0 };
  lastRunAt?: number;
  lastError?: string;
  private lastStart = -Infinity;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private runLimiter: RateLimiter;
  private toolLimiter: RateLimiter;
  private cooldowns = new Map<string, number>();

  constructor(readonly def: AgentDefinition, private d: RunnerDeps) {
    const l = { ...DEFAULT_LIMITS, ...def.limits };
    this.runLimiter = new RateLimiter(l.runsPerMinute, 60_000, d.clock);
    this.toolLimiter = new RateLimiter(l.toolCallsPerMinute, 60_000, d.clock);
  }

  get limits() { return { ...DEFAULT_LIMITS, ...this.def.limits }; }

  status(): AgentStatus {
    const have = new Set(this.d.tools().map((t) => t.name));
    return {
      id: this.def.id, title: this.def.title, state: this.state, throttle: this.throttle.level,
      ...this.stats, lastRunAt: this.lastRunAt, lastError: this.lastError,
      missingTools: this.def.tools.filter((t) => !have.has(t)),
    };
  }

  /** Per-trigger cooldown check; returns true if the event may proceed. */
  cooldownOk(key: string, ms?: number): boolean {
    if (!ms) return true;
    const now = this.d.clock.now();
    const last = this.cooldowns.get(key);
    if (last !== undefined && now - last < ms) return false;
    this.cooldowns.set(key, now);
    return true;
  }

  /** Serialised: one run at a time per agent, bounded queue. Resolves when this event has been handled. */
  handle(event: BusEvent, opts: { manual?: boolean } = {}): Promise<RunResult> {
    if (this.queued >= this.limits.maxQueue) {
      this.stats.skipped++;
      this.d.audit.add("run.skipped", { agent: this.def.id, detail: { reason: "queue_full", topic: event.topic } });
      return Promise.resolve(skip("queue_full"));
    }
    this.queued++;
    const p = this.tail.then(() => this.run(event, opts)).finally(() => void this.queued--);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private gate(opts: { manual?: boolean }): string | null {
    if (this.state !== "running") return `agent ${this.state}`;
    if (this.throttle.level >= 3) return `throttled (paused): ${this.throttle.reason ?? "budget"}`;
    const now = this.d.clock.now();
    const gap = (this.def.minGapMs ?? 0) * 2 ** this.throttle.level;
    if (!opts.manual && gap && now - this.lastStart < gap) return "min_gap";
    if (!opts.manual && this.throttle.level >= 2 && this.def.priority < 5) return "throttled (low priority)";
    if (!this.runLimiter.tryTake()) return "run_rate_limit";
    return null;
  }

  private async run(event: BusEvent, opts: { manual?: boolean }): Promise<RunResult> {
    const id = this.def.id;
    const why = this.gate(opts);
    if (why) {
      this.stats.skipped++;
      this.d.audit.add("run.skipped", { agent: id, detail: { reason: why, topic: event.topic } });
      return skip(why);
    }
    this.lastStart = this.d.clock.now();
    this.stats.runs++;
    this.lastRunAt = this.lastStart;
    this.d.audit.add("run.start", { agent: id, detail: { topic: event.topic } });
    try {
      const res = await this.loop(event);
      this.d.audit.add("run.end", { agent: id, detail: { status: res.status, steps: res.steps, toolCalls: res.toolCalls, reason: res.reason } });
      return res;
    } catch (e) {
      this.lastError = String(e instanceof Error ? e.message : e);
      this.d.audit.add("run.error", { agent: id, detail: this.lastError });
      return { status: "error", reason: this.lastError, steps: 0, toolCalls: 0, text: "" };
    }
  }

  private async loop(event: BusEvent): Promise<RunResult> {
    const def = this.def;
    const specs = this.d.tools().filter((t) => def.tools.includes(t.name));
    const system = `${SAFETY_PREAMBLE}\n\n# Role: ${def.title}\n${def.systemPrompt}`;
    const userText = (def.render ?? defaultRender)(event);
    this.flagInjection(event, userText);

    const guard = new LoopGuard({ maxSteps: this.limits.maxSteps, maxToolCalls: this.limits.maxToolCalls, maxIdentical: this.limits.maxIdentical });
    const messages: Message[] = [{ role: "user", content: userText }];
    const overhead = estimateTokens(system) + estimateTokens(specs);
    let toolCalls = 0, steps = 0, text = "";

    while (guard.step()) {
      const approxCtx = estimateTokens(messages);
      const cp = this.d.economist.checkpoint({
        agentId: def.id, defaultTier: def.tier, text: userText, toolCount: specs.length,
        maxTokens: def.maxTokens, overheadTokens: overhead + approxCtx,
      });
      if (!cp.allow) {
        this.d.audit.add("budget.denied", { agent: def.id, detail: cp.reason });
        return { status: "budget", reason: cp.reason, steps, toolCalls, text };
      }
      const resp = await this.d.provider.complete({ model: cp.model, system, tools: specs, messages, maxTokens: cp.maxTokens, cache: true });
      steps++;
      this.stats.llmCalls++;
      this.stats.tokens += resp.usage.inputTokens + resp.usage.outputTokens;
      this.d.economist.record(def.id, cp.model, resp.usage, event.topic);
      messages.push({ role: "assistant", content: resp.content });
      text = resp.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");

      const uses = resp.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (!uses.length) return { status: "ok", steps, toolCalls, text };

      const results: ContentBlock[] = [];
      for (const u of uses) {
        toolCalls++;
        const r = await this.callTool(u.name, u.input ?? {}, guard, event);
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    return { status: "ok", reason: "max_steps", steps, toolCalls, text };
  }

  private flagInjection(event: BusEvent, rendered: string): void {
    if (!event.topic.startsWith("chat.")) return;
    const flags = detectInjection(rendered);
    if (flags.length) this.d.audit.add("safety.suspicious_input", { agent: this.def.id, detail: { topic: event.topic, flags } });
  }

  private async callTool(name: string, args: JsonObject, guard: LoopGuard, event: BusEvent): Promise<{ text: string; isError?: boolean }> {
    const id = this.def.id;
    const block = (reason: string): { text: string; isError: true } => {
      this.stats.blockedCalls++;
      this.d.audit.add("tool.blocked", { agent: id, tool: name, detail: reason });
      return { text: JSON.stringify({ error: reason }), isError: true };
    };
    if (!this.def.tools.includes(name)) return block(`tool '${name}' is not permitted for this agent`);
    if (!this.d.tools().some((t) => t.name === name)) return block(`tool '${name}' is not available on the page`);
    const loop = guard.call(name, args);
    if (loop) return block(loop);
    if (!this.toolLimiter.tryTake()) return block("tool rate limit exceeded");

    this.stats.toolCalls++;
    if (this.d.sensitiveTools.has(name)) {
      const reason = typeof args.reason === "string" ? args.reason : `requested by ${id} on ${event.topic}`;
      const dup = this.d.approvals.pending().find((p) => p.agent === id && p.tool === name && JSON.stringify(p.args) === JSON.stringify(args));
      const req = dup ?? this.d.approvals.request(id, name, args, reason);
      if (!req) return block("approval queue full");
      return { text: JSON.stringify({ status: "pending_approval", id: req.id, note: "A human must approve this. It has NOT been executed. Do not retry." }) };
    }

    this.d.audit.add("tool.call", { agent: id, tool: name, detail: args });
    let r: ToolResult;
    try { r = await this.d.client.callTool(name, args); } catch (e) { r = textResult({ error: String(e) }, true); }
    let out = this.d.economist.compact(name, textOf(r));
    if (this.d.untrustedOutputTools.has(name)) out = wrapUntrusted(`tool:${name}`, out);
    return { text: out, isError: r.isError };
  }
}

const skip = (reason: string): RunResult => ({ status: "skipped", reason, steps: 0, toolCalls: 0, text: "" });

/** Default: non-chat events are trusted system telemetry; chat.* payloads are fenced. */
export function defaultRender(e: BusEvent): string {
  if (e.topic === "human.request") return `The streamer says: ${String((e.payload as { text?: unknown })?.text ?? "")}`;
  const body = JSON.stringify(e.payload);
  return e.topic.startsWith("chat.") ? `Event ${e.topic}:\n${wrapUntrusted("chat", body)}` : `Event ${e.topic}: ${body}`;
}
