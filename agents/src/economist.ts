import { BudgetTracker, ModelRouter, UsageLedger, estimateTokens, trimOutput } from "../../tokens/src/index.ts";
import type { BudgetLimits, BudgetStatus, LedgerReport, Tier } from "../../tokens/src/index.ts";
import type { Clock, Usage } from "./types.ts";
import { systemClock } from "./types.ts";

export interface Throttle {
  /** 0 normal, 1 slower (gaps x2), 2 slower still (x4, low-priority events dropped), 3 paused. */
  level: 0 | 1 | 2 | 3;
  reason?: string;
}

/** What the economist needs from the orchestrator to throttle other agents. */
export interface AgentController {
  agentInfo(): { id: string; priority: number; budgetPerHour?: number }[];
  setThrottle(id: string, t: Throttle): void;
}

export interface CheckpointRequest {
  agentId: string;
  defaultTier: Tier;
  text: string;
  toolCount: number;
  maxTokens: number;
  /** Fixed overhead (system prompt + tool schemas) estimate. */
  overheadTokens: number;
}
export interface CheckpointDecision {
  allow: boolean;
  tier: Tier;
  model: string;
  maxTokens: number;
  reason: string;
}

export interface EconomistOptions {
  /** Whole-system budget. */
  global?: BudgetLimits;
  /** Per-agent budgets (tokens per hour). Agents without one are only bound by the global budget. */
  perAgentPerHour?: Record<string, number>;
  router?: ModelRouter;
  ledger?: UsageLedger;
  clock?: Clock;
  /** Max tokens a single tool result may occupy in context. */
  toolResultMaxTokens?: number;
  onAlert?: (a: { scope: string; status: BudgetStatus }) => void;
}

/**
 * Token Economist: wraps the tokens/ library for the agent runtime.
 * Routes models, enforces budgets (graceful degradation: warn -> cheaper tier -> stop),
 * compacts tool output before it enters context, and throttles other agents when the
 * global budget runs hot. Deterministic by design: it never calls an LLM itself.
 */
export class TokenEconomist {
  readonly router: ModelRouter;
  readonly ledger: UsageLedger;
  private global: BudgetTracker;
  private agents = new Map<string, BudgetTracker>();
  private clock: Clock;
  private perAgent: Record<string, number>;
  private toolMax: number;

  constructor(private o: EconomistOptions = {}) {
    this.clock = o.clock ?? systemClock;
    const c = () => this.clock.now();
    this.router = o.router ?? new ModelRouter();
    this.ledger = o.ledger ?? new UsageLedger({ clock: c });
    this.global = new BudgetTracker({ ...(o.global ?? {}), clock: c, onStateChange: (s) => o.onAlert?.({ scope: "global", status: s }) });
    this.perAgent = o.perAgentPerHour ?? {};
    this.toolMax = o.toolResultMaxTokens ?? 600;
  }

  private agentTracker(id: string): BudgetTracker | undefined {
    const lim = this.perAgent[id];
    if (!lim) return undefined;
    let t = this.agents.get(id);
    if (!t) {
      t = new BudgetTracker({ perHour: lim, clock: () => this.clock.now(), onStateChange: (s) => this.o.onAlert?.({ scope: id, status: s }) });
      this.agents.set(id, t);
    }
    return t;
  }

  setAgentBudget(id: string, perHour: number): void {
    this.perAgent[id] = perHour;
    this.agents.delete(id);
  }

  /** Call before every LLM request. */
  checkpoint(r: CheckpointRequest): CheckpointDecision {
    const est = estimateTokens(r.text) + r.overheadTokens + r.maxTokens;
    const at = this.agentTracker(r.agentId);
    const g = this.global.status();
    const a = at?.status();
    const stop = !this.global.canSpend(est) || (at ? !at.canSpend(est) : false);
    const steps = Math.max(g.degradeSteps, a?.degradeSteps ?? 0);
    const d = this.router.route({ text: r.text, hint: r.defaultTier, toolCount: r.toolCount, degradeSteps: steps });
    if (stop) {
      return { allow: false, tier: d.tier, model: d.model, maxTokens: 0, reason: `budget exhausted (${a?.state === "stop" ? r.agentId : "global"})` };
    }
    // degrade also shrinks the output cap
    const maxTokens = steps > 0 ? Math.max(128, Math.floor(r.maxTokens / (steps + 1))) : r.maxTokens;
    return { allow: true, tier: d.tier, model: d.model, maxTokens, reason: d.reason };
  }

  /** Call after every LLM response. */
  record(agentId: string, model: string, u: Usage, task?: string): number {
    const total = u.inputTokens + u.outputTokens + u.cacheWriteTokens + Math.round(u.cacheReadTokens * 0.1);
    this.global.record(total);
    this.agentTracker(agentId)?.record(total);
    const rec = { tool: agentId, task, model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
    const cost = this.ledger.record(rec);
    this.ledger.routing(rec);
    return cost;
  }

  /** Shrink a tool result before it enters the model's context. Returns the (possibly) compacted text. */
  compact(tool: string, text: string): string {
    const before = estimateTokens(text);
    let out = text;
    try {
      const data = JSON.parse(text) as unknown;
      out = JSON.stringify(trimOutput(stripBlobs(data), { verbosity: "normal" }));
    } catch { /* not JSON: leave as-is */ }
    const maxChars = this.toolMax * 4;
    if (out.length > maxChars) out = out.slice(0, maxChars) + `…[truncated ${out.length - maxChars} chars]`;
    this.ledger.compaction(before, estimateTokens(out), { tool });
    return out;
  }

  /**
   * Periodic policy: when the global budget runs hot, throttle the lowest-priority agents first.
   * warn -> nothing; degrade -> lowest-priority half slowed (level 1-2); stop -> everyone but top-priority paused.
   */
  enforce(ctl: AgentController): Record<string, Throttle> {
    const st = this.global.status();
    const infos = [...ctl.agentInfo()].sort((a, b) => a.priority - b.priority);
    const out: Record<string, Throttle> = {};
    infos.forEach((info, i) => {
      let level: Throttle["level"] = 0;
      let reason: string | undefined;
      if (st.state === "stop") { level = i === infos.length - 1 ? 1 : 3; reason = st.message; }
      else if (st.state === "degrade") { level = i < Math.ceil(infos.length / 2) ? 2 : 1; reason = st.message; }
      else if (st.state === "warn") { level = i === 0 ? 1 : 0; reason = st.message; }
      const own = this.agentTracker(info.id)?.status();
      if (own && own.state === "stop") { level = 3; reason = `own budget: ${own.message}`; }
      out[info.id] = { level, reason };
      ctl.setThrottle(info.id, out[info.id]!);
    });
    return out;
  }

  status(): { global: BudgetStatus; agents: Record<string, BudgetStatus> } {
    const agents: Record<string, BudgetStatus> = {};
    for (const id of Object.keys(this.perAgent)) { const t = this.agentTracker(id); if (t) agents[id] = t.status(); }
    return { global: this.global.status(), agents };
  }

  report(): LedgerReport {
    return this.ledger.report();
  }
}

/** Drop base64-ish blobs (capture_frame) -- a frame in context costs thousands of tokens. */
function stripBlobs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripBlobs);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      o[k] = typeof x === "string" && x.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(x.slice(0, 200)) ? `[omitted ${x.length} chars of binary]` : stripBlobs(x);
    }
    return o;
  }
  return v;
}
