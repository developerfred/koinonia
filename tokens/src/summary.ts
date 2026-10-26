import { estimateTokens } from "./estimate.js";

export interface Turn {
  role: "user" | "assistant" | "tool";
  content: string;
}

/** Implement with an LLM call (use the small model tier) or any heuristic. */
export interface Summarizer {
  summarize(previousSummary: string, turns: Turn[]): Promise<string> | string;
}

export interface RollingSummaryOptions {
  summarizer: Summarizer;
  /** Keep this many recent turns verbatim. Default 6. */
  keepRecent?: number;
  /** Summarize when the verbatim tail exceeds this many estimated tokens. Default 2000. */
  maxTailTokens?: number;
}

/** Keeps `summary + recent turns` instead of raw history. */
export class RollingSummary {
  summary = "";
  private tail: Turn[] = [];
  constructor(private o: RollingSummaryOptions) {}

  async add(turn: Turn): Promise<void> {
    this.tail.push(turn);
    const keep = this.o.keepRecent ?? 6;
    const max = this.o.maxTailTokens ?? 2000;
    if (this.tail.length > keep && estimateTokens(this.tail) > max) {
      const old = this.tail.slice(0, this.tail.length - keep);
      this.tail = this.tail.slice(-keep);
      this.summary = await this.o.summarizer.summarize(this.summary, old);
    }
  }

  /** Context to send to the model. */
  context(): { summary: string; recent: Turn[] } {
    return { summary: this.summary, recent: [...this.tail] };
  }

  tokens(): number {
    return estimateTokens(this.summary) + estimateTokens(this.tail);
  }
}

/** Trivial non-LLM summarizer: keeps first sentence of each turn, bounded length. */
export function extractiveSummarizer(maxChars = 1200): Summarizer {
  return {
    summarize(prev, turns) {
      const lines = turns.map((t) => `${t.role}: ${(t.content.split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 120)}`);
      const all = (prev ? prev + "\n" : "") + lines.join("\n");
      return all.length > maxChars ? all.slice(all.length - maxChars) : all;
    },
  };
}
