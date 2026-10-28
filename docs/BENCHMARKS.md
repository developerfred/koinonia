# Benchmarks and OBS comparison

Status: measured on one machine with a synthetic (fake) camera and microphone, a local fake RTMP sink and no real
platform. OBS Studio is **not installed** here, so every OBS column is "not measured". Nothing below is a claim that
Koinonia is faster or slower than OBS.

Reproduce: `cd daemon && zig build`, `cd studio && npm run build && node e2e/e2e.mjs --res 720` (also `--res 1080`,
`--br variable`, `--no-bridge`, `--headless`). Raw results: `studio/e2e/results/*.json`. The sink is `qa/lib/rtmp-sink.ts`
(plain RTMP, no TLS). Everything runs on one host, so the harness, the sink, Chrome and the daemon compete for CPU.

## Machine and setup

Apple M1, 8 cores, 8 GB RAM, macOS 26.5, Google Chrome 156 (headed, Playwright, flags `--use-fake-device-for-media-stream`),
daemon built with Zig 0.17 (default build mode). Source: fake camera 1280x720 (reports 20 fps), fake mono microphone 48 kHz.
Scene: one camera layer. Duration about 70 s per run: 30 s steady, clip export, 20 s "background" phase, 8 s return.

## Measured results (Koinonia)

| Metric | 720p30 (3000 kbps target) | 1080p30 (6000 kbps target) | OBS 1080p30 |
|---|---|---|---|
| Video encoder actually used | software H.264 (hardware stalled, see below) | software | not measured |
| AAC-LC encoding in WebCodecs | available (probe true; 705+ chunks encoded, decodes cleanly) | same | not measured |
| Click-to-first-video-tag at sink | 1.8-1.9 s (includes about 1.5 s hardware-stall watchdog) | 2.2 s | not measured |
| Page load to studio ready | about 0.9 s | n/a | not measured (startup time) |
| Compose-to-sink latency, p50 | 11-13 ms | 22 ms | not measured |
| Compose-to-sink latency, p95 | 89-225 ms | 741 ms | not measured |
| Compose-to-sink latency, max | 0.35-3.0 s (occasional stalls) | 3.1 s | not measured |
| Delivered fps (sink, steady window) | 30.1-30.2 | 22.0 (encoder cannot keep up) | not measured |
| Missed frames (from timestamp gaps) | 0 to 160 per 65 s run (see variance) | 326 | not measured |
| Chrome CPU, all processes, foreground | 66-79 % of one core (renderer 30-34, GPU process 28-36) | 92 % (renderer 50, GPU 33) | not measured |
| Daemon CPU | 3.5-4.1 % of one core | 3.7 % | n/a |
| Daemon memory (RSS) | 2.5-2.9 MB | 2.6 MB | n/a |
| Video bitrate at sink | 255-410 kbps (target 3000) | 339-419 kbps (target 6000) | not measured |
| Keyframe interval | median 1980 ms (2 s configured) | 1981 ms | not measured |
| Clip export (20 s) | saved, MPEG-TS h264 + aac 48 kHz, ffmpeg decode clean | same | not measured |

Latency definition: wall time a video tag reaches the sink minus the wall time of that frame's compositor timestamp
(canvas draw, VideoFrame, encode, WebSocket, daemon, RTMP). It excludes camera/driver capture latency, any CDN and the
player, so it is **not** glass-to-glass and not comparable to a platform's reported latency. The sink also lives in the
harness process.

Variance: the 720p runs differ a lot. One run had 0 missed frames and p95 89 ms; another had stalls of 1-3 s and 160
missed frames; a third 65 missed frames. Three or four samples each is not enough for a statistic. The cause of the
intermittent multi-second stalls was not isolated (candidates: software encoder queue, daemon queue, harness sharing
the CPU). Treat max latency and missed frames as "unstable, under investigation".

### Bitrate before/after (task: low send rate on static scenes)

| Mode | 720p video kbps at sink (target 3000) |
|---|---|
| `bitrateMode: variable` (previous behaviour) | 359 and 266 |
| `bitrateMode: constant` (now default, falls back to variable if unsupported) | 354, 255 and 410 |

With the fake camera and the software encoder, constant mode did **not** raise the send rate. Chrome accepted the
constant setting (`isConfigSupported` true) but the encoder still spends about 10 % of the target on this mostly flat
picture. So the change is in place and tested, but it does not by itself fix a 79-156 kbps report on a static screen.
Options not implemented: filler/padding data (wastes upload; the daemon would need to inject NAL filler or null
packets), a lower configured target for static scenes so platforms do not flag it, or a periodic forced keyframe
(already every 2 s). The health panel now says in plain language that a nearly still scene is a likely cause.

### Background tab (phase-0 risk)

**Not verified.** The test opened a second tab and called `bringToFront`, but `document.visibilityState` stayed
`visible` for the studio tab: Playwright emulates focus and visibility, so the tab was never truly hidden. The rates
measured in that phase (26.9-30.4 fps) therefore only show that opening another tab does not break streaming under
automation. A real check needs a manually hidden or minimised window on a real session. The compositor timer runs in a
Worker (not throttled like main-thread timers), which is why we expect it to hold, but that is a design argument, not a
measurement. Window occlusion and macOS App Nap were not tested either.

### Findings that changed the code

