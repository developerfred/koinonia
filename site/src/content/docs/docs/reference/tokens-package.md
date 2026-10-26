---
title: "@koinonia/tokens"
description: "API reference for the implemented token-saving toolkit: DeltaTracker, compactChat, trimOutput, RollingSummary and estimateTokens."
---

`@koinonia/tokens` (in `tokens/`) is the **consume-side** toolkit: helpers that make tool output small before it reaches the model. It is TypeScript source with no runtime dependencies.

:::note[Status]
Everything below is **built** and unit-tested. Wiring it into a running agent loop and the data panel is **pending**.
:::

## `estimateTokens(input)`

Cheap estimate: `ceil(characters / 4)` of the string or its JSON. Swap in a real tokenizer when exactness matters.

## `compactChat(messages, options?)`

Dedupe, cluster, limit. Input messages are `{ user, text, id?, ts?, platform? }`.

| Option | Default | Effect |
| --- | --- | --- |
| `limit` | 20 | Max entries returned; heaviest and most recent kept. |
| `dedupe` | true | Fold identical (normalized) messages into one with a count. |
| `cluster` | true | Group messages sharing a topic key into one cluster entry. |
| `minClusterSize` | 3 | Smallest group emitted as a cluster. |
| `topicOf` | first significant word | Custom topic key; return `undefined` for none. |
| `maxTextLength` | 140 | Truncate sample text. |

Returns `{ entries, totalMessages, droppedMessages, tokensBefore, tokensAfter }`, so the saving is measurable on every call. Normalization lowercases, strips accents and punctuation, and collapses elongated letters ("POOOG" equals "POG").

## `DeltaTracker`

```ts
const tracker = new DeltaTracker<Item>({ idOf: (i) => i.id, trackRemovals: true });
const r1 = tracker.respond(items);            // full state, new cursor
const r2 = tracker.respond(items, r1.cursor); // only added or changed; { unchanged: true } if none
```

An unknown or expired cursor returns full state. Snapshots are capped (`maxCursors`, default 32). For append-only feeds use `sliceAfterCursor(all, cursor)`.

## `trimOutput(data, options?)`

Whitelist fields (dotted paths such as `user.name`) and/or choose a verbosity (`minimal`, `normal`, `full`). Empty values are dropped by default and long strings are truncated (80, 400 or unlimited characters by verbosity).

## `RollingSummary`

Keeps `summary + recent turns` instead of raw history. When the verbatim tail grows beyond `maxTailTokens` (default 2000) and holds more than `keepRecent` turns (default 6), older turns are folded into the summary by a pluggable `Summarizer`. `extractiveSummarizer()` is a non-LLM fallback.

## Spend side

| Export | Purpose |
| --- | --- |
| `ModelRouter` | Maps a task (`RouteRequest`) to a model tier (small, medium, large) and returns a `RouteDecision`. Tiers and prices come from `models.ts` (`DEFAULT_PRICES`, `lowerTier`). |
| `planCache` | Orders prompt blocks (system, tools, stable rules, then volatile content) and places cache-control breakpoints so stable prefixes are reusable. |
| `BudgetTracker` | Per-session and per-period token or cost limits with a `BudgetStatus`, used to degrade gracefully (route down, batch more, poll less). |
| `ResponseCache` | Cache for repeated questions keyed by `semanticKey` (a normalized form of the query), with hit statistics. |
| `EventBatcher` | Collects events into windows so one model call handles many events. |
| `UsageLedger` | Records usage and estimated savings per tool or task and produces a `LedgerReport`. |

See the source in `tokens/src/` for exact signatures; they may still change before the first release.
