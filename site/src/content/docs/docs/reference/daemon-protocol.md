---
title: "Daemon ingest protocol (v1)"
description: "The binary WebSocket protocol between the browser studio and koinonia-d: 10-byte frame header, frame kinds, start and status JSON, session sequence and daemon configuration."
---

:::caution[Status]
This page summarizes `daemon/PROTOCOL.md` (v1), which is the authoritative contract. The daemon code for it exists (`daemon/src/framing.zig`, `daemon/src/ws.zig`) but has **not been verified against Twitch or YouTube**. The studio-side codec (`studio/src/protocol.ts`) was written against an earlier draft (an 18-byte header with different kinds) and must be reconciled with v1; until then, trust `daemon/PROTOCOL.md`.
:::

## Transport

- WebSocket (RFC 6455), binary messages, **loopback only**: `ws://127.0.0.1:<port>/ingest`. Default port `7878` (`KOINONIA_PORT`).
- **One binary message is exactly one frame.** The daemon accepts fragmented messages and reassembles them. Text messages from the browser are rejected.
- Optional shared secret: if `KOINONIA_TOKEN` is set, the URL must be `/ingest?token=<value>` or the upgrade is rejected with `403`.
- When an `Origin` header is present, its host must be `localhost`, `127.0.0.1` or `[::1]` (unless `KOINONIA_ALLOW_ANY_ORIGIN` is set).
- One active ingest session at a time; a second connection receives HTTP `409`.

## Frame layout

All integers are big-endian. The header is **10 bytes**, followed by the payload (the rest of the message).

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 1 | `kind` | See below. |
| 1 | 1 | `flags` | Bit 0 = keyframe (`video_chunk` only). Other bits reserved, send 0. |
| 2 | 4 | `dts_ms` (u32) | Decode timestamp in ms since session start, monotonic per track. |
| 6 | 4 | `cts_offset_ms` (i32) | `pts - dts` in ms. 0 for audio and for video without B-frames. |
| 10 | n | payload | Depends on kind. |

## Frame kinds

| Kind | Name | Direction | Payload |
| --- | --- | --- | --- |
| `0x01` | `start` | browser to daemon | UTF-8 JSON. Must be the first frame. |
| `0x02` | `stop` | browser to daemon | Empty. Ends the session gracefully. |
| `0x03` | `clip` | browser to daemon | JSON `{"seconds_back":30,"title":"optional"}`. The daemon writes an MPEG-TS clip from its ring buffer and answers with a `status` frame. |
| `0x10` | `video_config` | browser to daemon | `AVCDecoderConfigurationRecord` (WebCodecs decoder config description). Send before the first video chunk and whenever it changes. |
| `0x11` | `audio_config` | browser to daemon | AAC `AudioSpecificConfig`. Send before the first audio chunk. |
| `0x12` | `video_chunk` | browser to daemon | One H.264 access unit in AVCC form (4-byte NAL length prefixes). `flags` bit 0 set for IDR. |
| `0x13` | `audio_chunk` | browser to daemon | One raw AAC-LC access unit, no ADTS header. |
| `0x80` | `status` | daemon to browser | UTF-8 JSON. Never sent by the browser. |

An unknown kind is a protocol error: the daemon sends a `status` error and closes with WebSocket code 1002.

## `start` payload

```json
{
  "destinations": ["twitch", "youtube"],
  "width": 1280, "height": 720, "fps": 30,
  "video_kbps": 2500, "audio_kbps": 128,
  "sample_rate": 48000, "channels": 2
}
```

`destinations` names configured destinations; empty or absent means all. **Stream keys are never part of the protocol**; they live only in the daemon environment or config.

## `status` payloads

The `type` field discriminates; new fields may be added in minor versions.

```json
{"type":"ready","version":1}
{"type":"started","destinations":[{"name":"twitch","state":"connecting"}]}
{"type":"dest","name":"twitch","state":"live"}
{"type":"dest","name":"youtube","state":"error","error":"ConnectionRefused"}
{"type":"stats","uptime_ms":12000,"in_kbps":2610,"dropped":{"twitch":0,"youtube":3}}
{"type":"clip","ok":true,"path":"clips/2026-10-26T20-40-00_title.ts","seconds":30}
{"type":"error","message":"protocol: UnknownKind"}
```

`state` is one of `connecting`, `live`, `reconnecting`, `error`, `stopped`. `stats` arrives roughly every 2 seconds during a session. Status payloads never contain URLs with keys, or keys.

## Session sequence

1. The browser opens the WebSocket; the daemon sends `status ready`.
2. The browser sends `start`.
3. The browser sends `video_config` and `audio_config` (any order), then chunks. Video must begin with a keyframe.
4. The browser sends `stop`, or simply closes the socket.

If a destination connects late or reconnects, the daemon replays the stored configs and waits for the next keyframe. Fan-out is non-blocking: a slow destination drops frames (non-keyframes first) and never stalls the others or the ingest socket.

## Derived outputs

- **FLV over RTMPS** per destination: `onMetaData`, AVC and AAC sequence headers, then tags.
- **MPEG-TS ring buffer** for the clipper: H.264 converted from AVCC to Annex B with SPS/PPS before each IDR, AAC wrapped in ADTS, 90 kHz timestamps, PAT/PMT repeated at each keyframe.

## Daemon configuration

Environment: `KOINONIA_PORT`, `KOINONIA_TOKEN`, `KOINONIA_CONFIG` (JSON file path), `KOINONIA_CLIP_DIR`, `KOINONIA_CLIP_SECONDS` (ring size, default 300), `KOINONIA_TWITCH_URL` / `KOINONIA_TWITCH_KEY`, `KOINONIA_YOUTUBE_URL` / `KOINONIA_YOUTUBE_KEY`, and generic extras as `KOINONIA_DEST_<NAME>_URL` / `_KEY`. Environment overrides the JSON file. A destination without a key is ignored, and keys are redacted (`****`) by every log and format path in the daemon.

## Versioning

This is v1. Changes are additive: new kinds and new JSON fields. Existing offsets, kind values and flag bits will not change.
