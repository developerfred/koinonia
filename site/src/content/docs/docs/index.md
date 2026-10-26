---
title: "Koinonia documentation"
description: "What Koinonia is, how it fits together, and what exists today. An open-source browser streaming studio with a Zig daemon, controlled by agents over WebMCP."
sidebar:
  order: 1
---

**Koinonia** (κοινωνία, Greek for "sharing") is an open-source streaming system for Twitch and YouTube that does not use OBS. The browser is the studio. A small Zig daemon does the plumbing. AI agents run the show through [WebMCP](./concepts/webmcp/) tools that the studio page registers.

:::caution[Pre-alpha]
Koinonia is under construction. This documentation describes the design from `PLANO.md` and marks every component as **Built**, **In progress** or **Planned**. See the [status matrix](./status/) before you rely on anything.
:::

## The idea in four lines

1. The browser captures camera, microphone and screen, composes scenes in a Worker with `OffscreenCanvas`, and encodes H.264/AAC with WebCodecs (hardware when available).
2. Encoded chunks go over a WebSocket to the daemon `koinonia-d`. No re-encode.
3. The daemon muxes FLV and pushes RTMPS to Twitch and YouTube in parallel, and MPEG-TS into a circular buffer for the clipper.
4. The studio page exposes tools through `navigator.modelContext`. An agent reads chat, switches scenes, opens polls and exports clips. A token-economy layer keeps that cheap.

## Where to go next

| If you want to... | Read |
| --- | --- |
| Know what works today | [Status](./status/) |
| Run something | [Quickstart](./quickstart/) |
| Understand the pieces | [Architecture](./concepts/architecture/) |
| Call the tools | [Tool reference](./reference/tools/) |
| Keep the agent cheap | [Token economy](./guides/token-economy/) |
| Point your own agent at these docs | [Docs for agents](./guides/agents/) |
| Learn the Foco and Painel views | [Foco and Painel](./concepts/views/) |
| Check UX and accessibility commitments | [UX and accessibility](./guides/ux-accessibility/) |
| Trust it with your stream key | [Security model](./security/) |
| See what is coming | [Roadmap](./roadmap/) |

## Principles

- **No OBS, no virtual camera.** Everything the viewer sees is rendered by the page.
- **Encode once.** The browser encodes; the daemon never re-encodes.
- **Agents are first-class operators**, and humans stay in the loop for anything irreversible.
- **Tokens are a budget.** Tools return deltas and compact payloads, not snapshots.
- **Be honest about status.** If it is not built, the docs say so.
