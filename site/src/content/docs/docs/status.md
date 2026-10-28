---
title: "Implementation status"
description: "What is built, in progress and planned in Koinonia today, verified against the repository."
sidebar:
  order: 2
---

This page is the honest ledger. It was written by reading the repository directories `daemon/`, `studio/` and `tokens/`, not the plan.

| Component | Status | Where | Notes |
| --- | --- | --- | --- |
| `@koinonia/tokens` | Built | `tokens/` | Consume side (deltas, chat compaction, trimming, rolling summary) and spend side (model router, prompt-cache planner, budgets, response cache, batcher, usage ledger), with unit tests. |
| Chat ring buffer | Built | `studio/src/chat/ring.ts` | Cursor-addressed, deduplicating, reports lost messages. |
| Metrics store and alerts | Built | `studio/src/metrics.ts` | Windowed aggregates and edge-triggered alerts. |
| Desktop app | Built | `desktop/` | One native Zig binary that runs the daemon, serves the studio and opens it as an app window. Built and tested on macOS arm64 only; no downloads yet. See [Desktop app](../desktop/). |
| Agents runtime | Built | `agents/` | Orchestrator, five agents, human-approval gate, token economist. Tests included; not yet run against a real stream. |
| Twitch and YouTube chat connectors | Built | `studio/src/` | Code exists. Not verified against real Twitch or YouTube chat beyond the first test live. |
| Clips | Built | `daemon/`, `studio/src/tools/` | MPEG-TS ring in the daemon, mark and export tools. Vertical captioned clips and publishing are planned. |
| QA harness | Built | `qa/` | One command runs unit, contract, integration (fake RTMP sinks), end-to-end, fuzz, property, security, token-economy and site gates. |
| WebMCP tool layer | In progress | `studio/src/tools/` | 14 tools registered via `navigator.modelContext` (polyfill fallback), with tests. Moderation tools queue for human approval. A confirmation step for going live is still a design commitment. |
| Browser studio | In progress | `studio/` | Compositor Worker, scene model, transport, and a Foco/Painel UI with tests. Not verified against real Twitch or YouTube. |
| Zig daemon `koinonia-d` | In progress | `daemon/` | WebSocket ingest, frame parser, FLV and RTMPS publisher, MPEG-TS ring, fan-out and config, plus a written v1 protocol. Not verified against real Twitch or YouTube. |
| Data panel UI | Planned | | Phase 5. The metrics store and `query_window` tool exist. |

Nothing has been verified against real Twitch or YouTube yet, apart from the maintainer's first test live. Treat "Built" as "the code exists and has tests", not "proven on air".

:::note
The repository is moving quickly and this page can lag behind it. When in doubt, the source in the repository wins; open an issue if this page is wrong.
:::

## What the docs site itself ships

Independent of the product, this site provides `/llms.txt`, `/llms-full.txt`, a `.md` twin of every page, JSON-LD, a sitemap and [WebMCP tools of its own](../reference/docs-site-tools/).
