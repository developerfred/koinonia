export interface DeltaResponse<T> {
  items: T[];
  /** Pass this back as `cursor` on the next call. */
  cursor: string;
  /** True when nothing changed (items empty). */
  unchanged: boolean;
  /** Ids removed since the cursor (only when `trackRemovals`). */
  removed?: string[];
}

export interface DeltaOptions<T> {
  /** Stable identity of an item. */
  idOf: (item: T) => string;
  /** Version/fingerprint; items with changed version are re-sent. Default JSON.stringify. */
  versionOf?: (item: T) => string;
  trackRemovals?: boolean;
  /** Max snapshots remembered (cursors). Default 32. */
  maxCursors?: number;
}

/**
 * Cursor-based delta: the server remembers a snapshot per cursor and replies with
 * only added/changed items. Unknown cursor -> full state (safe fallback).
 */
export class DeltaTracker<T> {
  private snapshots = new Map<string, Map<string, string>>();
  private seq = 0;
  constructor(private opts: DeltaOptions<T>) {}

  respond(current: T[], cursor?: string): DeltaResponse<T> {
    const ver = this.opts.versionOf ?? ((i: T) => JSON.stringify(i));
    const next = new Map<string, string>();
    for (const it of current) next.set(this.opts.idOf(it), ver(it));
    const prev = cursor ? this.snapshots.get(cursor) : undefined;

    const items = prev ? current.filter((it) => prev.get(this.opts.idOf(it)) !== next.get(this.opts.idOf(it))) : current;
    const removed =
      this.opts.trackRemovals && prev ? [...prev.keys()].filter((id) => !next.has(id)) : undefined;

    const newCursor = `c${++this.seq}`;
    this.snapshots.set(newCursor, next);
    const max = this.opts.maxCursors ?? 32;
    while (this.snapshots.size > max) this.snapshots.delete(this.snapshots.keys().next().value as string);
    if (cursor) this.snapshots.delete(cursor);

    const res: DeltaResponse<T> = { items, cursor: newCursor, unchanged: items.length === 0 && !(removed && removed.length) };
    if (removed) res.removed = removed;
    return res;
  }
}

/** Append-only feeds: return items after `cursor` (a numeric index string). */
export function sliceAfterCursor<T>(all: T[], cursor?: string): { items: T[]; cursor: string } {
  const start = cursor ? Math.min(Math.max(parseInt(cursor, 10) || 0, 0), all.length) : 0;
  return { items: all.slice(start), cursor: String(all.length) };
}
