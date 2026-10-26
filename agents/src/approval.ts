import type { AuditLog } from "./audit.ts";
import type { Clock, JsonObject, ToolResult } from "./types.ts";
import { systemClock } from "./types.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  agent: string;
  tool: string;
  args: JsonObject;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  result?: ToolResult;
}

export type Executor = (req: ApprovalRequest) => Promise<ToolResult>;

/**
 * Human-in-the-loop gate. Agents can only `request`; `approve`/`deny` are exposed to the
 * human side (CLI/UI) and are deliberately NOT available as agent tools.
 * Approved requests are executed by the registered executor with the originally requested args.
 */
export class ApprovalGate {
  private reqs = new Map<string, ApprovalRequest>();
  private n = 0;
  private clock: Clock;
  private listeners = new Set<(r: ApprovalRequest) => void>();
  private executor: Executor | null = null;

  constructor(private audit: AuditLog, private opts: { timeoutMs?: number; clock?: Clock; maxPending?: number } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  setExecutor(e: Executor): void { this.executor = e; }
  onRequest(fn: (r: ApprovalRequest) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Returns the request, or null if the pending queue is full (flood protection). */
  request(agent: string, tool: string, args: JsonObject, reason: string): ApprovalRequest | null {
    this.sweep();
    if (this.pending().length >= (this.opts.maxPending ?? 20)) {
      this.audit.add("approval.rejected_full", { agent, tool });
      return null;
    }
    const now = this.clock.now();
    const r: ApprovalRequest = {
      id: `apr-${++this.n}`, agent, tool, args, reason, createdAt: now,
      expiresAt: now + (this.opts.timeoutMs ?? 120_000), status: "pending",
    };
    this.reqs.set(r.id, r);
    this.audit.add("approval.requested", { agent, tool, detail: { id: r.id, args, reason } });
    for (const l of this.listeners) { try { l(r); } catch { /* ignore */ } }
    return r;
  }

  pending(): ApprovalRequest[] {
    return [...this.reqs.values()].filter((r) => r.status === "pending");
  }
  get(id: string): ApprovalRequest | undefined { return this.reqs.get(id); }
  all(): ApprovalRequest[] { return [...this.reqs.values()]; }

  /** Expire stale requests. Called lazily and by the orchestrator timer. */
  sweep(): ApprovalRequest[] {
    const now = this.clock.now();
    const out: ApprovalRequest[] = [];
    for (const r of this.reqs.values()) {
      if (r.status === "pending" && now >= r.expiresAt) {
        r.status = "expired";
        this.audit.add("approval.expired", { agent: r.agent, tool: r.tool, detail: { id: r.id } });
        out.push(r);
      }
    }
    return out;
  }

  async approve(id: string, by = "human"): Promise<ApprovalRequest> {
    const r = this.mustPending(id);
    r.status = "approved";
    r.decidedBy = by;
    this.audit.add("approval.approved", { agent: r.agent, tool: r.tool, detail: { id, by } });
    if (!this.executor) throw new Error("no executor configured");
    r.result = await this.executor(r);
    this.audit.add("approval.executed", { agent: r.agent, tool: r.tool, detail: { id, isError: !!r.result.isError } });
    return r;
  }

  deny(id: string, by = "human"): ApprovalRequest {
    const r = this.mustPending(id);
    r.status = "denied";
    r.decidedBy = by;
    this.audit.add("approval.denied", { agent: r.agent, tool: r.tool, detail: { id, by } });
    return r;
  }

  private mustPending(id: string): ApprovalRequest {
    this.sweep();
    const r = this.reqs.get(id);
    if (!r) throw new Error(`unknown approval ${id}`);
    if (r.status !== "pending") throw new Error(`approval ${id} is ${r.status}`);
    return r;
  }
}
