export interface BusEvent<T = unknown> {
  topic: string;
  payload: T;
  ts: number;
}
export type Handler = (e: BusEvent) => void | Promise<void>;

/**
 * Tiny pub/sub. Topics match exactly, or by prefix wildcard ("chat.*") or "*".
 * Handler errors never break publishers; they are re-published on "bus.error".
 */
export class EventBus {
  private subs = new Map<string, Set<Handler>>();
  constructor(private now: () => number = () => Date.now()) {}

  on(topic: string, h: Handler): () => void {
    let s = this.subs.get(topic);
    if (!s) this.subs.set(topic, (s = new Set()));
    s.add(h);
    return () => void s!.delete(h);
  }

  /** Publishes and resolves when every handler has settled. */
  async emit<T>(topic: string, payload: T): Promise<void> {
    const e: BusEvent<T> = { topic, payload, ts: this.now() };
    const hs: Handler[] = [];
    for (const [pat, set] of this.subs) {
      if (pat === topic || pat === "*" || (pat.endsWith(".*") && topic.startsWith(pat.slice(0, -1)))) hs.push(...set);
    }
    await Promise.all(
      hs.map(async (h) => {
        try {
          await h(e);
        } catch (err) {
          if (topic !== "bus.error") void this.emit("bus.error", { topic, error: String(err) });
        }
      }),
    );
  }
}
