import type {
  Badge, BadgeKind, ChatConnector, ChatMessage, ConnectionState, ConnectorEvent, Emote,
  ModerationProposal, Unsubscribe,
} from "./types.js";
import { ReadOnlyError, UnsupportedError } from "./types.js";
import type { WsFactory, WsLike } from "./transport.js";
import { backoffDelay, cleanText, noopLogger, ProposalStore, RateLimiter, SeenSet, safeLogger } from "./util.js";
import type { Logger, Rng } from "./util.js";

export const TWITCH_WS_URL = "wss://irc-ws.chat.twitch.tv:443";

export interface IrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

const UNESCAPE: Record<string, string> = { ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" };
export function parseIrc(line: string): IrcMessage | null {
  let rest = line.replace(/[\r\n]+$/, "");
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    for (const kv of rest.slice(1, sp).split(";")) {
      const eq = kv.indexOf("=");
      const k = eq < 0 ? kv : kv.slice(0, eq);
      const v = eq < 0 ? "" : kv.slice(eq + 1);
      if (k) tags[k] = v.replace(/\\(.)/g, (_, c: string) => UNESCAPE[c] ?? c);
    }
    rest = rest.slice(sp + 1).trimStart();
  }
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }
  const params: string[] = [];
  let command = "";
  const sp = rest.indexOf(" ");
  if (sp < 0) command = rest; else { command = rest.slice(0, sp); rest = rest.slice(sp + 1); }
  if (sp >= 0) {
    while (rest.length) {
      if (rest.startsWith(":")) { params.push(rest.slice(1)); break; }
      const i = rest.indexOf(" ");
      if (i < 0) { params.push(rest); break; }
      params.push(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
  }
  if (!command) return null;
  return { tags, prefix, command: command.toUpperCase(), params };
}

const BADGE_KIND: Record<string, BadgeKind> = {
  broadcaster: "broadcaster", moderator: "moderator", vip: "vip", subscriber: "subscriber",
  founder: "subscriber", staff: "other", admin: "other", partner: "verified", premium: "other",
};
export function parseBadges(v: string | undefined): Badge[] {
  if (!v) return [];
  return v.split(",").filter(Boolean).map((p) => {
    const [id = "", version] = p.split("/");
    return { kind: BADGE_KIND[id] ?? "other", id, version };
  });
}

/** Twitch emote ranges are zero-based code point offsets, inclusive end (assumed code points; see README). */
export function parseEmotes(v: string | undefined, cps: string[]): Emote[] {
  if (!v) return [];
  const out: Emote[] = [];
  for (const ent of v.split("/")) {
    const [id, ranges] = ent.split(":");
    if (!id || !ranges) continue;
    for (const r of ranges.split(",")) {
      const [a, b] = r.split("-").map(Number);
      if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b >= cps.length) continue;
      out.push({
        id, name: cps.slice(a, b + 1).join(""), start: a, end: b + 1,
        url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`,
      });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export function toChatMessage(m: IrcMessage, fallbackNow: number): ChatMessage | null {
  if (m.command !== "PRIVMSG" || m.params.length < 2) return null;
  const id = m.tags["id"];
  if (!id) return null;
  let raw = m.params[1] ?? "";
  let kind: ChatMessage["kind"] = "chat";
  let shift = 0;
  const act = /^\x01ACTION /.exec(raw);
  if (act && raw.endsWith("\x01")) { kind = "action"; raw = raw.slice(act[0].length, -1); shift = act[0].length; }
  // emote offsets from Twitch count the full wire text (including the ACTION wrapper)
  const wire = Array.from((m.params[1] ?? ""));
  const emotes = parseEmotes(m.tags["emotes"], wire)
    .map((e) => ({ ...e, start: e.start - shift, end: e.end - shift }))
    .filter((e) => e.start >= 0);
  const text = cleanText(raw);
  const login = (m.prefix ?? "").split("!")[0] ?? "";
  const tsNum = Number(m.tags["tmi-sent-ts"]);
  return {
    platform: "twitch", id,
    channel: (m.params[0] ?? "").replace(/^#/, ""),
    ts: Number.isFinite(tsNum) && tsNum > 0 ? tsNum : fallbackNow,
    user: { id: m.tags["user-id"] ?? login, login, name: cleanText(m.tags["display-name"] || login, 64) },
    text, emotes: emotes.filter((e) => e.end <= Array.from(text).length),
    badges: parseBadges(m.tags["badges"]), kind,
  };
}

/** Twitch moderation goes through Helix (IRC /timeout, /ban, /delete commands were retired). Inject an implementation. */
export interface TwitchModerationApi {
  deleteMessage(messageId: string): Promise<void>;
  timeout(userId: string, durationSec: number, reason?: string): Promise<void>;
  ban(userId: string, reason?: string): Promise<void>;
}

export interface TwitchOptions {
  channel: string;
  createSocket: WsFactory;
  /** Omit for anonymous read-only mode. `getToken` is called per connect so the secret is never stored in options/logs. */
  auth?: { login: string; getToken: () => string | Promise<string> };
  moderation?: TwitchModerationApi;
  proposals?: ProposalStore;
  logger?: Logger;
  rng?: Rng;
  now?: () => number;
  backoff?: { baseMs?: number; maxMs?: number };
  /** Outgoing chat limit (default 20 per 30 s, the documented non-moderator limit is assumed) */
  sendLimit?: { count: number; perMs: number };
  url?: string;
}

type Fatal = { code: string; message: string };

export class TwitchConnector implements ChatConnector {
  readonly platform = "twitch" as const;
  private _state: ConnectionState = "idle";
  private msgCbs = new Set<(m: ChatMessage) => void>();
  private evCbs = new Set<(e: ConnectorEvent) => void>();
  private sock: WsLike | null = null;
  private gen = 0;
  private attempts = 0;
  private stopped = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seen = new SeenSet();
  private log: Logger;
  private channel: string;
  private limiter: RateLimiter;
  private proposals: ProposalStore;
  private rng: Rng;
  private now: () => number;
  private firstConnect!: { resolve: () => void; reject: (e: Error) => void; promise: Promise<void> };

  constructor(private o: TwitchOptions) {
    this.channel = o.channel.toLowerCase().replace(/^#/, "");
    if (!/^[a-z0-9_]{1,25}$/.test(this.channel)) throw new Error("invalid channel name");
    this.log = safeLogger(o.logger ?? noopLogger);
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
    this.proposals = o.proposals ?? new ProposalStore(this.now);
    this.limiter = new RateLimiter(o.sendLimit?.count ?? 20, o.sendLimit?.perMs ?? 30_000, this.now);
  }

  get state(): ConnectionState { return this._state; }
  get readOnly(): boolean { return !this.o.auth; }
  get proposalStore(): ProposalStore { return this.proposals; }

  onMessage(cb: (m: ChatMessage) => void): Unsubscribe { this.msgCbs.add(cb); return () => this.msgCbs.delete(cb); }
  onEvent(cb: (e: ConnectorEvent) => void): Unsubscribe { this.evCbs.add(cb); return () => this.evCbs.delete(cb); }

  private setState(s: ConnectionState, detail?: string): void {
    if (this._state === s) return;
    this._state = s;
    this.emit({ type: "state", platform: "twitch", state: s, detail });
  }
  private emit(e: ConnectorEvent): void {
    for (const cb of [...this.evCbs]) { try { cb(e); } catch { /* subscriber errors never break the connector */ } }
  }

  connect(): Promise<void> {
    if (this.started) return this.firstConnect.promise;
    this.started = true; this.stopped = false;
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
    promise.catch(() => {});
    this.firstConnect = { resolve, reject, promise };
    this.open();
    return promise;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.gen++;
    const s = this.sock; this.sock = null;
    try { s?.close(1000); } catch { /* ignore */ }
    this.firstConnect?.reject(new Error("disconnected"));
    this.started = false;
    this.setState("disconnected");
  }

  private open(): void {
    const gen = ++this.gen;
    this.setState(this.attempts === 0 && this._state !== "reconnecting" ? "connecting" : "reconnecting");
    let s: WsLike;
    try { s = this.o.createSocket(this.o.url ?? TWITCH_WS_URL); }
    catch (err) { this.log.warn("socket create failed", { err: String(err) }); this.scheduleReconnect(); return; }
    this.sock = s;
    let fatal: Fatal | null = null;
    s.onopen = () => { if (gen === this.gen) void this.handshake(s, gen); };
    s.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const f = this.handleData(String(ev.data), s);
      if (f) { fatal = f; }
    };
    s.onerror = () => { this.log.warn("socket error"); };
    s.onclose = () => {
      if (gen !== this.gen) return;
      this.sock = null;
      if (this.stopped) return;
      if (fatal) { this.fail(fatal); return; }
      this.scheduleReconnect();
    };
  }

  private async handshake(s: WsLike, gen: number): Promise<void> {
    try {
      let token = "SCHMOOPIIE"; // conventional placeholder password for anonymous logins
      let nick = `justinfan${10000 + Math.floor(this.rng() * 80000)}`;
      if (this.o.auth) {
        const t = await this.o.auth.getToken();
        if (gen !== this.gen) return;
        token = t.startsWith("oauth:") ? t : `oauth:${t}`;
        nick = this.o.auth.login.toLowerCase();
      }
      s.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
      s.send(`PASS ${token}`); // never logged
      s.send(`NICK ${nick}`);
      this.log.info("twitch handshake sent", { channel: this.channel, anonymous: !this.o.auth });
    } catch (err) {
      this.log.error("handshake failed", { err: String(err) });
      this.fail({ code: "auth-token", message: "could not obtain token" });
    }
  }

  private handleData(data: string, s: WsLike): Fatal | null {
    let fatal: Fatal | null = null;
    for (const line of data.split("\r\n")) {
      if (!line) continue;
      const m = parseIrc(line);
      if (!m) continue;
      switch (m.command) {
        case "PING": s.send(`PONG :${m.params[0] ?? "tmi.twitch.tv"}`); break;
        case "001":
          this.attempts = 0;
          s.send(`JOIN #${this.channel}`);
          this.setState("connected");
          this.firstConnect.resolve();
          break;
        case "RECONNECT":
          this.log.info("server requested reconnect");
          this.attempts = 0;
          this.recycle(s);
          break;
        case "PRIVMSG": {
          const cm = toChatMessage(m, this.now());
          if (cm && this.seen.add(`${cm.platform}:${cm.id}`)) for (const cb of [...this.msgCbs]) { try { cb(cm); } catch { /* isolate */ } }
          break;
        }
        case "CLEARMSG": {
          const id = m.tags["target-msg-id"];
          if (id) this.emit({ type: "message-deleted", platform: "twitch", id });
          break;
        }
        case "CLEARCHAT": {
          const uid = m.tags["target-user-id"];
          if (uid) {
            const d = Number(m.tags["ban-duration"]);
            this.emit({ type: "user-cleared", platform: "twitch", userId: uid, durationSec: Number.isFinite(d) && m.tags["ban-duration"] ? d : undefined });
          }
          break;
        }
        case "NOTICE": {
          const msg = m.params[1] ?? "";
          if (/login authentication failed|improperly formatted auth|login unsuccessful/i.test(msg)) {
            fatal = { code: "auth-failed", message: "authentication failed" };
            try { s.close(1000); } catch { /* ignore */ }
          }
          break;
        }
        default: break;
      }
    }
    return fatal;
  }

  /** drop the current socket and reconnect immediately */
  private recycle(s: WsLike): void {
    this.gen++; // silence old socket handlers
    this.sock = null;
    try { s.close(1000); } catch { /* ignore */ }
    if (!this.stopped) { this.setState("reconnecting"); this.open(); }
  }

  private fail(f: Fatal): void {
    this.stopped = true; this.started = false;
    this.gen++;
    try { this.sock?.close(1000); } catch { /* ignore */ }
    this.sock = null;
    this.emit({ type: "error", platform: "twitch", code: f.code, message: f.message });
    this.setState("failed", f.code);
    this.firstConnect?.reject(new Error(f.message));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempts++, this.rng, this.o.backoff);
    this.setState("reconnecting", `retry in ${delay}ms`);
    this.log.info("reconnect scheduled", { delay, attempt: this.attempts });
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.open(); }, delay);
  }

  async send(text: string): Promise<void> {
    if (!this.o.auth) throw new ReadOnlyError();
    if (this._state !== "connected" || !this.sock) throw new Error("not connected");
    const t = cleanText(text, 500).replace(/\s+/g, " ").trim();
    if (!t) throw new Error("empty message");
    if (!this.limiter.tryTake()) throw new Error(`rate limited, retry in ${this.limiter.waitMs()}ms`);
    this.sock.send(`PRIVMSG #${this.channel} :${t}`);
  }

  async deleteMessage(id: string): Promise<void> {
    if (!this.o.auth) throw new ReadOnlyError();
    if (!this.o.moderation) throw new UnsupportedError("twitch moderation API not configured");
    await this.o.moderation.deleteMessage(id);
  }

  requestTimeout(targetUserId: string, durationSec: number, reason?: string): ModerationProposal {
    return this.proposals.create({ platform: "twitch", kind: "timeout", targetUserId, durationSec: Math.max(1, Math.min(1_209_600, Math.floor(durationSec))), reason });
  }
  requestBan(targetUserId: string, reason?: string): ModerationProposal {
    return this.proposals.create({ platform: "twitch", kind: "ban", targetUserId, reason });
  }
  async executeProposal(id: string): Promise<void> {
    if (!this.o.auth) throw new ReadOnlyError();
    if (!this.o.moderation) throw new UnsupportedError("twitch moderation API not configured");
    const p = this.proposals.consume(id, "twitch");
    if (p.kind === "ban") await this.o.moderation.ban(p.targetUserId, p.reason);
    else await this.o.moderation.timeout(p.targetUserId, p.durationSec ?? 600, p.reason);
  }
}
