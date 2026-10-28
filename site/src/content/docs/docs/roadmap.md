---
title: "Roadmap"
description: "Koinonia delivery phases 0 to 7 from the project plan, with the actual state of each."
sidebar:
  order: 21
---

Phases come from `PLANO.md`. Status is checked against the repository.

| Phase | Goal | Status |
| --- | --- | --- |
| 0 | **Risk spikes**: frame rate in a background tab, AAC through WebCodecs | In progress |
| 1 | **End-to-end spike**: camera → WebCodecs → Zig → Twitch | In progress (both ends have code; live verification pending) |
| 2 | **YouTube in parallel** over RTMPS; chat from both platforms | In progress (daemon fan-out and chat connectors exist; real YouTube verification pending) |
| 3 | **Co-pilot WebMCP tools** | In progress (14 tools registered with tests; moderation behind human approval) |
| 4 | **Clipper** with circular buffer | Built (daemon ring and mark/export tools exist; unverified on a real stream) |
| 5 | **Data panel**: SSE/WebSocket, `query_window`, `set_alert`, stream health | In progress (metrics store and tools exist; panel UI pending) |
| 6 | **Token-economy agent** | Built (consume and spend toolkits and the agents runtime; not yet run on a real stream) |
| 7 | **Docs, CI, release** | In progress (this site, QA harness and desktop app exist; tagged release pending) |
| 8 | **Design system and the two views** (Foco and Painel) | In progress (both views exist in the studio UI) |
| 9 | **Unified chat connectors** (Twitch, YouTube) | Built (code exists; live verification pending) |
| 10 | **Vertical clip pipeline** with captions and publishing | Planned |
| 11 | **Automatic post-live**: summary, chapters, title, thumbnail, report | Planned |
| 12 | **Onboarding and interaction suggestions** | Planned |

## Market pains and what answers them

All rows are plans. Nothing below is shipped.

| Pain | Planned answer |
| --- | --- |
| Finding moments without rewatching VODs | Live clipper using chat, audio and transcript |
| Vertical 9:16 clips with captions | Vertical clip pipeline and publishing (Shorts, TikTok, Reels) |
| Chat and moderation on your own | Moderator with human approval, plus unified chat |
| Several platforms | Fan-out in the daemon (Twitch, YouTube; Kick and TikTok Live later) |
| Hard setup | Onboarding in minutes, in the browser |
| Work after the live | Summary, chapters, suggested title and thumbnail, report |
| Ideas for interaction | The agent suggests polls and challenges from chat |
| Unpredictable cost | Monthly budget and a spend panel (token agent) |

## Why this order

Phase 0 retires the two risks that could invalidate the architecture: a browser tab may throttle timers and rendering when hidden, and AAC support in WebCodecs varies by browser. If either is a blocker, the design adapts before more code depends on it.

## Not planned

- A native desktop capture app. (The [desktop app](../desktop/) only launches the daemon and an app window; capture and encoding stay in the browser.)
- Server-side transcoding.
- Replacing OBS plugin ecosystems.
