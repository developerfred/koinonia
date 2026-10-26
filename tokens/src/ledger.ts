import { DEFAULT_PRICES, MODEL_IDS, type ModelPrice } from "./models.js";
import { systemClock, type Clock } from "./estimate.js";

export interface UsageRecord {
  tool?: string;
  task?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens read from prompt cache (billed at cache-read rate). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type SavingSource = "compaction" | "delta" | "response-cache" | "routing" | "prompt-cache" | "batching" | "summary";

export interface SavingRecord {
  source: SavingSource;
  tool?: string;
  task?: string;
  /** Input tokens that did not have to be sent/consumed. */
  tokensSaved: number;
  /** Model whose input price applies (default: the baseline model). */
  model?: string;
  /** Direct USD saving (used by routing/prompt-cache, which are price-based). */
  usdSaved?: number;
}

export interface Bucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  tokensSaved: number;
  usdSaved: number;
}

export interface LedgerReport {
  totals: Bucket;
  byTool: Record<string, Bucket>;
  byTask: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  savingsBySource: Record<string, { tokensSaved: number; usdSaved: number }>;
  /** saved / (spent + saved), by tokens. */
  savingsRatio: number;
}

export interface LedgerOptions {
  prices?: Record<string, ModelPrice>;
  /** Model used to price savings when none is given, and as routing baseline. Default claude-sonnet-5-5. */
  baselineModel?: string;
  clock?: Clock;
}

const empty = (): Bucket => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, tokensSaved: 0, usdSaved: 0 });

export class UsageLedger {
  private prices: Record<string, ModelPrice>;
  private baseline: string;
  private usage: Array<UsageRecord & { t: number }> = [];
  private savings: Array<SavingRecord & { t: number }> = [];
  private clock: Clock;
  constructor(o: LedgerOptions = {}) {
    this.prices = { ...DEFAULT_PRICES, ...o.prices };
    this.baseline = o.baselineModel ?? MODEL_IDS.medium;
    this.clock = o.clock ?? systemClock;
  }

  priceOf(model?: string): ModelPrice {
    return this.prices[model ?? this.baseline] ?? this.prices[this.baseline] ?? { input: 3, output: 15 };
  }

  cost(r: UsageRecord): number {
    const p = this.priceOf(r.model);
    return (
      ((r.inputTokens ?? 0) * p.input +
        (r.outputTokens ?? 0) * p.output +
        (r.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input * 0.1) +
        (r.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input * 1.25)) /
      1e6
    );
  }

  /** Record one LLM call or tool-output consumption. Returns its cost. Also auto-books prompt-cache savings. */
  record(r: UsageRecord): number {
    this.usage.push({ ...r, t: this.clock() });
    if (r.cacheReadTokens) {
      const p = this.priceOf(r.model);
      const usd = (r.cacheReadTokens * (p.input - (p.cacheRead ?? p.input * 0.1))) / 1e6;
      this.savings.push({ source: "prompt-cache", tool: r.tool, task: r.task, tokensSaved: 0, usdSaved: usd, model: r.model, t: this.clock() });
    }
    return this.cost(r);
  }

  /** Book a saving. If only tokensSaved is given, it is priced at the model's input rate. */
  saving(s: SavingRecord): void {
    const usd = s.usdSaved ?? (s.tokensSaved * this.priceOf(s.model).input) / 1e6;
    this.savings.push({ ...s, usdSaved: usd, t: this.clock() });
  }

  /** Convenience: compaction before -> after (token counts). */
  compaction(before: number, after: number, meta: { source?: SavingSource; tool?: string; task?: string } = {}): void {
    if (before > after) this.saving({ source: meta.source ?? "compaction", tool: meta.tool, task: meta.task, tokensSaved: before - after });
  }

  /** Book routing saving: cost at baseline model vs. the model actually used. */
  routing(r: UsageRecord): void {
    const actual = this.cost(r);
    const base = this.cost({ ...r, model: this.baseline });
    if (base > actual) this.saving({ source: "routing", tool: r.tool, task: r.task, tokensSaved: 0, usdSaved: base - actual });
  }

  report(since = 0): LedgerReport {
    const totals = empty();
    const byTool: Record<string, Bucket> = {};
    const byTask: Record<string, Bucket> = {};
    const byModel: Record<string, Bucket> = {};
    const bySource: LedgerReport["savingsBySource"] = {};
    const get = (m: Record<string, Bucket>, k: string) => (m[k] ??= empty());
    const add = (b: Bucket, r: UsageRecord) => {
      b.calls++;
      b.inputTokens += r.inputTokens ?? 0;
      b.outputTokens += r.outputTokens ?? 0;
      b.cacheReadTokens += r.cacheReadTokens ?? 0;
      b.cacheWriteTokens += r.cacheWriteTokens ?? 0;
      b.totalTokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      b.costUsd += this.cost(r);
    };
    for (const r of this.usage) {
      if (r.t < since) continue;
      add(totals, r);
      add(get(byTool, r.tool ?? "(none)"), r);
      add(get(byTask, r.task ?? "(none)"), r);
      add(get(byModel, r.model ?? this.baseline), r);
    }
    for (const s of this.savings) {
      if (s.t < since) continue;
      const usd = s.usdSaved ?? 0;
      totals.tokensSaved += s.tokensSaved;
      totals.usdSaved += usd;
      for (const [m, k] of [[byTool, s.tool], [byTask, s.task]] as const) {
        const b = get(m, k ?? "(none)");
        b.tokensSaved += s.tokensSaved;
        b.usdSaved += usd;
      }
      const src = (bySource[s.source] ??= { tokensSaved: 0, usdSaved: 0 });
      src.tokensSaved += s.tokensSaved;
      src.usdSaved += usd;
    }
    const spent = totals.totalTokens;
    return { totals, byTool, byTask, byModel, savingsBySource: bySource, savingsRatio: spent + totals.tokensSaved ? totals.tokensSaved / (spent + totals.tokensSaved) : 0 };
  }

  /** JSON-safe snapshot for the Koinonia panel. */
  toJSON(): LedgerReport {
    return this.report();
  }
}
