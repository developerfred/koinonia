# koinonia-d ingest protocol (v1)

Stable contract between the browser studio (WebCodecs encoders) and the Zig daemon.
Implementation: `src/framing.zig` (parser/encoder) and `src/ws.zig` (WebSocket server).

## Transport

- WebSocket (RFC 6455), binary messages, served on loopback only: `ws://127.0.0.1:<port>/ingest`.
- Default port `7878` (env `KOINONIA_PORT`).
- **One WebSocket binary message == exactly one frame** (no cross-message framing, no fragmentation
  required; the daemon does accept fragmented messages and reassembles them).
- Text messages from the browser are ignored/closed with 1003.
- Optional shared secret: if `KOINONIA_TOKEN` is set, the URL must be `/ingest?token=<value>`,
  otherwise the upgrade is rejected with `403`. (Loopback binding is the primary protection;
  the daemon also rejects upgrades whose `Origin` host is not `localhost`/`127.0.0.1`/`[::1]`
  when an Origin header is present and `KOINONIA_ALLOW_ANY_ORIGIN` is not set.)
- Only one active ingest session at a time; a second connection gets HTTP `409`.

## Frame layout

All integers big-endian. Header is 10 bytes, followed by the payload (rest of the message).

| offset | size | field            | notes |
|-------:|-----:|------------------|-------|
| 0      | 1    | `kind`           | see table below |
| 1      | 1    | `flags`          | bit0 = keyframe (video_chunk only); other bits reserved, send 0 |
| 2      | 4    | `dts_ms` (u32)   | decode timestamp in ms since session start (monotonic per track) |
| 6      | 4    | `cts_offset_ms` (i32) | pts - dts in ms. 0 for audio and for B-frame-less video (WebCodecs H.264 baseline/`latencyMode: realtime` => 0) |
| 10     | n    | payload          | depends on kind |

### Kinds

| kind   | name           | direction        | payload |
|-------:|----------------|------------------|---------|
| `0x01` | `start`        | browser -> daemon | UTF-8 JSON, see below. Must be the first frame. Non-empty. |
| `0x02` | `stop`         | browser -> daemon | empty. Ends the session (RTMP streams are closed gracefully). |
| `0x03` | `clip`         | browser -> daemon | UTF-8 JSON `{"seconds_back":30,"title":"optional"}`; daemon writes an MPEG-TS clip from the ring buffer and answers with a `status` frame `{"type":"clip",...}` |
| `0x10` | `video_config` | browser -> daemon | AVCDecoderConfigurationRecord (the WebCodecs `VideoDecoderConfig.description` / `EncodedVideoChunkMetadata.decoderConfig.description`). Send before the first `video_chunk`, and again whenever it changes (it will be re-sent to destinations as an AVC sequence header). |
| `0x11` | `audio_config` | browser -> daemon | AudioSpecificConfig (2+ bytes, the AAC `description`). Send before the first `audio_chunk`. |
| `0x12` | `video_chunk`  | browser -> daemon | one H.264 access unit in **AVCC** form (each NAL prefixed with a 4-byte big-endian length, matching `lengthSizeMinusOne` in the config; WebCodecs `avc: {format: "avc"}`). `flags` bit0 set for IDR. Non-empty. |
| `0x13` | `audio_chunk`  | browser -> daemon | one raw AAC-LC access unit (no ADTS header). Non-empty. |
| `0x80` | `status`       | daemon -> browser | UTF-8 JSON, see below. Never sent by the browser. |

Unknown kinds from the browser are a protocol error: the daemon sends a `status` error and closes
with WebSocket code 1002. Parser errors: `Truncated` (< 10 bytes), `UnknownKind`, `BadPayload`
(empty payload where one is required).

### `start` payload (JSON, unknown fields ignored)

```json
{
  "destinations": ["twitch", "youtube"],
  "width": 1280, "height": 720, "fps": 30,
  "video_kbps": 2500, "audio_kbps": 128,
  "sample_rate": 48000, "channels": 2
}
```

- `destinations`: names of configured destinations to publish to. Empty/absent = all configured.
  Unknown names yield a `status` error.
- Remaining fields are used for the FLV `onMetaData` block and the TS PMT; defaults shown above.
- Stream keys are **never** part of the protocol; they live only in the daemon's env/config.

### `status` payload (JSON)

Examples (the `type` field discriminates; extra fields may be added in later minor versions):

```json
{"type":"ready","version":1}
{"type":"started","destinations":[{"name":"twitch","state":"connecting"}]}
{"type":"dest","name":"twitch","state":"live"}
{"type":"dest","name":"youtube","state":"error","error":"ConnectionRefused"}
{"type":"stats","uptime_ms":12000,"in_kbps":2610,"dropped":{"twitch":0,"youtube":3},"dests":{"twitch":"live","youtube":"reconnecting"}}
{"type":"clip","ok":true,"path":"clips/2026-10-26T20-40-00_title.ts","seconds":30}
{"type":"error","message":"protocol: UnknownKind"}
```

`state` is one of `connecting`, `live`, `reconnecting`, `error`, `stopped`. `ready` is sent right
after the upgrade; `stats` roughly every 2 s while a session is active. Status payloads never
contain URLs with keys or stream keys.

## Session sequence

1. Browser opens the WebSocket; daemon sends `status ready`.
2. Browser sends `start`.
3. Browser sends `video_config` and `audio_config` (any order), then chunks. Chunks may arrive
   interleaved; `dts_ms` should be roughly non-decreasing per track. Video must start with a keyframe.
4. Browser sends `stop` (or just closes the socket) to end.

If a destination connects late (or reconnects), the daemon replays the stored configs and waits for
the next keyframe before forwarding video. Fan-out is non-blocking: a slow destination drops
frames (non-keyframes first) and never stalls the others or the ingest socket.

## Derived outputs (informational)

- FLV/RTMP per destination: `onMetaData`, AVC sequence header, AAC sequence header, then tags
  (`dts_ms` -> FLV timestamp, `cts_offset_ms` -> AVC composition time).
- MPEG-TS ring buffer (clipper): H.264 converted AVCC -> Annex B with SPS/PPS before each IDR,
  AAC wrapped in ADTS, PTS/DTS in 90 kHz, PAT/PMT repeated at each keyframe.

## Configuration (daemon side, env or JSON file)

Env: `KOINONIA_PORT`, `KOINONIA_TOKEN`, `KOINONIA_CONFIG` (path to JSON), `KOINONIA_CLIP_DIR`,
`KOINONIA_CLIP_SECONDS` (ring size, default 300), `KOINONIA_TWITCH_URL` (default
`rtmps://live.twitch.tv:443/app`), `KOINONIA_TWITCH_KEY`, `KOINONIA_YOUTUBE_URL` (default
`rtmps://a.rtmps.youtube.com:443/live2`), `KOINONIA_YOUTUBE_KEY`. Generic extra destinations:
`KOINONIA_DEST_<NAME>_URL` / `KOINONIA_DEST_<NAME>_KEY`.

JSON file:

```json
{ "port": 7878, "clip_seconds": 300, "clip_dir": "clips",
  "destinations": [ {"name":"twitch","url":"rtmps://live.twitch.tv:443/app","key":"live_xxx"} ] }
```

Env values override file values. A destination without a key is ignored. Keys are redacted
(`****`) by every log/format path in the daemon.

## Versioning

This is v1. Additive changes only: new kinds and new JSON fields. Existing offsets, kind values
and flag bits will not change.
