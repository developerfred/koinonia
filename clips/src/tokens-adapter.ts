// Only file in this package that imports the sibling @koinonia/tokens source.
import { compactChat, estimateTokens } from "../../tokens/src/index.js";
import type { Compactor } from "./report.js";

/** Chat compaction via tokens/compactChat (dedupe + topic clustering) and its token estimator. */
export function tokensCompactor(): Compactor {
  return {
    estimate: (t) => estimateTokens(t),
    chat(messages, limit) {
      const r = compactChat(messages.map((m) => ({ user: m.user, text: m.text, ts: m.tMs })), { limit });
      const text = r.entries.map((e) => (e.count > 1 ? `${e.text} x${e.count}${e.kind === "cluster" ? ` (${e.users?.length ?? "?"} users)` : ""}` : e.text)).join("\n");
      return { text, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter };
    },
  };
}
