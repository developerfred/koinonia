export interface BatcherOptions<T> {
  /** Flush this long after the first buffered event. Default 2000ms. */
  windowMs?: number;
  /** Flush immediately at this many events. Default 50. */
  maxItems?: number;
  onFlush: (batch: T[], reason: "window" | "size" | "manual") => void | Promise<void>;
  /** Optional collapse of duplicate events within a window. */
  keyOf?: (e: T) => string;
}

/** Collects events and delivers them as one batch (one LLM call instead of N). */
export class EventBatcher<T> {
  private buf: T[] = [];
  private keys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Events saved from separate delivery: sum(batch.length - 1). */
  coalesced = 0;
  constructor(private o: BatcherOptions<T>) {}

  add(e: T): void {
    if (this.o.keyOf) {
      const k = this.o.keyOf(e);
      if (this.keys.has(k)) {
        this.coalesced++;
        return;
      }
      this.keys.add(k);
    }
    this.buf.push(e);
    if (this.buf.length >= (this.o.maxItems ?? 50)) {
      void this.flush("size");
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush("window"), this.o.windowMs ?? 2000);
    }
  }

  async flush(reason: "window" | "size" | "manual" = "manual"): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buf.length) return;
    const batch = this.buf;
    this.buf = [];
    this.keys.clear();
    this.coalesced += batch.length - 1;
    await this.o.onFlush(batch, reason);
  }

  get pending(): number {
    return this.buf.length;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buf = [];
    this.keys.clear();
  }
}
