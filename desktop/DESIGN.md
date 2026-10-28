# Desktop shell: design and rationale

Goal: a cross-platform desktop app (Linux, Windows, macOS) built with Zig that reuses the Koinonia
daemon and hosts the browser studio. The studio's hard requirements, from `PLANO.md`:

1. WebCodecs encoding of H.264 and AAC (`VideoEncoder`/`AudioEncoder`), ideally hardware backed.
2. `getUserMedia` and `getDisplayMedia`.
3. Ideally `navigator.modelContext` (WebMCP) so agents can drive the studio.
4. No background throttling: the studio is exactly the window that gets covered by the game.

## Options compared

Evidence labels: **[verified]** I ran it on this machine (macOS arm64, Chrome and Brave installed);
**[sourced]** from documentation or search results, not run here; **[unverified]** I could not
confirm it and the claim is a best reading of public information.

### (a) The user's Chromium-family browser in `--app` mode, studio served from an embedded server

- WebCodecs: full in Chrome/Edge/Brave. H.264 and AAC encode need the vendor build (Chrome and Edge
  ship the codecs; distro "Chromium" builds frequently do not, hence the preference order
  Chrome > Edge > Brave > Chromium). The studio already feature-detects (`studio.ts`). [sourced]
- Capture: `getUserMedia`/`getDisplayMedia` with the standard permission prompts; permission
  decisions persist in the dedicated profile. localhost is a secure context, so no HTTPS is needed. [sourced]
- WebMCP: the only engine shipping it is Chrome, behind a flag in early builds. Search results I
  found were inconsistent about the minimum version (146 vs 149) and the command-line feature name,
  so the launcher passes `--enable-features=WebMCP,WebMCPTesting` as best effort (unknown features
  are ignored by Chromium) and the docs tell the user to check `navigator.modelContext`. [unverified]
- Throttling: Chromium exposes switches for exactly this. The launcher passes
  `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`,
  `--disable-backgrounding-occluded-windows`, `--disable-ipc-flooding-protection` and
  `--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling`. The flags are standard
  Chromium switches; their effect on this studio's frame rate has **not** been measured here (that is
  the Phase 0 spike in `PLANO.md`), only that Chrome starts with them and shuts down cleanly. [partly verified]
- Cost: nothing to bundle (binary stays under 1 MiB plus assets), updates and security patches come
  from the user's browser. Weakness: requires an installed browser; a dedicated `--user-data-dir`
  makes it a separate process tree (so the app can wait on it and never touches the everyday profile).
  Snap/Flatpak Chromium may not be able to write a profile outside its sandbox; `--profile-dir`
  and `--browser` exist for those cases.

### (b) System webviews

| Platform | Engine | WebCodecs | getDisplayMedia | Verdict |
|---|---|---|---|---|
| Windows | WebView2 (Evergreen Chromium) | Same Chromium code as Chrome; codec set follows the OS/Edge build | Supported, but the host app must handle the picker/permissions | Technically viable, needs C++/COM glue (`ICoreWebView2*`) or a vtable shim in Zig, plus the runtime installed |
| macOS | WKWebView | `VideoEncoder` exists in Safari 16.4+; `AudioEncoder`/AAC availability varies by version [sourced, not verified here] | Not available to embedded WKWebView (screen capture is Safari-only) [sourced] | Fails requirement 2 |
| Linux | WebKitGTK / WPE | Video codecs landed in 2.42 and audio codecs were slated for 2.44 per a 2023 GStreamer talk; I could not confirm current status or that distro builds enable it [sourced, unverified] | Depends on PipeWire/portal support in the build [unverified] | Too uncertain; also GTK/GStreamer system dependencies make cross-compiling from Zig hard |

Also: no webview offers WebMCP, and none lets us control throttling reliably (WKWebView/WebKitGTK
throttle hidden views and expose no switch). Different engines per OS also triples the QA matrix for a
media pipeline. Rejected as the primary shell; WebView2 is the only candidate worth revisiting.

### (c) Bundling CEF

Gives a pinned Chromium with all flags under our control and the codec question answered (Chromium
builds with proprietary codecs need a licensed build of CEF; the stock Spotify CEF builds do not ship
H.264/AAC). Cost: 150-300 MB per platform, a C API to bind from Zig, helper-process packaging and a
release pipeline that tracks Chromium security fixes, plus H.264/AAC patent-licensing questions for a
redistributed binary. Overkill for the first release; the right answer only if we need to run without
any installed browser or to pin behaviour.

