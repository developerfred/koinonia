---
title: "Desktop app"
description: "The Koinonia desktop app: one native binary that runs the daemon, serves the studio and opens it as an app window. Build steps, options and exit codes."
sidebar:
  order: 4
---

:::caution[Built, not released]
The desktop app exists in `desktop/` and has been built and run on macOS arm64. The first alpha download is not published yet (see the [Download](../download/) page); build it from source for now. Linux, Windows and Intel macOS builds cross-compile but have not been run.
:::

The desktop app is one native binary written in Zig. It runs the Koinonia daemon, serves the studio from files embedded in the binary, and opens the studio as an app window in a Chromium-family browser you already have installed, using a dedicated browser profile. Capture and encoding still happen in the browser, as described in the [architecture](../concepts/architecture/).

## Build

```sh
(cd studio && npm ci && npm run build)   # produces studio/dist, embedded into the binary
cd desktop
zig build                                # -> zig-out/bin/koinonia
zig build test
```

`-Dstudio-dist=PATH` embeds another directory instead of `../studio/dist`. Cross-compiling uses `-Dtarget`, for example `-Dtarget=aarch64-windows -Doptimize=ReleaseSafe` (x86_64 or aarch64, on linux, windows or macos).

## Run

```sh
./zig-out/bin/koinonia
```

Stream keys use the same settings as `koinonia-d` (see the [daemon protocol](../reference/daemon-protocol/)): `KOINONIA_TWITCH_KEY`, `KOINONIA_YOUTUBE_KEY`, `KOINONIA_CLIP_DIR` and so on, or `--config file.json`. Keys are never printed.

## Flags

| Option | Meaning |
| --- | --- |
| `--browser PATH` or `KOINONIA_BROWSER` | Use a specific Chromium-family browser. |
| `--no-browser` | Serve only and print the URL. |
| `--studio-dir DIR` | Serve a directory instead of the embedded studio. |
| `--profile-dir DIR` | Browser profile directory. Defaults per user: `~/.local/share/koinonia/browser-profile`, `~/Library/Application Support/Koinonia/browser-profile`, `%LOCALAPPDATA%\Koinonia\browser-profile`. |
| `--port N` | Fixed studio HTTP port. |
| `--skip-probe` | Skip the startup codec check. |
| `--strict` | Exit with code 5 if H.264 encoding is missing. |
| `--list-browsers`, `--check-config`, `--version` | Diagnostics. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Normal exit. |
| 1 | Error. |
| 2 | Usage error. |
| 3 | No browser found. |
| 4 | The browser exited immediately. |
| 5 | H.264 encoder missing (only with `--strict`). |

## Codec check

Before opening the window, the app starts the same browser headless, with a separate probe profile, on a tiny page that calls `VideoEncoder.isConfigSupported` for H.264 baseline 3.1 and `AudioEncoder.isConfigSupported` for AAC-LC 48 kHz stereo. It prints either that H.264 and AAC encoding are available in the chosen browser, or a warning naming the browser and path. A headless probe can differ from the windowed browser in hardware encoder availability, so a missing result warns rather than blocks unless you pass `--strict`.

Browser search order: Google Chrome, Microsoft Edge, Brave, Chromium. Chrome and Edge include H.264 and AAC encoders; some Linux Chromium builds do not. WebMCP (`navigator.modelContext`) needs a Chrome build that has it. The launcher passes best-effort flags, so check `navigator.modelContext` in DevTools. The browser is started with flags that disable background and occlusion throttling.

## What was verified

On macOS arm64: the host build, 14 unit tests, an end-to-end run with real Chrome (window, ingest handshake with token and Origin check, clean shutdown on interrupt) and HTTP hardening checks. Not verified: Linux, Windows or Intel macOS runs, a real stream, throttling behaviour, WebMCP availability.