* Hardware H.264 (VideoToolbox through WebCodecs) accepted frames, reported `isConfigSupported: true`, raised no error
  and produced zero output chunks on this machine. Software worked. The worker now has a watchdog: no output after
  3 frames and 1.5 s falls back to software and warns. `?enc=hardware|software|auto` forces a mode.
* The fake and many real microphones are mono; the AAC encoder was configured for stereo and failed with "Input audio
  buffer is incompatible". Mono is now duplicated to stereo.
* Audio timestamps used the capture clock while video used the compositor clock; audio is now rebased to the session
  clock. Dts is clamped to be non-decreasing per track.
* Daemon: configuration headers re-sent mid-stream were stamped 0 (timestamps went backwards in the FLV). They now use
  the track's current time.
* Transport: the daemon sends `ready` immediately after the upgrade; the studio could miss it. Fixed by arming the wait
  first.
* `canvas.width` could receive a fraction or undefined (URL params). Config is sanitised to even integers.
* Unhelpful "H.264 encoding unavailable" error: now names the browser, which probe failed and what to do.
* Known remaining: `ffmpeg` prints "non monotonically increasing dts" warnings for the audio track of the captured FLV
  (FLV carries a 44 kHz flag while the AAC config says 48 kHz; the clip, which is MPEG-TS, decodes without errors).

### Agents bridge and approvals (end to end, real page)

Real Chrome page plus the bridge relay plus the orchestrator with a scripted model (no API key, no real LLM). The
moderator proposed a ban; it appeared as pending in the approvals panel and nothing ran before approval. Approving with
no platform connector attached ended as "not executed" (honest failure). With a recording connector attached,
approving a timeout executed it through the connector. Agent token usage reached the page: `get_token_report` returned
7648 spent and the budget panel showed "7.648 de 200.000 tokens". `get_chat` through the bridge returned data.
Real Twitch/YouTube moderation APIs were not exercised: no Helix client is bundled.

## Methodology for a fair comparison with OBS Studio

1. Same machine, nothing else running, power adapter connected, same display state. Quit the browser when testing OBS.
2. Same output: 1920x1080, 30 fps, same encoder class. Run each of: x264 (veryfast or the same preset, CBR 6000 kbps,
   keyframe 2 s) and the hardware encoder (VideoToolbox on macOS, NVENC/QSV/AMF elsewhere). Koinonia currently
   offers only what WebCodecs exposes, no preset or rate-control tuning beyond bitrate mode.
3. Same source: a fixed test video through a virtual camera or a capture of the same window, plus the same audio file.
   Fake devices are fine for relative comparison but say so.
4. Same sink: point both at the same local RTMP sink (and a second run at a real test channel). Record at the sink.
5. Metrics, 10 minutes per run, 5 repetitions, report median and spread:
   * CPU: all processes of the app (OBS main plus helpers, Chrome all types plus the daemon) from `ps` or CDP, as
     percent of one core, plus system-wide idle delta.
   * Memory: sum of RSS of the same processes at 1 and 10 minutes.
   * Latency: sink arrival minus a burned-in timestamp decoded from the output frames (glass-to-glass needs a camera
     pointed at a clock); report p50/p95/max.
   * Dropped frames: encoder-reported drops, OBS "skipped/missed/lagged frames" counters, and gaps in sink timestamps.
   * Startup: process launch to first frame at the sink; and "Start streaming" click to first frame.
   * Delivered kbps versus target, on a static scene and a moving scene.
6. Long run: 3 hours, record the same metrics every minute, count reconnects.

OBS columns above stay "not measured" until someone runs steps 1-6 with OBS installed.

## Gaps versus OBS and streaming apps

| Area | OBS / streaming apps | Koinonia today |
|---|---|---|
| Audio mixing and filters | multi-track mixer, gain, noise gate, compressor, limiter, monitoring | one track feeds the encoder; mute works, volume is a stub, no filters, no desktop-audio mixing |
| Scenes and sources | unlimited scenes, nested scenes, many source types, transitions | two scenes, camera/screen/text layers, no image or browser source, no transitions, stretches instead of aspect-fit |
| Game and window capture | native game capture, window capture, display capture | browser screen share only (no game hooks, picker limited by the browser) |
| Hardware encoder control | encoder choice, preset, profile, rate control, B-frames, lookahead | WebCodecs only; hardware can stall silently (watchdog falls back), constant bitrate not honoured on static scenes by the software encoder tested |
| Plugins | large plugin ecosystem, scripting | none; WebMCP tools for agents instead |
| Virtual camera | built in | none |
| Local recording / VOD | MKV/MP4 recording, replay buffer | circular MPEG-TS clip buffer only (ring of N seconds); no continuous recording or remux |
| Alerts and overlays | browser sources, stream-service integrations | text lower-third only; no alerts, no widgets |
| Long-stream stability | years of field use | untested beyond about 2 minutes; no soak result; memory growth unknown |
| RTMP | acknowledgement handling, bandwidth test, dynamic bitrate, reconnect with backoff | daemon reconnects, but acknowledgement-window and throughput feedback are not used for adaptation; TLS to platforms untested against real services |
| Multi-destination | via plugin or restream service | fan-out in the daemon (Twitch and YouTube in parallel); tested against a local sink only |
| Moderation / platform actions | via dock plugins | proposal and approval flow works end to end; platform execution needs a Helix/YouTube client that is not bundled; polls and pins are recorded locally only |
| Accessibility and ergonomics | mature UI | Foco/Painel views, keyboard first, but no field validation by users |
