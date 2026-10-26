---
title: "Cursors and deltas"
description: "Why Koinonia tools return only what changed, and how cursor-based chat, metrics and alerts work. Backed by implemented code."
---

A WebMCP call resolves to one Promise. A live stream never ends. The bridge is a **cursor**: an opaque-ish integer the agent passes back to say "give me what is new since here".

## Chat

`ChatBuffer` (in `studio/src/chat/ring.ts`) is a ring of the last N messages (default 500). Each message gets a monotonically increasing id starting at 1, and that id is the cursor.

```ts
const buf = new ChatBuffer(500);
buf.push({ ts: Date.now(), platform: 'twitch', user: 'mika', text: 'POG' });

const first = buf.since(0, { limit: 30 });        // { c: 1, m: [{ u: 'mika', t: 'POG' }] }
const next  = buf.since(first.c, { limit: 30 });  // { c: 1, m: [] }  nothing new
```

Response fields:

| Field | Meaning |
| --- | --- |
| `c` | The next cursor. Always pass it back. |
| `m` | Compact items. `x` is a repeat count when identical texts were folded. |
| `more` | `true` when `limit` cut the page short. Call again immediately. |
| `lost` | Messages that fell off the ring before you read them. |

An empty poll costs a few tokens. That is the design target.

## Metrics and alerts

`MetricsStore` keeps a ring per metric and answers windowed aggregates (`avg`, `min`, `max`, `last`, `count`, `rate`) without ever returning the raw series. Alerts are **edge-triggered**: they fire once when the threshold is crossed and re-arm when the value is back in range. `drainFired()` has delta semantics: each fired alert is returned once.

## Generic deltas

`@koinonia/tokens` exports `DeltaTracker` for non-append-only state (items that change): the server remembers a snapshot per cursor and replies with only added or changed items. An unknown cursor falls back to full state, which is always safe. See the [package reference](../../reference/tokens-package/).
