import type { AgentDefinition, AgentStatus, RunResult } from "./agent.ts";
import { ApprovalGate } from "./approval.ts";
import { AuditLog } from "./audit.ts";
import type { AgentController, Throttle } from "./economist.ts";
import { TokenEconomist } from "./economist.ts";
import type { BusEvent } from "./eventbus.ts";
import { EventBus } from "./eventbus.ts";
import { AgentRuntime } from "./runner.ts";
import { DEFAULT_SENSITIVE_TOOLS } from "./safety.ts";
import type { Clock, LlmProvider, ToolSpec } from "./types.ts";
import { systemClock } from "./types.ts";
import type { WebMcpClient } from "./webmcp.ts";

export interface OrchestratorOptions {
  client: WebMcpClient;
  provider: LlmProvider;
  clock?: Clock;
  bus?: EventBus;
  audit?: AuditLog;
  economist?: TokenEconomist;
  approvalTimeoutMs?: number;
  sensitiveTools?: string[];
  untrustedOutputTools?: string[];
  /** Set false in tests to avoid real timers (interval triggers and approval sweeps). */
  timers?: boolean;
}

/**
 * Registry + lifecycle + event routing. Owns the approval gate and audit log.
 * Agents never talk to each other directly; they publish/subscribe on the bus.
 */
export class Orchestrator implements AgentController {
  readonly bus: EventBus;
  readonly audit: AuditLog;
  readonly approvals: ApprovalGate;
  readonly economist: TokenEconomist;
  private clock: Clock;
  private runtimes = new Map<string, AgentRuntime>();
  private unsubs = new Map<string, (() => void)[]>();
  private intervals = new Map<string, ReturnType<typeof setInterval>[]>();
  private sweeper?: ReturnType<typeof setInterval>;
  private specs: ToolSpec[] = [];
  private sensitive: Set<string>;
  private untrustedOut: Set<string>;

  constructor(private o: OrchestratorOptions) {
    this.clock = o.clock ?? systemClock;
    this.bus = o.bus ?? new EventBus(() => this.clock.now());
    this.audit = o.audit ?? new AuditLog({ clock: this.clock });
    this.economist = o.economist ?? new TokenEconomist({ clock: this.clock, onAlert: (a) => void this.bus.emit("economy.alert", a), onUsage: (u) => void this.bus.emit("economy.usage", u) });
    this.sensitive = new Set(o.sensitiveTools ?? DEFAULT_SENSITIVE_TOOLS);
    this.untrustedOut = new Set(o.untrustedOutputTools ?? ["get_chat"]);
    this.approvals = new ApprovalGate(this.audit, { timeoutMs: o.approvalTimeoutMs, clock: this.clock });
    // The ONLY path by which a sensitive call reaches the page: a human approval.
    this.approvals.setExecutor((r) => this.o.client.callTool(r.tool, r.args));
    this.approvals.onRequest((r) => void this.bus.emit("approval.requested", r));
  }

  /** Discover tools from the page. Call before start(); call again after toolchange. */
  async refreshTools(): Promise<ToolSpec[]> {
    this.specs = await this.o.client.listTools();
    this.audit.add("tools.refreshed", { detail: this.specs.map((s) => s.name) });
    return this.specs;
  }
  tools(): ToolSpec[] { return this.specs; }

  register(def: AgentDefinition): AgentRuntime {
    if (this.runtimes.has(def.id)) throw new Error(`agent '${def.id}' already registered`);
    const rt = new AgentRuntime(def, {
      client: this.o.client, provider: this.o.provider, economist: this.economist, approvals: this.approvals,
      audit: this.audit, clock: this.clock, sensitiveTools: this.sensitive, untrustedOutputTools: this.untrustedOut,
      tools: () => this.specs,
    });
    this.runtimes.set(def.id, rt);
    if (def.budgetPerHour > 0) this.economist.setAgentBudget(def.id, def.budgetPerHour);
    this.audit.add("agent.registered", { agent: def.id });
    return rt;
  }

