---
title: "Contributing"
description: "How to contribute to Koinonia: layout of the repository, how to run each part, and what is most useful right now."
sidebar:
  order: 22
---

Koinonia is MIT-licensed and developed in the open at [github.com/developerfred/koinonia](https://github.com/developerfred/koinonia). The root `CONTRIBUTING.md` is canonical; this is the short version.

## Layout

| Directory | What | Stack |
| --- | --- | --- |
| `daemon/` | `koinonia-d` | Zig 0.17 |
| `studio/` | Browser studio | TypeScript, Vite, Vitest |
| `tokens/` | Token toolkit | TypeScript, Vitest |
| `site/` | This documentation | Astro, Starlight |

## Where help is most useful

1. The phase 0 spikes: measure background-tab frame rate and WebCodecs AAC on your browsers and report numbers.
2. The daemon: WebSocket server, frame decoder, FLV muxer.
3. Review of the [tool contract](../reference/tools/): schemas, naming, token cost.
4. Docs corrections, especially where status is stale.

## Workflow

- Open an issue before large changes.
- Keep pull requests small and focused, with tests where the area has tests.
- Run `npm test` / `npm run typecheck` in `studio/` and `tokens/`, and `npm run build` in `site/`.
- Docs must not describe planned work as built.
- Be kind; see `CODE_OF_CONDUCT.md`.
