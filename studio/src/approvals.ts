/**
 * Human approval queue. Nothing in here ever moderates by itself:
 *  - `propose()` (page tools ban_user / timeout_user / delete_message) only records a pending item;
 *  - `approve()` is called by the human-facing UI. Items that came from the agents runtime ("bridge")
 *    are forwarded back to it (the runtime's own gate executes them via the page tool, which accepts
 *    exactly one single-use grant minted here); items proposed directly on the page run the executor.
 */
export type ModTool = "ban_user" | "timeout_user" | "delete_message";
export const MOD_TOOLS: readonly ModTool[] = ["ban_user", "timeout_user", "delete_message"];
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

export interface ApprovalItem {
  id: string;
  origin: "tool" | "bridge";
  agent?: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  result?: string;
}

export type ModExecutor = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>;
export interface DecisionSink { decide(externalId: string, approve: boolean): void }

const key = (tool: string, args: Record<string, unknown>) => tool + "|" + stableJson(args);
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}

export class ApprovalQueue {
  private items = new Map<string, ApprovalItem>();
  private grants = new Map<string, number>(); // key -> expiry
  private n = 0;
  private subs = new Set<(i: ApprovalItem) => void>();
  executor: ModExecutor = async () => ({ ok: false, detail: "no executor configured" });
  sink: DecisionSink | null = null;
  constructor(private now: () => number = () => Date.now(), private ttlMs = 120_000, private maxPending = 20) {}

  onChange(fn: (i: ApprovalItem) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  private emit(i: ApprovalItem) { for (const f of this.subs) { try { f(i); } catch { /* isolate */ } } }

  /** Page tool path: record only. Returns null when the queue is full (flood protection). */
  propose(tool: string, args: Record<string, unknown>, reason: string, agent?: string): ApprovalItem | null {
    this.sweep();
    const dup = this.pending().find((p) => p.origin === "tool" && key(p.tool, p.args) === key(tool, args));
    if (dup) return dup;
    if (this.pending().length >= this.maxPending) return null;
    return this.add({ origin: "tool", tool, args, reason, agent });
  }

  /** Request mirrored from the agents runtime (bridge notification `approval.requested`). */
  mirror(ext: { id: string; agent?: string; tool: string; args: Record<string, unknown>; reason?: string; expiresAt?: number }): ApprovalItem {
    const existing = this.items.get("ext:" + ext.id);
    if (existing) return existing;
    return this.add({ origin: "bridge", tool: ext.tool, args: ext.args, reason: ext.reason ?? "", agent: ext.agent, expiresAt: ext.expiresAt }, "ext:" + ext.id);
  }

  private add(o: { origin: "tool" | "bridge"; tool: string; args: Record<string, unknown>; reason: string; agent?: string; expiresAt?: number }, id?: string): ApprovalItem {
    const t = this.now();
    const item: ApprovalItem = { id: id ?? `mod-${++this.n}`, origin: o.origin, agent: o.agent, tool: o.tool, args: o.args, reason: String(o.reason).slice(0, 300),
      createdAt: t, expiresAt: o.expiresAt ?? t + this.ttlMs, status: "pending" };
    this.items.set(item.id, item);
    this.emit(item);
    return item;
  }

  pending(): ApprovalItem[] { return [...this.items.values()].filter((i) => i.status === "pending"); }
  list(): ApprovalItem[] { return [...this.items.values()]; }
  get(id: string): ApprovalItem | undefined { return this.items.get(id); }

  sweep(): void {
    const t = this.now();
    for (const i of this.items.values()) if (i.status === "pending" && t >= i.expiresAt) { i.status = "expired"; this.emit(i); }
    for (const [k, exp] of this.grants) if (t >= exp) this.grants.delete(k);
  }

  async approve(id: string): Promise<ApprovalItem> {
    this.sweep();
    const i = this.items.get(id);
    if (!i) throw new Error("unknown approval " + id);
    if (i.status !== "pending") throw new Error(`approval ${id} is ${i.status}`);
    if (i.origin === "bridge") {
      this.grants.set(key(i.tool, i.args), this.now() + 30_000);
      i.status = "approved";
      this.emit(i);
      this.sink?.decide(id.slice(4), true);
      return i;
    }
    i.status = "approved";
    this.emit(i);
    try {
      const r = await this.executor(i.tool, i.args);
      i.status = r.ok ? "executed" : "failed";
      i.result = r.detail;
    } catch (e) { i.status = "failed"; i.result = String((e as Error).message ?? e); }
    this.emit(i);
    return i;
  }

  deny(id: string): ApprovalItem {
    const i = this.items.get(id);
    if (!i) throw new Error("unknown approval " + id);
    if (i.status !== "pending") throw new Error(`approval ${id} is ${i.status}`);
    i.status = "denied";
    this.emit(i);
    if (i.origin === "bridge") this.sink?.decide(id.slice(4), false);
    return i;
  }

  /** Called by the page tool: true exactly once per human approval of the same tool+args. */
  consumeGrant(tool: string, args: Record<string, unknown>): boolean {
    this.sweep();
    return this.grants.delete(key(tool, args));
  }

  /** Result of an agent-runtime execution (bridge notification `approval.result`). */
  settle(extId: string, ok: boolean, detail: string): void {
    const i = this.items.get("ext:" + extId);
    if (!i) return;
    i.status = ok ? "executed" : "failed";
    i.result = detail;
    this.emit(i);
  }
  /** The runtime decided/expired it elsewhere. */
  closeExternal(extId: string, status: ApprovalStatus): void {
    const i = this.items.get("ext:" + extId);
    if (i && i.status === "pending") { i.status = status; this.emit(i); }
  }
}