  get(id: string): AgentRuntime {
    const r = this.runtimes.get(id);
    if (!r) throw new Error(`unknown agent '${id}'`);
    return r;
  }
  list(): AgentDefinition[] { return [...this.runtimes.values()].map((r) => r.def); }
  status(): AgentStatus[] { return [...this.runtimes.values()].map((r) => r.status()); }

  /* ----- lifecycle ----- */

  start(id?: string): void {
    for (const rt of this.pick(id)) {
      if (rt.state === "running") continue;
      if (rt.state === "paused") { rt.state = "running"; continue; }
      rt.state = "running";
      this.wire(rt);
      this.audit.add("agent.start", { agent: rt.def.id });
    }
    if (this.o.timers !== false && !this.sweeper) this.sweeper = setInterval(() => this.approvals.sweep(), 1000);
  }

  stop(id?: string): void {
    for (const rt of this.pick(id)) {
      this.unwire(rt.def.id);
      rt.state = "stopped";
      this.audit.add("agent.stop", { agent: rt.def.id });
    }
    if (!id || [...this.runtimes.values()].every((r) => r.state === "stopped")) {
      if (this.sweeper) clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  pause(id: string): void { const rt = this.get(id); if (rt.state === "running") { rt.state = "paused"; this.audit.add("agent.pause", { agent: id }); } }
  resume(id: string): void { const rt = this.get(id); if (rt.state === "paused") { rt.state = "running"; this.audit.add("agent.resume", { agent: id }); } }

  private pick(id?: string): AgentRuntime[] { return id ? [this.get(id)] : [...this.runtimes.values()]; }

  private wire(rt: AgentRuntime): void {
    const def = rt.def;
    const subs: (() => void)[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    def.triggers.forEach((t, i) => {
      if (t.kind === "event") {
        subs.push(this.bus.on(t.topic, async (e) => {
          if (rt.state !== "running") return;
          if (t.filter && !t.filter(e)) return;
          if (!rt.cooldownOk(`${i}`, t.cooldownMs)) return;
          await this.dispatch(rt, e);
        }));
      } else if (t.kind === "interval" && this.o.timers !== false) {
        timers.push(setInterval(() => void this.dispatch(rt, { topic: `tick.${def.id}`, payload: {}, ts: this.clock.now() }), t.everyMs));
      }
    });
    this.unsubs.set(def.id, subs);
    this.intervals.set(def.id, timers);
  }

  private unwire(id: string): void {
    this.unsubs.get(id)?.forEach((u) => u());
    this.intervals.get(id)?.forEach((t) => clearInterval(t));
    this.unsubs.delete(id); this.intervals.delete(id);
  }

  private async dispatch(rt: AgentRuntime, e: BusEvent, manual = false): Promise<RunResult> {
    if (rt.def.native) {
      if (rt.state !== "running") return { status: "skipped", reason: `agent ${rt.state}`, steps: 0, toolCalls: 0, text: "" };
      rt.stats.runs++;
      await rt.def.native({ economist: this.economist, controller: this, publish: (t, p) => this.bus.emit(t, p), event: e });
      return { status: "ok", steps: 0, toolCalls: 0, text: "" };
    }
    return rt.handle(e, { manual });
  }

  /** Streamer talks to an agent directly (trusted channel). */
  ask(id: string, text: string): Promise<RunResult> {
    return this.dispatch(this.get(id), { topic: "human.request", payload: { text }, ts: this.clock.now() }, true);
  }

  /** Run one agent on a synthetic event, bypassing triggers (used by CLI dry-run and tests). */
  trigger(id: string, topic: string, payload: unknown): Promise<RunResult> {
    return this.dispatch(this.get(id), { topic, payload, ts: this.clock.now() }, true);
  }

  /* ----- AgentController (for the economist) ----- */

  agentInfo() { return [...this.runtimes.values()].map((r) => ({ id: r.def.id, priority: r.def.priority, budgetPerHour: r.def.budgetPerHour })); }
  setThrottle(id: string, t: Throttle): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.throttle.level !== t.level) this.audit.add("agent.throttle", { agent: id, detail: t });
    rt.throttle = t;
  }

  dispose(): void { this.stop(); this.client_close(); }
  private client_close(): void { this.o.client.close?.(); }
}
