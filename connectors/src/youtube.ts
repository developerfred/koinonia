import type {
  Badge, ChatConnector, ChatMessage, ConnectionState, ConnectorEvent, Emote, ModerationProposal, Unsubscribe,
} from "./types.js";
import { ReadOnlyError, UnsupportedError } from "./types.js";
import { backoffDelay, cleanText, noopLogger, ProposalStore, RateLimiter, SeenSet, safeLogger } from "./util.js";
import type { Logger, Rng } from "./util.js";

// ---- API surface (inject a real fetch-backed one, or a mock) ----

export interface YtLiveChatMessage {
  id: string;
  snippet: {
    type: string;
    publishedAt?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
    superChatDetails?: { userComment?: string; amountDisplayString?: string };
    messageDeletedDetails?: { deletedMessageId?: string };
    userBannedDetails?: { bannedUserDetails?: { channelId?: string }; banType?: string; banDurationSeconds?: string };
  };
  authorDetails?: {
    channelId?: string; displayName?: string;
    isChatOwner?: boolean; isChatModerator?: boolean; isChatSponsor?: boolean; isVerified?: boolean;
  };
}
export interface YtPage {
  items: YtLiveChatMessage[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
}
export class YouTubeApiError extends Error {
  constructor(readonly status: number, readonly reason: string, message = reason) { super(message); this.name = "YouTubeApiError"; }
}
export interface YouTubeApi {
  list(args: { liveChatId: string; pageToken?: string; maxResults?: number }): Promise<YtPage>;
  /** Optional server-push mode (liveChatMessages.streamList). Falls back to polling if it throws. */
  streamList?(args: { liveChatId: string; pageToken?: string }, signal: AbortSignal): AsyncIterable<YtPage>;
  insert(liveChatId: string, text: string): Promise<void>;
  remove(messageId: string): Promise<void>;
  ban(liveChatId: string, channelId: string, durationSec?: number): Promise<void>;
}

/** Thin fetch-backed implementation of the REST methods. Token comes from a getter; never logged. */
export function createFetchYouTubeApi(o: { fetch?: typeof fetch; getAccessToken: () => string | Promise<string> }): YouTubeApi {
  const f = o.fetch ?? fetch;
  const base = "https://www.googleapis.com/youtube/v3";
  async function call(method: string, path: string, qs: Record<string, string>, body?: unknown): Promise<unknown> {
    const tok = await o.getAccessToken();
    const res = await f(`${base}${path}?${new URLSearchParams(qs)}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    let j: any = null;
    try { j = await res.json(); } catch { /* non-json */ }
    if (!res.ok) throw new YouTubeApiError(res.status, String(j?.error?.errors?.[0]?.reason ?? `http_${res.status}`));
    return j;
  }
  return {
    async list(a) {
      const qs: Record<string, string> = { liveChatId: a.liveChatId, part: "id,snippet,authorDetails" };
      if (a.pageToken) qs["pageToken"] = a.pageToken;
      if (a.maxResults) qs["maxResults"] = String(a.maxResults);
      return (await call("GET", "/liveChat/messages", qs)) as YtPage;
    },
    async insert(id, text) {
      await call("POST", "/liveChat/messages", { part: "snippet" }, { snippet: { liveChatId: id, type: "textMessageEvent", textMessageDetails: { messageText: text } } });
    },
    async remove(mid) { await call("DELETE", "/liveChat/messages", { id: mid }); },
    async ban(id, ch, d) {
      await call("POST", "/liveChat/bans", { part: "snippet" }, {
        snippet: { liveChatId: id, type: d ? "temporary" : "permanent", ...(d ? { banDurationSeconds: d } : {}), bannedUserDetails: { channelId: ch } },
      });
    },
  };
}

// ---- Quota ----

export interface QuotaCosts { list: number; insert: number; remove: number; ban: number; }
/** list=5 and insert=20 per official docs; remove/ban are assumed (see README). */
export const DEFAULT_COSTS: QuotaCosts = { list: 5, insert: 20, remove: 20, ban: 50 };

/** Next midnight America/Los_Angeles (quota reset time per docs: Pacific). DST-transition days can be off by an hour. */
export function nextQuotaReset(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(nowMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0) % 24;
  const since = ((g("hour") * 60 + g("minute")) * 60 + g("second")) * 1000;
  return nowMs - since + 86_400_000;
}

export class QuotaTracker {
  private used = 0;
  private resetAt: number;
  constructor(readonly dailyLimit = 10_000, private now: () => number = Date.now) { this.resetAt = nextQuotaReset(now()); }
  private roll(): void { const t = this.now(); if (t >= this.resetAt) { this.used = 0; this.resetAt = nextQuotaReset(t); } }
  get remaining(): number { this.roll(); return Math.max(0, this.dailyLimit - this.used); }
  get resetsAt(): number { this.roll(); return this.resetAt; }
  canSpend(n: number): boolean { return this.remaining >= n; }
  spend(n: number): void { this.roll(); this.used += n; }
  /** server told us quota is gone */
  exhaust(): void { this.roll(); this.used = this.dailyLimit; }
  /** minimum poll spacing so remaining quota lasts until reset */
  stretchIntervalMs(cost: number, horizonMs = Infinity): number {
    const calls = Math.floor(this.remaining / cost);
    if (calls <= 0) return Infinity;
    return Math.ceil(Math.min(this.resetsAt - this.now(), horizonMs) / calls);
  }
}

// ---- Normalization ----

const SHORTCODE = /(?<![A-Za-z0-9:])(:[A-Za-z][A-Za-z0-9_-]{1,40}:)(?![A-Za-z0-9])/g;
export function extractShortcodes(text: string): Emote[] {
  const out: Emote[] = [];
  const cps = Array.from(text);
  let cpIndex = 0, last = 0;
  for (const m of text.matchAll(SHORTCODE)) {
    const idx = m.index ?? 0;
    cpIndex += Array.from(text.slice(last, idx)).length;
    const len = Array.from(m[1]!).length;
    out.push({ name: m[1]!, start: cpIndex, end: cpIndex + len });
    cpIndex += len; last = idx + m[1]!.length;
  }
  void cps;
  return out;
}

export function ytBadges(a: NonNullable<YtLiveChatMessage["authorDetails"]>): Badge[] {
  const b: Badge[] = [];
  if (a.isChatOwner) b.push({ kind: "broadcaster", id: "owner" });
  if (a.isChatModerator) b.push({ kind: "moderator", id: "moderator" });
  if (a.isChatSponsor) b.push({ kind: "subscriber", id: "member" });
  if (a.isVerified) b.push({ kind: "verified", id: "verified" });
  return b;
}

export function ytToChatMessage(m: YtLiveChatMessage, channel: string, now: number): ChatMessage | null {
  const t = m.snippet?.type;
  let raw: string | undefined, kind: ChatMessage["kind"] = "chat", paid: string | undefined;
  if (t === "textMessageEvent") raw = m.snippet.textMessageDetails?.messageText ?? m.snippet.displayMessage;
  else if (t === "superChatEvent") { raw = m.snippet.superChatDetails?.userComment ?? m.snippet.displayMessage ?? ""; kind = "paid"; paid = m.snippet.superChatDetails?.amountDisplayString; }
  else return null;
  if (raw === undefined || !m.id) return null;
  const text = cleanText(raw);
  const a = m.authorDetails ?? {};
  const ts = Date.parse(m.snippet.publishedAt ?? "");
  const cid = a.channelId ?? "";
  return {
    platform: "youtube", id: m.id, channel, ts: Number.isFinite(ts) ? ts : now,
    user: { id: cid, login: cid, name: cleanText(a.displayName ?? cid, 64) },
    text, emotes: extractShortcodes(text), badges: ytBadges(a), kind, ...(paid ? { paid } : {}),
  };
}

// ---- Connector ----

export interface YouTubeOptions {
  api: YouTubeApi;
  liveChatId: string;
  /** Without write access the connector is read-only (API-key / no-OAuth mode). */
  canWrite?: boolean;
  quota?: QuotaTracker;
  costs?: QuotaCosts;
  proposals?: ProposalStore;
  logger?: Logger;
  rng?: Rng;
  now?: () => number;
  backoff?: { baseMs?: number; maxMs?: number };
  /** floor for poll spacing when the server gives none (default 5000ms) */
  minPollMs?: number;
  /** emit the first page (recent history) instead of discarding it */
  replayBacklog?: boolean;
  /** polling is paced so remaining quota lasts this long (default 6h, capped at the quota reset) */
  quotaHorizonMs?: number;
  /** use api.streamList when available */
  preferStream?: boolean;
  sendLimit?: { count: number; perMs: number };
}

export class YouTubeConnector implements ChatConnector {
  readonly platform = "youtube" as const;
  private _state: ConnectionState = "idle";
  private msgCbs = new Set<(m: ChatMessage) => void>();
  private evCbs = new Set<(e: ConnectorEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private token: string | undefined;
  private first = true;
  private errAttempts = 0;
  private rateAttempts = 0;
  private stopped = true;
  private seen = new SeenSet();
  private log: Logger;
  private rng: Rng;
  private now: () => number;
  readonly quota: QuotaTracker;
  private costs: QuotaCosts;
  private proposals: ProposalStore;
  private limiter: RateLimiter;
  private firstConnect!: { resolve: () => void; reject: (e: Error) => void; promise: Promise<void> };
  private connectedOnce = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private o: YouTubeOptions) {
    this.log = safeLogger(o.logger ?? noopLogger);
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
    this.quota = o.quota ?? new QuotaTracker(10_000, this.now);
    this.costs = o.costs ?? DEFAULT_COSTS;
    this.proposals = o.proposals ?? new ProposalStore(this.now);
    this.limiter = new RateLimiter(o.sendLimit?.count ?? 10, o.sendLimit?.perMs ?? 30_000, this.now);
  }

  get state(): ConnectionState { return this._state; }
  get readOnly(): boolean { return !this.o.canWrite; }
  get proposalStore(): ProposalStore { return this.proposals; }
  onMessage(cb: (m: ChatMessage) => void): Unsubscribe { this.msgCbs.add(cb); return () => this.msgCbs.delete(cb); }
  onEvent(cb: (e: ConnectorEvent) => void): Unsubscribe { this.evCbs.add(cb); return () => this.evCbs.delete(cb); }
  private emit(e: ConnectorEvent): void { for (const cb of [...this.evCbs]) { try { cb(e); } catch { /* isolate */ } } }
  private setState(s: ConnectionState, detail?: string): void {
    if (this._state === s && detail === undefined) return;
    this._state = s;
    this.emit({ type: "state", platform: "youtube", state: s, detail });
  }

  connect(): Promise<void> {
    if (!this.stopped) return this.firstConnect.promise;
    this.stopped = false; this.first = true; this.token = undefined; this.connectedOnce = false;
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
    promise.catch(() => {});
    this.firstConnect = { resolve, reject, promise };
    this.setState("connecting");
    this.schedule(0);
    return promise;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.abort?.abort(); this.abort = null;
    this.firstConnect?.reject(new Error("disconnected"));
    this.setState("disconnected");
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.pending = this.tick(); }, ms);
  }

  /** wait for the in-flight poll (test helper / graceful shutdown) */
  idle(): Promise<void> { return this.pending; }

  private markConnected(): void {
    if (!this.connectedOnce) { this.connectedOnce = true; this.firstConnect.resolve(); }
    this.setState("connected");
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const cost = this.costs.list;
    if (!this.quota.canSpend(cost)) { this.pauseForQuota(); return; }
    if (this.o.preferStream && this.o.api.streamList) { await this.runStream(); return; }
    this.quota.spend(cost);
    let page: YtPage;
    try {
      page = await this.o.api.list({ liveChatId: this.o.liveChatId, pageToken: this.token, maxResults: 500 });
    } catch (err) { this.handleError(err); return; }
    if (this.stopped) return;
    this.errAttempts = 0; this.rateAttempts = 0;
    this.markConnected();
    const ended = this.handlePage(page);
    if (ended) return;
    const server = page.pollingIntervalMillis ?? this.o.minPollMs ?? 5000;
    const stretch = this.quota.stretchIntervalMs(cost, this.o.quotaHorizonMs ?? 6 * 3600_000);
    this.schedule(Math.max(server, this.o.minPollMs ?? 0, Number.isFinite(stretch) ? stretch : 0));
  }

  private async runStream(): Promise<void> {
    const ac = (this.abort = new AbortController());
    try {
      this.quota.spend(this.costs.list); // assumed: opening a stream costs one list unit; see README
      for await (const page of this.o.api.streamList!({ liveChatId: this.o.liveChatId, pageToken: this.token }, ac.signal)) {
        if (this.stopped) return;
        this.errAttempts = 0;
        this.markConnected();
        if (this.handlePage(page)) return;
      }
      if (!this.stopped) this.schedule(backoffDelay(this.errAttempts++, this.rng, this.o.backoff));
    } catch (err) {
      if (this.stopped) return;
      this.log.warn("stream failed, falling back to polling", { err: String(err) });
      this.o = { ...this.o, preferStream: false };
      this.handleError(err);
    }
  }

  /** returns true if the chat ended */
  private handlePage(page: YtPage): boolean {
    if (page.nextPageToken) this.token = page.nextPageToken;
    const emit = !this.first || this.o.replayBacklog;
    this.first = false;
    for (const it of page.items ?? []) {
      const t = it.snippet?.type;
      if (t === "messageDeletedEvent") {
        const id = it.snippet.messageDeletedDetails?.deletedMessageId;
        if (id) this.emit({ type: "message-deleted", platform: "youtube", id });
        continue;
      }
      if (t === "userBannedEvent") {
        const uid = it.snippet.userBannedDetails?.bannedUserDetails?.channelId;
        const d = Number(it.snippet.userBannedDetails?.banDurationSeconds);
        if (uid) this.emit({ type: "user-cleared", platform: "youtube", userId: uid, durationSec: Number.isFinite(d) && d > 0 ? d : undefined });
        continue;
      }
      const cm = ytToChatMessage(it, this.o.liveChatId, this.now());
      if (!cm) continue;
      const isNew = this.seen.add(`youtube:${cm.id}`);
      if (isNew && emit) for (const cb of [...this.msgCbs]) { try { cb(cm); } catch { /* isolate */ } }
    }
    if (page.offlineAt) { this.end("offline"); return true; }
    return false;
  }

  private end(why: string): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.setState("ended", why);
  }

  private pauseForQuota(): void {
    const wait = Math.max(1000, this.quota.resetsAt - this.now());
    this.setState("paused", "quota");
    this.emit({ type: "error", platform: "youtube", code: "quota", message: `quota exhausted; resuming in ${wait}ms` });
    this.schedule(wait);
  }

  private handleError(err: unknown): void {
    if (this.stopped) return;
    const e = err instanceof YouTubeApiError ? err : null;
    const reason = e?.reason ?? "network";
    this.log.warn("youtube poll error", { status: e?.status, reason });
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") { this.quota.exhaust(); this.pauseForQuota(); return; }
    if (reason === "liveChatEnded" || reason === "liveChatNotFound" || reason === "liveChatDisabled") { this.end(reason); this.firstConnect.reject(new Error(reason)); return; }
    if (e && (e.status === 401 || (e.status === 403 && reason === "forbidden"))) {
      this.stopped = true;
      this.emit({ type: "error", platform: "youtube", code: "auth", message: "authorization failed" });
      this.setState("failed", "auth");
      this.firstConnect.reject(new Error("authorization failed"));
      return;
    }
    if (reason === "rateLimitExceeded") {
      // polled faster than allowed: back off harder than the normal curve
      const d = backoffDelay(++this.rateAttempts, this.rng, { baseMs: 5000, maxMs: 120_000, ...this.o.backoff });
      this.setState("reconnecting", `rate limited, retry in ${d}ms`);
      this.schedule(d);
      return;
    }
    const d = backoffDelay(this.errAttempts++, this.rng, this.o.backoff);
    this.setState("reconnecting", `retry in ${d}ms`);
    this.schedule(d);
  }

  // ---- write side ----

  private async spendFor(cost: number): Promise<void> {
    if (!this.quota.canSpend(cost)) throw new Error("youtube quota exhausted");
    this.quota.spend(cost);
  }

  async send(text: string): Promise<void> {
    if (!this.o.canWrite) throw new ReadOnlyError();
    const t = cleanText(text, 200).replace(/\s+/g, " ").trim();
    if (!t) throw new Error("empty message");
    if (!this.limiter.tryTake()) throw new Error(`rate limited, retry in ${this.limiter.waitMs()}ms`);
    await this.spendFor(this.costs.insert);
    await this.o.api.insert(this.o.liveChatId, t);
  }

  async deleteMessage(id: string): Promise<void> {
    if (!this.o.canWrite) throw new ReadOnlyError();
    await this.spendFor(this.costs.remove);
    await this.o.api.remove(id);
  }

  requestTimeout(targetUserId: string, durationSec: number, reason?: string): ModerationProposal {
    return this.proposals.create({ platform: "youtube", kind: "timeout", targetUserId, durationSec: Math.max(1, Math.floor(durationSec)), reason });
  }
  requestBan(targetUserId: string, reason?: string): ModerationProposal {
    return this.proposals.create({ platform: "youtube", kind: "ban", targetUserId, reason });
  }
  async executeProposal(id: string): Promise<void> {
    if (!this.o.canWrite) throw new ReadOnlyError();
    const p = this.proposals.consume(id, "youtube");
    await this.spendFor(this.costs.ban);
    await this.o.api.ban(this.o.liveChatId, p.targetUserId, p.kind === "timeout" ? p.durationSec : undefined);
  }
}
void UnsupportedError;
