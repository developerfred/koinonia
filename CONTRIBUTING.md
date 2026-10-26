# Contributing to Koinonia

Thanks for helping. Koinonia is MIT-licensed and in an early, fast-moving stage. Read `PLANO.md` for the design and the full docs at https://developerfred.github.io/koinonia/docs/.

## Layout

| Directory | What | Stack |
| --- | --- | --- |
| `daemon/` | `koinonia-d`, receives encoded frames, outputs RTMPS and MPEG-TS | Zig 0.17 |
| `studio/` | Browser studio | TypeScript, Vite, Vitest |
| `tokens/` | Token-saving toolkit | TypeScript, Vitest |
| `site/` | Docs and landing page | Astro, Starlight |

## Workflow

1. Open an issue before large changes.
2. Keep pull requests small and focused, with tests where the area has tests.
3. Run the checks for the part you touched:
   - `studio/` and `tokens/`: `npm run typecheck && npm test`
   - `daemon/`: `zig build test`
   - `site/`: `npm run build && npm run check:links`
4. Do not describe planned work as built, in code comments or docs. The status labels are Built, In progress, Planned.

## Where help is most useful

- Phase 0 spikes: measure background-tab frame rate and WebCodecs AAC support, and report numbers.
- The daemon: WebSocket server, frame decoder, FLV muxer.
- Reviewing the WebMCP tool contract (schemas, naming, token cost).
- Accessibility and UX review against the Foco and Painel principles.

## Security

Never commit stream keys or tokens. Report vulnerabilities privately; see `SECURITY.md`.

By contributing you agree your work is licensed under the MIT license.
