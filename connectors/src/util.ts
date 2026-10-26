import type { ModerationKind, ModerationProposal, Platform } from "./types.js";
import { NotApprovedError } from "./types.js";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const SECRET_KEY = /token|auth|pass|secret|key|oauth|bearer|cookie/i;
const SECRET_VAL = /(oauth:|bearer\s+)[A-Za-z0-9_\-.~+/=]+/gi;

/** Redact secrets from a value destined for logs. Chat text is never logged by connectors. */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.replace(SECRET_VAL, "$1[REDACTED]");
  if (v === null || typeof v !== "object" || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(val, depth + 1);
  return out;
}

/** Wrap a logger so every call is redacted. */
export function safeLogger(l: Logger): Logger {
  const w = (lvl: keyof Logger) => (msg: string, f?: Record<string, unknown>) =>
    l[lvl](String(redact(msg)), f ? (redact(f) as Record<string, unknown>) : undefined);
  return { debug: w("debug"), info: w("info"), warn: w("warn"), error: w("error") };
}

export type Rng = () => number;

export interface BackoffOptions { baseMs?: number; maxMs?: number; factor?: number; }

/** "Full jitter" exponential backoff: random in [0, min(max, base*factor^attempt)] with a floor of base/2. */
export function backoffDelay(attempt: number, rng: Rng = Math.random, o: BackoffOptions = {}): number {
  const base = o.baseMs ?? 1000, max = o.maxMs ?? 60_000, f = o.factor ?? 2;
  const cap = Math.min(max, base * Math.pow(f, Math.max(0, attempt)));
  const floor = base / 2;
  return Math.round(floor + rng() * Math.max(0, cap - floor));
}

/** Token bucket. `tryTake` is non-blocking; `waitMs` says how long until a token is available. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(readonly capacity: number, readonly perMs: number, private now: () => number = Date.now) {
    this.tokens = capacity; this.last = now();
  }
  private refill(): void {
    const t = this.now();
    const add = ((t - this.last) / this.perMs) * this.capacity;
    if (add > 0) { this.tokens = Math.min(this.capacity, this.tokens + add); this.last = t; }
  }
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) * this.perMs) / this.capacity);
  }
}

/** Bounded LRU-ish set for dedupe. */
export class SeenSet {
  private s = new Set<string>();
  constructor(private max = 2000) {}
  /** returns true if the key was new */
  add(k: string): boolean {
    if (this.s.has(k)) { this.s.delete(k); this.s.add(k); return false; }
    this.s.add(k);
    if (this.s.size > this.max) this.s.delete(this.s.values().next().value as string);
    return true;
  }
}

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
/** Length-preserving cleanup (control + bidi chars -> space) so emote offsets stay valid; then cap. */
export function cleanText(s: string, maxCodePoints = 2000): string {
  const c = s.replace(CTRL, " ");
  const cp = Array.from(c);
  return cp.length > maxCodePoints ? cp.slice(0, maxCodePoints).join("") : c;
}

/**
 * Proposals for destructive moderation. Approval is a separate, deliberate call that the
 * human-facing UI owns; agents/connectors only ever get to create proposals.
 */
export class ProposalStore {
  private m = new Map<string, ModerationProposal>();
  private n = 0;
  constructor(private now: () => number = Date.now, private ttlMs = 5 * 60_000) {}

  create(p: { platform: Platform; kind: ModerationKind; targetUserId: string; targetLogin?: string; durationSec?: number; reason?: string }): ModerationProposal {
    const t = this.now();
    const prop: ModerationProposal = { ...p, id: `mod_${++this.n}_${t.toString(36)}`, createdAt: t, expiresAt: t + this.ttlMs, status: "pending" };
    this.m.set(prop.id, prop);
    return { ...prop };
  }
  get(id: string): ModerationProposal | undefined {
    const p = this.m.get(id);
    if (!p) return undefined;
    if ((p.status === "pending" || p.status === "approved") && this.now() > p.expiresAt) p.status = "expired";
    return { ...p };
  }
  list(status?: ModerationProposal["status"]): ModerationProposal[] {
    return [...this.m.keys()].map((id) => this.get(id)!).filter((p) => !status || p.status === status);
  }
  approve(id: string): ModerationProposal {
    const p = this.live(id);
    if (p.status !== "pending") throw new NotApprovedError(id, p.status);
    p.status = "approved";
    return { ...p };
  }
  reject(id: string): ModerationProposal {
    const p = this.live(id);
    if (p.status === "executed") throw new NotApprovedError(id, p.status);
    p.status = "rejected";
    return { ...p };
  }
  /** Consume an approved proposal exactly once. */
  consume(id: string, platform: Platform): ModerationProposal {
    const p = this.live(id);
    if (p.platform !== platform) throw new NotApprovedError(id, `for ${p.platform}`);
    if (p.status !== "approved") throw new NotApprovedError(id, p.status);
    p.status = "executed";
    return { ...p };
  }
  private live(id: string): ModerationProposal {
    this.get(id);
    const p = this.m.get(id);
    if (!p) throw new NotApprovedError(id, "unknown");
    return p;
  }
}
