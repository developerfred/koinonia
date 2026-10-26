# koinonia desktop

One native binary (Zig 0.17.0) that runs the Koinonia daemon, serves the studio, and opens it as an
app window in your installed Chromium-family browser with a dedicated profile.
Rationale and alternatives: [DESIGN.md](DESIGN.md). Wanted daemon/studio changes:
[NEEDS-DAEMON-CHANGES.md](NEEDS-DAEMON-CHANGES.md).

## Build

```sh
(cd ../studio && npm ci && npm run build)   # produces studio/dist, embedded into the binary
zig build                                   # -> zig-out/bin/koinonia
zig build test
zig build -Dtarget=aarch64-windows -Doptimize=ReleaseSafe   # any of x86_64/aarch64 x linux/windows/macos
```

`-Dstudio-dist=PATH` embeds another directory (default `../studio/dist`).

## Run

```sh
./zig-out/bin/koinonia
```

Stream keys use the same settings as `koinonia-d` (see `../daemon/PROTOCOL.md`):
`KOINONIA_TWITCH_KEY`, `KOINONIA_YOUTUBE_KEY`, `KOINONIA_CLIP_DIR`, ... or `--config file.json`.
Keys are never printed.

| Option | Meaning |
|---|---|
| `--browser PATH` / `KOINONIA_BROWSER` | use a specific Chromium-family browser |
| `--no-browser` | serve only, print the URL |
| `--studio-dir DIR` | serve a directory instead of the embedded studio |
| `--profile-dir DIR` | browser profile (default per user: `~/.local/share/koinonia/browser-profile`, `~/Library/Application Support/Koinonia/browser-profile`, `%LOCALAPPDATA%\Koinonia\browser-profile`) |
| `--port N` | fixed studio HTTP port |
| `--list-browsers`, `--check-config`, `--version` | diagnostics |

Exit codes: 0 normal, 1 error, 2 usage, 3 no browser found, 4 browser exited immediately.

Browser order: Google Chrome, Microsoft Edge, Brave, Chromium. Chrome and Edge include H.264/AAC
encoders; some Linux Chromium builds do not. WebMCP (`navigator.modelContext`) needs a Chrome build
that has it; the launcher passes best-effort flags, check `navigator.modelContext` in DevTools.
The browser is started with flags that disable background/occlusion throttling.

## Status (what was verified)

See the end of the task report; in short: host (macOS arm64) build, 14 unit tests, end-to-end run with
real Chrome (window, ingest handshake with token and Origin check, SIGINT cleanup), HTTP hardening
checks and cross-compiles listed below. Not verified: running on Linux/Windows/Intel macOS, an
actual stream (no key used), throttling behaviour,
WebMCP availability.
