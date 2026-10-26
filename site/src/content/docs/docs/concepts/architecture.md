---
title: "Architecture"
description: "How the browser studio, the Zig daemon, WebMCP tools and the token-economy layer fit together. Includes the data path from camera to RTMPS."
---

Koinonia has three runtime pieces and one cross-cutting layer.

<figure class="arch" aria-labelledby="arch-cap">
<svg viewBox="0 0 960 420" role="img" aria-label="Architecture: browser studio (capture, Worker compositor, WebCodecs) sends encoded chunks over WebSocket to the Zig daemon, which muxes FLV to RTMPS for Twitch and YouTube and MPEG-TS into a clip buffer. An agent controls the studio through WebMCP.">
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="20" y="30" width="520" height="250" rx="10" stroke-dasharray="4 4" opacity=".5"/>
    <rect x="40" y="70" width="130" height="64" rx="6"/>
    <rect x="200" y="70" width="150" height="64" rx="6"/>
    <rect x="380" y="70" width="140" height="64" rx="6"/>
    <rect x="40" y="170" width="480" height="84" rx="6" stroke-dasharray="2 3"/>
    <rect x="600" y="70" width="170" height="64" rx="6"/>
    <rect x="600" y="170" width="170" height="64" rx="6"/>
    <rect x="800" y="40" width="140" height="48" rx="6"/>
    <rect x="800" y="112" width="140" height="48" rx="6"/>
    <rect x="800" y="184" width="140" height="48" rx="6"/>
    <rect x="40" y="320" width="300" height="70" rx="6"/>
    <rect x="620" y="320" width="300" height="70" rx="6"/>
    <path d="M170 102H200M350 102H380M520 102H600" marker-end="url(#ah)"/>
    <path d="M770 102H800M770 102 785 64H800M770 102 785 136H800M770 202H800" marker-end="url(#ah)" stroke-width="1.2"/>
    <path d="M190 390H620" marker-end="url(#ah)" opacity="0"/>
    <path d="M190 254V320" marker-end="url(#ah)"/>
    <path d="M770 102V170" marker-end="url(#ah)" opacity="0"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace,monospace" font-size="13">
    <text x="36" y="22" font-size="12" opacity=".7">BROWSER (studio)</text>
    <text x="55" y="97">getUserMedia /</text><text x="55" y="115">getDisplayMedia</text>
    <text x="215" y="97">Worker +</text><text x="215" y="115">OffscreenCanvas</text>
    <text x="395" y="97">WebCodecs</text><text x="395" y="115">H.264 / AAC</text>
    <text x="56" y="205">navigator.modelContext  (WebMCP)</text>
    <text x="56" y="226" opacity=".75">get_chat · switch_scene · export_clip …</text>
    <text x="615" y="97">koinonia-d</text><text x="615" y="115">WebSocket in, no reencode</text>
    <text x="615" y="197">MPEG-TS ring</text><text x="615" y="215">clipper buffer</text>
    <text x="815" y="69">RTMPS Twitch</text>
    <text x="815" y="141">RTMPS YouTube</text>
    <text x="815" y="213">clip export</text>
    <text x="56" y="350">Agent (any MCP-capable client)</text>
    <text x="56" y="370" opacity=".75">calls tools, reads cursors</text>
    <text x="636" y="350">Token-economy layer</text>
    <text x="636" y="370" opacity=".75">deltas · routing · budgets</text>
    <text x="560" y="60" font-size="12" opacity=".7">DAEMON (Zig)</text>
    <text x="560" y="94" font-size="11" opacity=".7">chunks</text>
  </g>
</svg>
<figcaption id="arch-cap">Fig. Browser studio, Zig daemon, agent. Status: both ends have code but are not verified end to end; see <a href="../../status/">status</a>.</figcaption>
</figure>

**Text version of the diagram.** Browser: capture (`getUserMedia`, `getDisplayMedia`) → compositor Worker (`OffscreenCanvas`) → WebCodecs encoder (H.264, AAC). Encoded chunks → WebSocket → daemon `koinonia-d`. Daemon: FLV mux → RTMPS to Twitch and YouTube in parallel; MPEG-TS → circular clip buffer → clip export. Control plane: an agent calls WebMCP tools registered by the studio page via `navigator.modelContext`; a token-economy layer shapes what flows in and out of the agent.

## Browser: the studio

- **Capture** with `getUserMedia` and `getDisplayMedia`.
- **Scenes** are composed in a Worker on an `OffscreenCanvas`, so the main thread stays free and a busy UI does not drop frames.
- **Encoding** uses WebCodecs (`VideoEncoder`, `AudioEncoder`) for H.264 and AAC, on hardware when the browser provides it.
- **Open risks**, tracked as phase 0 spikes: frame rate when the tab is in the background, and AAC availability through WebCodecs.

## Daemon: koinonia-d

A small Zig program. It receives already-encoded chunks over a WebSocket using the [wire protocol](../../reference/daemon-protocol/), then:

- packs them into **FLV** and sends **RTMPS** to Twitch and YouTube concurrently;
- writes **MPEG-TS** into a circular buffer used by the clipper.

It never decodes or re-encodes. That is the whole point: no GPU work, tiny CPU footprint.

## Control plane: WebMCP

The page registers tools with `navigator.modelContext`. An agent (in the browser, a browser extension, or an MCP bridge) calls them. A tool call resolves to a single Promise, so "streaming" is modeled as a cursor plus live state in the page: see [cursors and deltas](../cursors-and-deltas/).

## Token-economy layer

Cross-cutting. Keeps what the agent **consumes** (tool output) and **spends** (LLM calls) small. See the [guide](../../guides/token-economy/).
