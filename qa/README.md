# Koinonia QA

One command: **`make qa`** (repo root). It runs every gate below, never stops at the first failure, and prints
`PASS` / `FAIL` / `SKIP (reason)` per gate plus a summary. Components that are not ready yet are *skipped with a
reason*, never silently ignored; `make qa-strict` (used by CI) turns every skip into a failure.

```
make install        # qa deps + Playwright Chromium (once)
make qa             # everything (a few minutes; first run builds the daemon)
make qa-fast        # skips slow gates: e2e, soak, site, audit, ReleaseSafe build
make qa-strict      # CI mode
make qa-list        # list gate ids;   node qa/tools/gates.mjs --only <id>[,<id>]  runs some
make qa-selfcheck   # validate THIS harness against a Node reference daemon (no Zig needed)
```

Everything QA writes goes to `qa/.out/` (gitignored: logs, coverage, daemon build, zig caches). QA never writes
into `daemon/`, `studio/`, `tokens/`, `agents/` or `site/` sources. The daemon is built with
`zig build --prefix qa/.out/daemon --cache-dir qa/.out/zig-cache`, so `daemon/zig-out` is left to developers.

## What runs

| # | Area | Gate id(s) | What it proves |
|---|------|-----------|----------------|
| 1 | Per-component | `daemon:fmt` `daemon:test` `daemon:build` `daemon:build-releasesafe` | `zig fmt --check`, `zig build test`, Debug + ReleaseSafe build |
|   |  | `studio:typecheck` `studio:test` `studio:build` | tsc, vitest **with coverage thresholds**, vite production build |
|   |  | `tokens:*` `agents:*` | same (agents only if `agents/package.json` exists) |
|   |  | `lint:ts` | ESLint (typescript-eslint, config in `qa/eslint.config.js`; the components ship none) over studio/tokens/agents/qa |
|   |  | `site:build` `site:quality` | astro build, link/anchor check (re-uses `site/scripts/check-links.mjs`), structure checks (lang/title/h1/description), **axe-core WCAG 2.x A/AA in light and dark**, Lighthouse (`QA_LIGHTHOUSE=1` locally, always in CI via `lighthouserc.json`) |
| 2 | Contract | `contract`, `qa:zig-conformance+fuzz` | studio framing **and** daemon framing both checked against the same golden bytes (`qa/fixtures/protocol/golden.{json,txt}`), see below |
| 3 | Integration | `integration` | real `koinonia-d` process <-> fake studio (WebSocket) <-> **two fake RTMP sinks** (`lib/rtmp-sink.ts`): handshake, connect/createStream/publish with the right key, onMetaData, AVC/AAC sequence headers, byte-exact FLV tag bodies and timestamps vs golden, identical fan-out to both destinations, `start.destinations` filtering, slow-sink isolation, reconnect + config replay + resume-at-keyframe, plus the ingest-socket rules in `PROTOCOL.md` (409 second session, 1002 unknown kind, 1003 text, token 403, Origin check) |
| 4 | E2E | `e2e:playwright` | Playwright/Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, the WebMCP polyfill (`e2e/webmcp-polyfill.js`) injected before boot, driving studio tools exactly as an agent does (catalog size, get_chat deltas/dedupe, error shapes, fake camera preview, start_stream against a fake daemon that validates frames) |
| 5 | Fuzz / property | `qa:zig-conformance+fuzz`, `fuzz`, `properties` | Zig: corpus replay + all single-byte mutations + every prefix + a deterministic random runner (`-Dfuzz-iters`) + `std.testing.fuzz` entry (coverage-guided with `make fuzz-zig`) over framing parse, Start JSON, AMF0 scanners and the RTMP chunk reader. TS: fast-check (fixed seeds) for studio `decodeFrame`, `compactChat`, `trimOutput`, `DeltaTracker`, `sliceAfterCursor`, `ModelRouter`, `BudgetTracker`, `RollingSummary`, studio `ChatBuffer`. Black-box: 150 seeded mutated sessions against the live daemon, which must stay alive and accept a new session |
| 6 | Security | `security:secrets` `security:audit` `security:zig-deps` `security:tests` | gitleaks (`.gitleaks.toml`; built-in fallback scanner `tools/secretscan.mjs` when gitleaks is absent), `npm audit --audit-level=high` per package, Zig dependency report, and **stream keys / ingest token never appear in daemon stdout/stderr or status frames** (healthy publish, destination rejects publish, destination vanishes) in plain, URL-encoded, hex and base64 forms; plus a static check that no log/print call in `daemon/src` formats a key without the redacting `{f}` formatter or calls `.reveal()` |
| 7 | Token economy | `evals:token-economy` | deterministic benchmark (seeded fixtures, `estimateTokens`) of tokens saved by chat compaction, the studio `get_chat` tool, `trimOutput`, delta cursors, the model router (cost vs always-large) and the semantic response cache; fails if any metric drops more than 2 points below `evals/baseline.json` or below a hard floor, or if retention of the most repeated messages falls |
| 8 | Soak | `soak:smoke` (12 s, CI) / `make soak-full` (10 min, nightly) | 30 fps video + AAC at real time to three destinations (fast, slow sink at 40 kB/s, flaky sink that drops every N tags): daemon alive, fast sink gets >= 95% of frames with valid FLV structure, slow sink sheds frames instead of back-pressuring ingest, reconnects replay sequence headers and resume at a keyframe, RSS growth bounded. Writes `qa/.out/soak.json` |

## How the harness adapts to code in flux

* **Readiness probes** (`tools/gates.mjs`, `lib/env.ts`): a gate skips with a reason if its component, script or
  binary is missing. Integration/security/fuzz/soak *probe* the daemon (spawn it, wait for the port); if it does not
  listen they print `[qa] SKIP ...` and the gate is reported as SKIP, not as a false PASS.
