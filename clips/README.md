# @koinonia/clips

Clipper brain for Koinonia: find highlights, reframe to 9:16, caption, describe an export job, publish with human approval, and write the post-live report. Pure TypeScript logic; all I/O (LLM, speech-to-text, encoding, HTTP, credentials) is injected. No runtime dependencies (the only sibling import is `../tokens/src`, isolated in `src/tokens-adapter.ts`).

```
npm run typecheck && npm test     # uses ../tokens/node_modules via symlink (no install needed in this checkout)
```
Time is always milliseconds on one session timeline.

## 1. Highlight detection (`detect.ts`)
`detectMoments({startMs,endMs,chat?,audio?,transcript?,events?}, overrides?) -> Moment[]`

Per 5 s bucket, five signals each yield a 0..1 score plus a human-readable reason:

| signal | what | baseline |
|---|---|---|
| `chatRate` | messages per bucket | trailing median/MAD (robust z), min count and ratio |
| `chatBurst` | laughter / positive / negative reaction tokens, emotes, ALL-CAPS share | same |
| `audio` | loudness peak (dB) over trailing median | delta dB, ignores silence |
| `transcript` | keyword cues (pt/en: disbelief, reveal, emphasis, story opener...) and vocal energy (exclamations, speech-rate surge) | configurable `keywords` |
| `event` | raid, sub gifts, cheers, poll end | per-type weight |

Fusion: `max(weighted average over *available* signals, soloFactor * strongest signal) + agreementBonus per extra active signal`. The solo path is what lets a quiet, talk-only moment (a reveal in speech, no loud audio, small chat) score on its own; no game-specific heuristics are used. Missing streams do not penalise (weights renormalise). Buckets over `minScore` are merged (`mergeGapMs`), padded, clamped to min/max duration and de-overlapped. Each `Moment` has `score`, `peakMs`, `signals`, `reasons[]` (sorted, with `atMs` and text such as `loudness peak -11.5 dB, +18.5 dB over baseline`) and a `summary`. Everything is in `DetectConfig` (`resolveConfig` deep-merges partials).

## 2. Vertical pipeline
- `reframe.ts`: `planReframe(frames, startMs, endMs, {srcWidth, srcHeight, ...}) -> CropPlan`. Input is detection boxes per frame (`face`/`subject`, confidence, optional `trackId`). Keeps all subjects in frame if they fit, else follows the heaviest (faces weighted, `preferTrackId` boosts). Smoothing: deadzone + EMA + max px/s speed limit + hold-then-return-to-fallback when detections vanish; starts on the subject (no opening pan). Landscape sources pan on x, portrait sources on y. `cropAt(plan, t)` interpolates.
- `captions.ts`: `CaptionProvider.transcribeWords()` interface (word timings), `rebaseWords`, `groupWords` (cues of lines, per-word timing kept), `CaptionStyle` (font, stroke, shadow, optional box, active-word colour/scale, bottom safe margin), and `renderCaptionOps(cues, style, tMs, {width,height,measure?}) -> DrawOp[]` (pure draw list) plus `drawOps(ctx, ops)` for any Canvas2D/OffscreenCanvas context. Inject a real `measure` (`ctx.measureText`) in the studio; the default is an approximation.
- `export.ts`: `buildExportJob(...) -> ExportJob` (JSON-serialisable: source range, output 1080x1920 H.264/AAC WebCodecs codec strings, crop plan, captions, loudness target, ordered `steps`), `validateExportJob`, `ExportExecutor` interface (studio worker or daemon implements `run`), `runExport`.

## 3. Publishing (`publish.ts`)
`YouTubeShortsAdapter`, `TikTokAdapter`, `InstagramReelsAdapter`: typed stubs. Each exposes `spec` (auth, limits, media rules, HTTP flow) where every fact is tagged `documented` (seen in official docs, 2026-10 research) or `assumed`, plus `validate()`. `publish()` throws `NotImplementedError`.

Verified in official docs: YouTube API projects created after 2020-07-28 and not audited are locked to private; `videos.insert` quota is 100 units on the current reference (third-party guides say 1,600, check the Cloud Console). TikTok unaudited clients are forced to private, error `unaudited_client_can_only_post_to_private_accounts`, max 5 users/24h. Instagram: container flow (`/media` with `media_type=REELS` + public `video_url`, then `/media_publish`), per-24h API post cap (100 on current docs, 50 on older pages). Everything else (scopes, Shorts max length, TikTok endpoints/creator-info step, Reels duration/codec rules, tag rules) is marked `assumed`.

Approval gate: `Publisher.submit -> approve(id, approver, seenFingerprint) -> publish(id)`. `publish` refuses unless status is `approved`, the content fingerprint still matches what the human saw, and the approval is within `approvalTtlMs`. Adapters are only reachable through `Publisher`.

## 4. Post-live report (`report.ts`)
`generateReport(input, {llm?, compactor?, options?}) -> LiveReport` with `summary`, `chapters` (+ `chapterText` in `mm:ss Title` form), `titles`, `thumbnails` (peak frames ranked with optional `frameHints` such as face score and transition flags, de-duplicated by 10 s), `whatWorked` (top peaks, raid/poll chat rate before vs after) and `generation` (calls, context tokens before/after, warnings).
Chapters, thumbnails and what-worked are deterministic. One LLM call (`LlmProvider.complete`, `tier: "small"`) rewrites summary, titles and chapter titles from compact context; unparsable output or errors fall back to deterministic text with a warning. `tokensCompactor()` (in `tokens-adapter.ts`) plugs `compactChat`/`estimateTokens` from `../tokens`; `basicCompactor` is the dependency-free default.

## Tests
`test/fixtures/session.json` is a recorded 10-minute synthetic session (regenerate with `node test/fixtures/generate.mjs`): a loud+hype peak at 2:00, a quiet transcript-only reveal at 4:10, a raid at 6:40, a poll at 8:20.

## Known gaps
- No real network adapters, OAuth flows, upload chunking or status polling.
- Fixtures are synthetic; thresholds are untuned on real streams. Lexicons/keywords are pt/en only.
- Audio loudness comes in as samples (the studio must compute them); no VAD or music detection.
- Reframing has no zoom, shot-cut awareness or speaker diarisation; cut detection should reset the planner.
- Export executor, caption rendering in a real canvas, and thumbnail frame extraction are interfaces only.
