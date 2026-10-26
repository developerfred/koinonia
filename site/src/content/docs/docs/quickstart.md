---
title: "Quickstart"
description: "Clone the repository, run the tests that exist today, and see what the end-to-end flow will look like once the studio and daemon land."
sidebar:
  order: 3
---

:::caution[No verified end-to-end stream yet]
The studio and daemon both have code, but the pipeline has not been verified against Twitch or YouTube. This quickstart runs the parts that have tests and shows the intended flow. Steps marked *Planned* or *Unverified* may not work yet.
:::

## Requirements

- Node.js 20 or newer (the site uses 22)
- Zig 0.17 (only for the daemon scaffold)
- A Chromium-based browser for WebCodecs and, later, WebMCP

## 1. Clone

```sh
git clone https://github.com/developerfred/koinonia.git
cd koinonia
```

## 2. Run the token toolkit tests (Built)

```sh
cd tokens
npm install
npm test
```

## 3. Typecheck and test the studio blocks (Built)

```sh
cd ../studio
npm install
npm run typecheck
npm test
```

## 4. Start the studio dev server (In progress, unverified)

```sh
npm run dev
```

This serves the studio UI (Foco and Painel views). Treat live behavior as unverified.

## 5. Build the daemon (In progress, unverified)

```sh
cd ../daemon
zig build
```

This builds the `koinonia-d` binary. See the [ingest protocol](../reference/daemon-protocol/) for its environment variables (stream keys go in the environment, never in files you commit).

## 6. Go live (Planned)

The intended flow, once phases 1 and 2 land:

1. Start `koinonia-d` with your stream keys in the environment (never in files, never on a command line). See [Security](../security/).
2. Open the studio page, grant camera and microphone, pick a scene.
3. Connect an agent that speaks WebMCP, or use the studio UI directly.
4. Call `start_stream`; confirm in the studio when prompted.

## Run these docs locally

```sh
cd site
npm install
npm run dev
```
