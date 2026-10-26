import { systemClock, type Clock } from "./estimate.js";
import { normalizeText } from "./chat.js";

export interface ResponseCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  clock?: Clock;
  /** Custom key normalizer. Default: lowercase, strip accents/punctuation, drop stopwords, sort words. */
  normalize?: (query: string) => string;
}

const STOP = new Set(["the", "a", "an", "please", "pls", "me", "can", "you", "could", "do", "is", "por", "favor", "o", "a", "um", "uma", "voce", "pode"]);

export function semanticKey(q: string): string {
  const words = normalizeText(q).split(" ").filter((w) => w && !STOP.has(w));
  return [...new Set(words)].sort().join(" ");
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}

/** Normalized-key LRU with TTL. Near-duplicate phrasings collapse onto one key. */
export class ResponseCache<V = string> {
  private map = new Map<string, { v: V; exp: number }>();
  private hits = 0;
  private misses = 0;
  private clock: Clock;
  private norm: (q: string) => string;
  constructor(private o: ResponseCacheOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.norm = o.normalize ?? semanticKey;
  }

  /** `scope` partitions keys (e.g. model or tool name). */
  private key(q: string, scope = ""): string {
    return scope + "\u0000" + this.norm(q);
  }

  get(query: string, scope?: string): V | undefined {
    const k = this.key(query, scope);
    const e = this.map.get(k);
    if (!e || e.exp <= this.clock()) {
      if (e) this.map.delete(k);
      this.misses++;
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e);
    this.hits++;
    return e.v;
  }

  set(query: string, value: V, scope?: string, ttlMs?: number): void {
    const k = this.key(query, scope);
    this.map.delete(k);
    this.map.set(k, { v: value, exp: this.clock() + (ttlMs ?? this.o.ttlMs ?? 300_000) });
    const max = this.o.maxEntries ?? 500;
    while (this.map.size > max) this.map.delete(this.map.keys().next().value as string);
  }

  /** Return the cached value or compute and store it. `onHit` lets you log savings. */
  async wrap(query: string, compute: () => Promise<V> | V, opts: { scope?: string; ttlMs?: number; onHit?: (v: V) => void } = {}): Promise<V> {
    const hit = this.get(query, opts.scope);
    if (hit !== undefined) {
      opts.onHit?.(hit);
      return hit;
    }
    const v = await compute();
    this.set(query, v, opts.scope, opts.ttlMs);
    return v;
  }

  clear(): void {
    this.map.clear();
  }

  stats(): CacheStats {
    const t = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, size: this.map.size, hitRate: t ? this.hits / t : 0 };
  }
}
