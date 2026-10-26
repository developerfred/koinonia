# @koinonia/tokens

Token-saving toolkit for the Koinonia agent (see `PLANO.md`, "Agente de economia de tokens").
Zero runtime dependencies. TypeScript, tested with vitest.

```
npm install && npm run typecheck && npm test
```

Everything is exported from `src/index.ts`. Token counts are estimated (~4 chars/token, `estimateTokens`).
Prices in `DEFAULT_PRICES` are placeholders: pass real ones via `UsageLedger({ prices })`.

## Consume side (what enters the agent context)

```ts
import { compactChat, DeltaTracker, sliceAfterCursor, trimOutput, RollingSummary, extractiveSummarizer } from "@koinonia/tokens";

// chat: dedupe spam, cluster topics, cap the list
const { entries, tokensBefore, tokensAfter } = compactChat(messages, { limit: 15 });

// delta: only what changed since the cursor
const tracker = new DeltaTracker<Viewer>({ idOf: (v) => v.id, trackRemovals: true });
const r1 = tracker.respond(viewers);              // full state, returns cursor
const r2 = tracker.respond(viewers, r1.cursor);   // only added/changed (+ removed ids)
sliceAfterCursor(allEvents, lastCursor);          // append-only feeds

// fields / verbosity
trimOutput(stats, { fields: ["id", "user.name"] });
trimOutput(stats, { verbosity: "minimal", presets: { minimal: ["id", "title"] } });

// rolling summary (plug a small-model summarizer in)
const mem = new RollingSummary({ summarizer: extractiveSummarizer(), keepRecent: 6 });
await mem.add({ role: "user", content: "..." });
const { summary, recent } = mem.context();
```

## Spend side (what goes to the LLM)

```ts
import { ModelRouter, planCache, BudgetTracker, ResponseCache, EventBatcher, UsageLedger } from "@koinonia/tokens";

const budget = new BudgetTracker({ perSession: 500_000, perHour: 150_000, onStateChange: (s) => panel.alert(s.message) });
const router = new ModelRouter({ taskTiers: { "stream-plan": "large", "chat-reply": "small" } });
const cache = new ResponseCache<string>({ ttlMs: 5 * 60_000, maxEntries: 500 });
const ledger = new UsageLedger();

async function ask(text: string, task: string) {
  const status = budget.status();
  if (status.state === "stop") return "(budget exhausted)";
  const { model, tier } = router.route({ text, task, degradeSteps: status.degradeSteps });

  return cache.wrap(text, async () => {
    const plan = planCache({
      tools,                                              // sorted, last one gets cache_control
      system: [
        { text: RULES, stability: "static" },             // cached first
        { text: streamContext, stability: "session" },
        { text: `now: ${new Date().toISOString()}`, stability: "volatile" }, // never cached, placed last
      ],
      messages: history,                                  // history prefix cached
    });
    const res = await anthropic.messages.create({ model, max_tokens: 512, ...plan });
    ledger.record({ tool: "agent", task, model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
                    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0 });
    ledger.routing({ task, model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
    budget.record(res.usage.input_tokens + res.usage.output_tokens);
    return res.content[0].type === "text" ? res.content[0].text : "";
  }, { scope: model, onHit: () => ledger.saving({ source: "response-cache", task, tokensSaved: 800, model }) });
}

// batch bursts of events into one LLM call
const batcher = new EventBatcher<ChatEvent>({ windowMs: 3000, maxItems: 40, onFlush: (batch) => ask(summarize(batch), "chat-reply") });
batcher.add(event);

ledger.compaction(tokensBefore, tokensAfter, { tool: "chat.read" });
console.log(ledger.report()); // totals, byTool, byTask, byModel, savingsBySource, savingsRatio
```

### Defaults worth knowing
- Models: small `claude-haiku-5-5`, medium `claude-sonnet-5-5`, large `claude-opus-5-5` (override with `ModelRouter({ models })`).
- Router order: `hint` > `taskTiers[task]` > heuristic score (length, tools, keywords). Budget `degradeSteps` lowers the tier (floor configurable).
- Budget states: ok < 70% warn < 90% degrade (1 tier down) < 100% stop (2 tiers down / refuse); the worse of session and rolling-hour wins.
- Cache planner: order tools -> system (static, session, volatile) -> messages; max 4 breakpoints; prefixes below `minCacheTokens` (1024) are not marked; `ttl: "1h"` supported.
- `ResponseCache` keys: lowercase, accents/punctuation/stopwords stripped, words deduped and sorted, so rephrasings collide.
