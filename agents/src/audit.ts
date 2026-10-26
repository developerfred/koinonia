import type { Clock, JsonObject } from "./types.ts";
import { systemClock } from "./types.ts";
import { redactSecrets } from "./safety.ts";

export interface AuditEntry {
  ts: number;
  type: string;
  agent?: string;
  tool?: string;
  detail?: unknown;
}

/** Append-only (bounded) audit log; optional sink for persistence. Secrets are redacted. */
export class AuditLog {
  private entries: AuditEntry[] = [];
  constructor(private opts: { clock?: Clock; max?: number; sink?: (e: AuditEntry) => void } = {}) {}

  add(type: string, f: { agent?: string; tool?: string; detail?: unknown } = {}): AuditEntry {
    const clock = this.opts.clock ?? systemClock;
    const e: AuditEntry = JSON.parse(redactSecrets(JSON.stringify({ ts: clock.now(), type, ...f })));
    this.entries.push(e);
    if (this.entries.length > (this.opts.max ?? 5000)) this.entries.shift();
    try { this.opts.sink?.(e); } catch { /* sink must not break the runtime */ }
    return e;
  }
  all(): readonly AuditEntry[] {
    return this.entries;
  }
  ofType(type: string): AuditEntry[] {
    return this.entries.filter((e) => e.type === type);
  }
}
export type { JsonObject };