* **Black-box daemon contract** (`lib/daemon-proc.ts`): the daemon is configured only through the env vars in
  `daemon/PROTOCOL.md` (`KOINONIA_PORT`, `KOINONIA_TOKEN`, `KOINONIA_CLIP_DIR`, `KOINONIA_TWITCH_URL/KEY`,
  `KOINONIA_YOUTUBE_URL/KEY`, `KOINONIA_DEST_<NAME>_URL/KEY`) and talks plain `rtmp://127.0.0.1:<port>/app` to the sinks.
  Override the binary with `KOINONIA_D_BIN`. The sink does not implement RTMPS/TLS; the daemon's TLS path is therefore not
  covered end to end (only `Url.parse` unit tests).
* **Golden fixtures** (`fixtures/`): generated by `tools/gen-fixtures.mjs` from an *independent* encoding of the layout in
  `daemon/PROTOCOL.md`; `qa:fixtures-fresh` fails if the checked-in files are stale. If the protocol changes, change the
  generator, run `make fixtures`, and every consumer (reference codec, studio contract, Zig conformance, sink assertions)
  follows. The golden session also carries the **expected FLV tag bytes** for each frame.
* **Known gaps** (`known-gaps.json`): a contract test for a documented bug in another component runs as `it.fails()`
  (Playwright: `test.fail()`). The suite stays green while the bug exists, and goes **red the moment it is fixed** so the
  entry gets removed. Each entry says which file is at fault.
* **Zig API drift**: `qa/zig/qa_zig.zig` has a `comptime` guard that fails loudly if `koinonia.framing.parse` disappears;
  optional surfaces (`flv`, `amf0`, `rtmp.ChunkReader`, `framing.parseStart`) are exercised only when present (`@hasDecl`).

## Layout

```
qa/
  tools/gates.mjs        make qa driver            tools/gen-fixtures.mjs   golden + chat fixtures
  tools/site-gate.ts     site structure/links/axe/lighthouse   tools/secretscan.mjs   gitleaks fallback
  tools/ref-daemon       Node reference daemon (harness self-check only)
  lib/                   rtmp-sink, rtmp-client, amf0, daemon-proc, ws-studio, golden codec, fake-daemon-ws, gap(), env
  contract/ integration/ security/ fuzz/ properties/ evals/   vitest suites (config: vitest.config.ts)
  e2e/                   Playwright specs + WebMCP polyfill (config: playwright.config.ts)
  soak/soak.ts           soak/load test           zig/   build.zig + conformance.zig + fuzz.zig against daemon/src/root.zig
  fixtures/              generated; do not edit    coverage-thresholds.json  evals/baseline.json  known-gaps.json
```

## Everyday recipes

* *Daemon changed its framing*: update `daemon/PROTOCOL.md`, then `tools/gen-fixtures.mjs` (+ `lib/golden.ts` decode rules), `make fixtures`.
* *Intentional token-economy improvement*: `make evals-update`, review the `evals/baseline.json` diff, commit it.
  Never lower a baseline to make CI pass: raise a bug instead.
* *Raise coverage floors*: edit `coverage-thresholds.json` (ratchet up only). Studio excludes browser-only code
  (`src/worker/**`, `src/main.ts`), which is covered by e2e instead.
* *Reproduce a property failure*: fast-check prints `seed`/`path`; seeds are fixed per property in
  `properties/tokens.property.test.ts` and can be widened with `QA_PROP_RUNS=5000`.
* *Coverage-guided Zig fuzzing*: `make fuzz-zig` (runs until interrupted; crashes are saved by the Zig fuzzer).
* *Serious soak*: `make soak-full`, or `cd qa && npx tsx soak/soak.ts --seconds 3600 --video-bytes 40000`.
* *Env knobs*: `QA_STRICT`, `QA_NO_INSTALL`, `QA_OFFLINE`, `QA_SITE_BUILD`, `QA_LIGHTHOUSE`, `QA_AXE_STRICT`, `QA_FUZZ_ITERS`,
  `QA_ZIG_FUZZ_ITERS`, `QA_PROP_RUNS`, `QA_READY_MS`, `QA_REQUIRE_DAEMON`, `QA_STUDIO_URL`, `QA_STUDIO_PORT`, `QA_DAEMON_PORT`, `QA_MAX_CATALOG_TOKENS`, `KOINONIA_D_BIN`.

## CI (`.github/workflows/ci.yml`)

`daemon` (fmt, test, Debug/ReleaseSafe, 4-target cross-compile), `ts` matrix (tokens, studio, agents: typecheck + coverage
thresholds), `lint`, `site` (build, links, axe, Lighthouse CI), `contract-and-evals`, `integration` (daemon <-> sinks,
stream-key test, black-box fuzz, soak smoke), `e2e` (Playwright under xvfb), `security` (gitleaks with full history, npm audit),
and a nightly `nightly` job (10 min soak, 5M-iteration Zig fuzz, 3000-session black-box fuzz). CI sets `QA_STRICT=1`.
The docs deployment workflow (`pages.yml`) is separate and untouched.

## Limits worth knowing

* Token counts use the toolkit's own `estimateTokens` (chars/4). That is deliberate (deterministic, and it is what the
  budget code uses); it is not a billing-accurate tokenizer.
* Playwright's Chromium may lack a working H.264/AAC encoder; the streaming e2e tests then skip (or, when only the
  headless encoder misbehaves, record an `env` annotation) instead of failing. Run them on a Chrome build with codecs for full coverage.
* Dev-only advisories in `vitest@2` / `vite` (moderate) are visible in `npm audit` but the gate fails on high/critical only.
* The reference daemon (`tools/ref-daemon`) exists to prove the harness is correct; it is not part of the product.
