export interface ChatMsg {
  id: number; // cursor, monotonically increasing, starts at 1
  ts: number;
  platform: "twitch" | "youtube" | string;
  user: string;
  text: string;
  /** platform message id / user id when the message came from a connector (needed for moderation) */
  mid?: string;
  uid?: string;
}

export type ChatField = "id" | "ts" | "platform" | "user" | "text";
const SHORT: Record<ChatField, string> = { id: "i", ts: "ts", platform: "p", user: "u", text: "t" };

export interface ChatDelta {
  /** next cursor: pass back as since_cursor */
  c: number;
  /** compact items; repeated identical texts are folded into one with x=count */
  m: Record<string, unknown>[];
  /** true if more is available beyond limit */
  more?: true;
  /** messages lost because the cursor fell off the ring */
  lost?: number;
}

export class ChatBuffer {
  private buf: (ChatMsg | undefined)[];
  private next = 1; // next id
  private size = 0;
  constructor(readonly capacity = 500) {
    if (capacity < 1) throw new Error("capacity");
    this.buf = new Array(capacity);
  }
  get cursor(): number { return this.next - 1; }
  get oldest(): number { return this.size ? this.next - this.size : this.next; }

  push(m: Omit<ChatMsg, "id">): ChatMsg {
    const msg: ChatMsg = { ...m, id: this.next };
    this.buf[(this.next - 1) % this.capacity] = msg;
    this.next++;
    if (this.size < this.capacity) this.size++;
    return msg;
  }

  get(id: number): ChatMsg | undefined {
    if (id < this.oldest || id >= this.next) return undefined;
    return this.buf[(id - 1) % this.capacity];
  }

  /** Most recent buffered message from this user (case-insensitive), if any. */
  lastFrom(user: string, platform?: string): ChatMsg | undefined {
    const u = user.trim().toLowerCase();
    for (let id = this.next - 1; id >= this.oldest; id--) {
      const m = this.buf[(id - 1) % this.capacity];
      if (m && m.user.toLowerCase() === u && (!platform || m.platform === platform)) return m;
    }
    return undefined;
  }

  since(cursor = 0, opts: { limit?: number; fields?: ChatField[]; dedupe?: boolean } = {}): ChatDelta {
    const limit = Math.max(1, opts.limit ?? 30);
    const fields = opts.fields?.length ? opts.fields : (["user", "text"] as ChatField[]);
    const dedupe = opts.dedupe ?? true;
    const start = Math.max(cursor + 1, this.oldest);
    const lost = cursor + 1 < this.oldest && cursor < this.next - 1 ? this.oldest - (cursor + 1) : 0;
    const out: Record<string, unknown>[] = [];
    const seen = new Map<string, Record<string, unknown>>();
    let id = start;
    let consumed = 0;
    for (; id < this.next && consumed < limit; id++, consumed++) {
      const msg = this.buf[(id - 1) % this.capacity]!;
      const key = msg.text.trim().toLowerCase();
      const prev = dedupe ? seen.get(key) : undefined;
      if (prev) { prev.x = ((prev.x as number) ?? 1) + 1; continue; }
      const o: Record<string, unknown> = {};
      for (const f of fields) o[SHORT[f]] = msg[f];
      out.push(o);
      if (dedupe) seen.set(key, o);
    }
    const res: ChatDelta = { c: id - 1 < cursor ? cursor : id - 1, m: out };
    if (id < this.next) res.more = true;
    if (lost > 0) res.lost = lost;
    return res;
  }
}
