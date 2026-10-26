---
title: "Token-economy agent"
description: "How Koinonia reduces the tokens an agent consumes from tools and spends on LLM calls: deltas, compact chat, model routing, prompt caching, budgets."
---

An agent that watches a live chat all day can burn a budget quickly. The token-economy design attacks cost from both ends.

| Direction | Meaning | Status |
| --- | --- | --- |
| **Consume** | What enters the agent context (tool output) | Toolkit **built** and used by the chat tool |
| **Spend** | What is sent to the LLM (calls) | Toolkit **built** (router, cache planner, budget, cache, batcher, ledger); not yet wired into a live agent loop |

## Consume: make tool output small

### 1. Deltas by cursor, never full state
`get_chat(since_cursor)` returns only messages after the cursor. An idle poll is a few tokens. See [cursors and deltas](../../concepts/cursors-and-deltas/).

### 2. Summarized chat
`compactChat` dedupes repeats ("POG" x 14 becomes one entry with a count), clusters by topic, and caps the number of entries.

```ts
import { compactChat } from '@koinonia/tokens';

const r = compactChat(rawMessages, { limit: 20 });
// r.tokensBefore, r.tokensAfter tell you what you saved on this call
```

### 3. Optional fields and verbosity
`trimOutput` with `fields` or `verbosity: 'minimal'` keeps only what the agent asked for. Defaults are minimal.

### 4. Register tools only when relevant
Fewer tool definitions means a shorter prompt prefix on every call. Clipper tools are only registered when the buffer is running, for example.

## Spend: make LLM calls cheap (toolkit built, wiring pending)

- **Model routing.** Simple tasks (acknowledge a raid, switch scene on a keyword) go to a small model; complex ones (summarize the last hour, draft a recap) to a large one.
- **Prompt caching** for stable prefixes: system prompt, tool definitions, the house rules of the stream. Keep the volatile part (chat delta) at the end.
- **Budgets** per session and per hour with warnings and graceful degradation: when the budget runs low, route down, batch more, poll less.
- **Semantic cache** for repeated questions in chat.
- **Batching** events into windows instead of one call per event.
- **Rolling summary** instead of raw history. `RollingSummary` is built.
- **Metrics:** tokens per tool and per task and estimated savings via the usage ledger; exposing them to the agent as `get_token_report` and in the data panel is planned.

## A worked loop

```text
every 10 s:
  r = get_chat(since_cursor=c, limit=30)         # delta, deduped
  c = r.c
  if r.m is empty: sleep                          # costs ~15 tokens
  else: route_model(task="chat triage") -> small model
        small model decides: ignore | reply | escalate
        escalate -> large model with rolling summary + r.m
```

Every piece in this pseudocode exists as a library in `@koinonia/tokens`; assembling them into the running agent loop is the pending part.

:::note[Estimates]
`estimateTokens` is `chars / 4`. Savings quoted by the toolkit are estimates, good for relative comparison, not billing.
:::
