---
title: "Implementation status"
description: "What is built, in progress and planned in Koinonia today, verified against the repository."
sidebar:
  order: 2
---

This page is the honest ledger. It was written by reading the repository directories `daemon/`, `studio/` and `tokens/`, not the plan.

| Component | Status | Where | Notes |
| --- | --- | --- | --- |
| `@koinonia/tokens` | Built | `tokens/` | Consume side (deltas, chat compaction, trimming, rolling summary) and spend side (model router, prompt-cache planner, budgets, response cache, batcher, usage ledger), with unit tests. Not yet wired into a live agent loop. |
| Chat ring buffer | Built | `studio/src/chat/ring.ts` | Cursor-addressed, deduplicating, reports lost messages. |
| Metrics store and alerts | Built | `studio/src/metrics.ts` | Windowed aggregates and edge-triggered alerts. |
| WebMCP tool layer | In progress | `studio/src/tools/` | 14 tools registered via `navigator.modelContext` (polyfill fallback), with tests. Polls, pins, going live and clips depend on connectors and the daemon. No human-confirmation gate yet. |
| Browser studio | In progress | `studio/` | Compositor Worker, scene model, transport, and a Foco/Painel UI with tests. The studio frame codec still targets an earlier draft of the wire protocol. Not verified end to end. |
| Zig daemon `koinonia-d` | In progress | `daemon/` | WebSocket ingest, frame parser, FLV and RTMPS publisher, MPEG-TS ring, fan-out and config, plus a written v1 protocol. Not verified against Twitch or YouTube. |
| Twitch and YouTube chat connectors | Planned | | Phases 2 and 9. |
| Data panel UI | Planned | | Phase 5. The metrics store and `query_window` tool exist. |
| Human confirmation gate | Planned | | Required for `ban_user` and, by default, going live. Not implemented. |

:::note
The repository is moving quickly and this page can lag behind it. When in doubt, the source in the repository wins; open an issue if this page is wrong.
:::

## What the docs site itself ships

Independent of the product, this site provides `/llms.txt`, `/llms-full.txt`, a `.md` twin of every page, JSON-LD, a sitemap and [WebMCP tools of its own](../reference/docs-site-tools/).
