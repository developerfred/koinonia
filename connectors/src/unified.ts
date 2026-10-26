import type { ChatConnector, ChatMessage, ConnectorEvent, ModerationProposal, Platform, Unsubscribe } from "./types.js";
import type { Logger } from "./util.js";
import { noopLogger } from "./util.js";

/** Shape of studio/src/chat/ring.ts ChatMsg minus the id the buffer assigns. */
export interface RingPushShape { ts: number; platform: string; user: string; text: string; }
/** Structural match for ChatBuffer.push (read-only dependency on studio; no import). */
export interface RingLike { push(m: RingPushShape): unknown; }

export function toRingMsg(m: ChatMessage): RingPushShape {
  return { ts: m.ts, platform: m.platform, user: m.user.name, text: m.text };
}

export interface FeedItem { seq: number; message: ChatMessage; }

export interface UnifiedOptions {
  /** reorder window; messages are released oldest-ts-first after being held this long (default 250ms) */
  holdMs?: number;
  logger?: Logger;
  now?: () => number;
}

export class UnifiedChat {
  private conns = new Map<Platform, ChatConnector>();
  private subs = new Set<(i: FeedItem) => void>();
  private evSubs = new Set<(e: ConnectorEvent) => void>();
  private offs: Unsubscribe[] = [];
  private pend: { m: ChatMessage; at: number; n: number }[] = [];
  private arrival = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seenKeys = new Set<string>();
  private holdMs: number;
  private now: () => number;
  private log: Logger;

  constructor(o: UnifiedOptions = {}) {
    this.holdMs = o.holdMs ?? 250;
    this.now = o.now ?? Date.now;
    this.log = o.logger ?? noopLogger;
  }

  add(c: ChatConnector): this {
    if (this.conns.has(c.platform)) throw new Error(`connector for ${c.platform} already added`);
    this.conns.set(c.platform, c);
    this.offs.push(c.onMessage((m) => this.ingest(m)), c.onEvent((e) => { for (const cb of [...this.evSubs]) { try { cb(e); } catch { /* isolate */ } } }));
    return this;
  }

  /** Connect all; one platform failing does not block the others. Returns per-platform outcome. */
  async start(): Promise<Record<string, "ok" | string>> {
    const out: Record<string, "ok" | string> = {};
    await Promise.all([...this.conns.values()].map(async (c) => {
      try { await c.connect(); out[c.platform] = "ok"; } catch (e) { out[c.platform] = (e as Error).message; }
    }));
    return out;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.disconnect().catch(() => {})));
    this.flush(true);
  }

  onMessage(cb: (i: FeedItem) => void): Unsubscribe { this.subs.add(cb); return () => this.subs.delete(cb); }
  onEvent(cb: (e: ConnectorEvent) => void): Unsubscribe { this.evSubs.add(cb); return () => this.evSubs.delete(cb); }

  /** Feed a studio ChatBuffer-like ring. */
  pipeTo(ring: RingLike): Unsubscribe { return this.onMessage((i) => ring.push(toRingMsg(i.message))); }

  get cursor(): number { return this.seq; }

  private ingest(m: ChatMessage): void {
    const key = `${m.platform}:${m.id}`;
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    if (this.seenKeys.size > 5000) this.seenKeys.delete(this.seenKeys.values().next().value as string);
    this.pend.push({ m, at: this.now(), n: this.arrival++ });
    if (this.holdMs <= 0) { this.flush(true); return; }
    this.arm();
  }

  private arm(): void {
    if (this.timer || !this.pend.length) return;
    const oldest = Math.min(...this.pend.map((p) => p.at));
    this.timer = setTimeout(() => { this.timer = null; this.flush(false); this.arm(); }, Math.max(0, oldest + this.holdMs - this.now()));
  }

  private flush(all: boolean): void {
    const cutoff = this.now() - this.holdMs;
    const ready = this.pend.filter((p) => all || p.at <= cutoff);
    if (!ready.length) return;
    this.pend = this.pend.filter((p) => !ready.includes(p));
    ready.sort((a, b) => a.m.ts - b.m.ts || a.n - b.n);
    for (const r of ready) {
      const item: FeedItem = { seq: ++this.seq, message: r.m };
      for (const cb of [...this.subs]) { try { cb(item); } catch (e) { this.log.warn("feed subscriber threw", { err: String(e) }); } }
    }
  }

  // --- moderation: proposals only ---
  requestTimeout(platform: Platform, userId: string, sec: number, reason?: string): ModerationProposal {
    return this.get(platform).requestTimeout(userId, sec, reason);
  }
  requestBan(platform: Platform, userId: string, reason?: string): ModerationProposal {
    return this.get(platform).requestBan(userId, reason);
  }
  /** Called by the human-approval UI after approve(). */
  async execute(proposalId: string): Promise<void> {
    const p = this.findProposal(proposalId);
    if (!p) throw new Error("unknown proposal");
    await this.get(p.platform).executeProposal(proposalId);
  }
  /** Human-facing approval. Do not expose to agents. */
  approve(id: string): ModerationProposal { return this.storeOf(id).approve(id); }
  reject(id: string): ModerationProposal { return this.storeOf(id).reject(id); }
  pendingProposals(): ModerationProposal[] { return [...this.conns.values()].flatMap((c) => c.proposalStore.list("pending")); }
  private findProposal(id: string): ModerationProposal | undefined {
    for (const c of this.conns.values()) { const p = c.proposalStore.get(id); if (p) return p; }
    return undefined;
  }
  private storeOf(id: string) {
    for (const c of this.conns.values()) if (c.proposalStore.get(id)) return c.proposalStore;
    throw new Error("unknown proposal");
  }
  async send(platform: Platform, text: string): Promise<void> { await this.get(platform).send(text); }
  private get(p: Platform): ChatConnector {
    const c = this.conns.get(p);
    if (!c) throw new Error(`no connector for ${p}`);
    return c;
  }
}