### (d) Native Zig capture + encode path (future)

Capture via ScreenCaptureKit / Windows Graphics Capture / PipeWire, encode via VideoToolbox / Media
Foundation / VAAPI+NVENC, audio via platform APIs, bypassing the browser entirely. Best latency and
no throttling concerns, but it is a large per-platform FFI effort and forfeits the WebCodecs studio and
WebMCP surface that is the product's point. Keep as a later "headless streamer" mode: the daemon's
ingest protocol (`daemon/PROTOCOL.md`) is already the right seam, a native encoder would simply be a
second producer of the same frames.

## Decision

Ship **(a)** now. It is the only option that satisfies all three hard requirements on all three
operating systems with the least code and no redistribution risk. Keep the architecture such that
(c) or (d) can replace "launch a browser" without touching the daemon or the static server:
the shell's contract with the studio is just `http://127.0.0.1:<port>/` plus `window.__KOINONIA__`.

## Architecture of the `koinonia` binary

```
koinonia (one process)
 |- ingest listener  127.0.0.1:<free>  -> daemon `session.serve` per connection (daemon/src, imported)
 |- http listener    127.0.0.1:<free>  -> embedded studio assets, GET/HEAD only
 '- child process: <browser> --app=http://127.0.0.1:<http>/ --user-data-dir=<profile> + flags
```

- **Daemon reuse**: `build.zig.zon` depends on `../daemon` by path and imports module `koinonia`;
  nothing is copied. The accept loop is a short re-implementation because it lives in
  `daemon/src/main.zig` (see `NEEDS-DAEMON-CHANGES.md`).
- **Assets**: `build.zig` walks `studio/dist` at configure time and generates a module with one
  `@embedFile` per file, so the binary is self-contained. `--studio-dir` serves a directory instead.
  If `dist` is missing a placeholder page explains what to do.
- **Ports**: both listeners pick random ports in 49152-65535 and bind loopback only.
- **Ingest wiring**: a random 128-bit token is set as the daemon's `KOINONIA_TOKEN` equivalent, so
  only a page served by this process can open `/ingest` (the daemon additionally enforces the Origin
  check). The URL reaches the studio the way `studio/src/main.ts` expects: `--app=http://127.0.0.1:<p>/?daemon=ws://127.0.0.1:<i>/ingest&token=<t>`.
  Fallbacks for older `dist` builds: `window.__KOINONIA__` injection and rewriting hardcoded default URLs.
- **HTTP hardening**: Host header must be loopback with our port (DNS rebinding), GET/HEAD only,
  exact-match lookup in a table (no filesystem access from request paths), `no-store`, `nosniff`.
- **Lifecycle**: the main thread waits on the browser process. Window closed -> servers cancelled ->
  exit. SIGINT/SIGTERM/SIGHUP (POSIX) or console control events (Windows) terminate the browser, which
  unblocks the same path. Verified on macOS with real Chrome: SIGINT left no browser or koinonia
  process behind. If the browser exits within 3 s (typically: it handed the window to an existing
  instance) the app says so and exits with code 4.
- **Codec probe**: before the real window the chosen browser is run `--headless=new` on `/__probe.html`,
  which checks `VideoEncoder`/`AudioEncoder.isConfigSupported` for H.264 baseline and AAC-LC and reports
  to `/__probe/result/h264-X/aac-Y` (verified with Chrome on macOS arm64: both available; the inconclusive
  path was exercised with a fake browser; the negative path is unit-tested at the parser level only).
  Missing H.264 prints a warning naming the browser (exit 5 with `--strict`).
- **No browser**: exit code 3 and an install guide per OS; `--no-browser` still serves and prints the URL.
- **Windows console**: the same binary is a console app; a release build can add `-Dwindows-gui`
  later (subsystem) once logging goes to a file. Not done yet.

## Known gaps

- A real media session (camera -> WebCodecs -> daemon -> RTMP) was not run; only the WebSocket
  handshake with token and Origin checks was exercised.
- Throttling flags, WebMCP flags, and H.264/AAC availability per installed browser are not measured
  by this change; they belong to the Phase 0 spikes.
- Only macOS arm64 was executed. Other targets are cross-compiled but not run.
- No code signing / notarization / installers.
