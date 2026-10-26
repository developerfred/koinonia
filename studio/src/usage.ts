import { UsageLedger } from "../../tokens/src/ledger";
import { budgetState as budgetStateFor } from "./ui/viewstate";

export interface UsageEvent {
  agent: string; model: string; task?: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
}

/** Billable-equivalent total, same weighting as agents/src/economist.ts (cache reads ~10%). */
export const totalTokens = (u: UsageEvent) =>
  u.inputTokens + u.outputTokens + (u.cacheWriteTokens ?? 0) + Math.round((u.cacheReadTokens ?? 0) * 0.1);

export class TokenAccounting {
  readonly ledger = new UsageLedger();
  events = 0;
  budget = 200_000;
  total = 0;
  record(u: UsageEvent): number {
    const n = totalTokens(u);
    this.ledger.record({ tool: u.agent, task: u.task, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0 });
    this.events++; this.total += n;
    return n;
  }
  /** Compact report for agents: numbers only, no per-event history. */
  report(verbosity: "min" | "full" = "min") {
    const r = this.ledger.report();
    const st = budgetStateFor(this.total, this.budget);
    const base = { spent: this.total, budget: this.budget, ratio: st.ratio, level: st.level, calls: this.events, savingsRatio: Math.round(r.savingsRatio * 1000) / 1000 };
    if (verbosity === "min") return base;
    return { ...base, byAgent: r.byTool, byModel: r.byModel, savingsBySource: r.savingsBySource };
  }
}
