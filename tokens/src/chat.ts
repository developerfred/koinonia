import { estimateTokens } from "./estimate.js";

export interface ChatMessage {
  id?: string;
  user: string;
  text: string;
  ts?: number;
  platform?: string;
}

export interface CompactChatOptions {
  /** Max output entries (default 20). Most recent / highest-weight kept. */
  limit?: number;
  /** Collapse identical (normalized) messages into one entry with a count. Default true. */
  dedupe?: boolean;
  /** Group messages sharing a topic key (default: first significant word). Default true. */
  cluster?: boolean;
  /** Minimum cluster size to be emitted as a cluster. Default 3. */
  minClusterSize?: number;
  /** Custom topic key. Return undefined for "no topic". */
  topicOf?: (m: ChatMessage) => string | undefined;
  /** Max chars kept per sample text. Default 140. */
  maxTextLength?: number;
}

export interface ChatEntry {
  kind: "message" | "cluster";
  text: string;
  user: string;
  /** Number of original messages represented. */
  count: number;
  users?: string[];
  topic?: string;
}

export interface CompactChatResult {
  entries: ChatEntry[];
  totalMessages: number;
  droppedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
}

const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "i", "you", "it", "in", "on", "that", "this", "de", "que", "o", "a", "e", "um", "uma", "para", "com", "no", "na"]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultTopic(m: ChatMessage): string | undefined {
  const words = normalizeText(m.text).split(" ").filter((w) => w.length > 3 && !STOP.has(w));
  return words[0];
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Dedupe, cluster and limit chat messages before they enter the agent context. */
export function compactChat(messages: ChatMessage[], opts: CompactChatOptions = {}): CompactChatResult {
  const limit = opts.limit ?? 20;
  const maxLen = opts.maxTextLength ?? 140;
  const minCluster = opts.minClusterSize ?? 3;
  const topicOf = opts.topicOf ?? defaultTopic;
  const tokensBefore = estimateTokens(messages);

  // 1. dedupe (keep first occurrence position, count repeats)
  type Item = { msg: ChatMessage; count: number; users: Set<string>; order: number };
  const items: Item[] = [];
  if (opts.dedupe === false) {
    messages.forEach((m, i) => items.push({ msg: m, count: 1, users: new Set([m.user]), order: i }));
  } else {
    const seen = new Map<string, Item>();
    messages.forEach((m, i) => {
      const key = normalizeText(m.text) || m.text;
      const it = seen.get(key);
      if (it) {
        it.count++;
        it.users.add(m.user);
        it.order = i;
      } else {
        const n = { msg: m, count: 1, users: new Set([m.user]), order: i };
        seen.set(key, n);
        items.push(n);
      }
    });
  }

  // 2. cluster by topic
  let entries: (ChatEntry & { order: number })[] = [];
  const clustered = new Set<Item>();
  if (opts.cluster !== false) {
    const byTopic = new Map<string, Item[]>();
    for (const it of items) {
      const t = topicOf(it.msg);
      if (!t) continue;
      const arr = byTopic.get(t) ?? [];
      arr.push(it);
      byTopic.set(t, arr);
    }
    for (const [topic, arr] of byTopic) {
      if (arr.length < minCluster) continue;
      const last = arr[arr.length - 1]!;
      const users = new Set<string>();
      let count = 0;
      for (const it of arr) {
        clustered.add(it);
        count += it.count;
        it.users.forEach((u) => users.add(u));
      }
      entries.push({
        kind: "cluster",
        text: clip(last.msg.text, maxLen),
        user: last.msg.user,
        count,
        users: [...users].slice(0, 5),
        topic,
        order: Math.max(...arr.map((a) => a.order)),
      });
    }
  }
  for (const it of items) {
    if (clustered.has(it)) continue;
    entries.push({ kind: "message", text: clip(it.msg.text, maxLen), user: it.msg.user, count: it.count, order: it.order });
  }

  // 3. order chronologically, limit: prefer weight (count) then recency
  entries.sort((a, b) => a.order - b.order);
  if (entries.length > limit) {
    const keep = new Set(
      [...entries].sort((a, b) => b.count - a.count || b.order - a.order).slice(0, limit),
    );
    entries = entries.filter((e) => keep.has(e));
  }
  const out: ChatEntry[] = entries.map(({ order: _o, ...e }) => e);
  const represented = out.reduce((n, e) => n + e.count, 0);
  return {
    entries: out,
    totalMessages: messages.length,
    droppedMessages: messages.length - represented,
    tokensBefore,
    tokensAfter: estimateTokens(out),
  };
}
