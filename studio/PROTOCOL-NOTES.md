# Studio -> daemon wire framing (draft; daemon/PROTOCOL.md did not exist)

Binary WebSocket messages, big-endian. If daemon/PROTOCOL.md appears, reconcile;
only `src/protocol.ts` needs to change.

Header (18 bytes) + payload:

| off | size | field                                   |
|-----|------|-----------------------------------------|
| 0   | 1    | kind                                    |
| 1   | 1    | flags (bit0 = keyframe)                 |
| 2   | 4    | seq (u32, per-connection, wraps)        |
| 6   | 8    | pts in microseconds (i64)               |
| 14  | 4    | payload length (u32)                    |

Kinds: 0x01 HELLO (JSON: version, video/audio config), 0x02 VIDEO (H.264 AVCC
access unit; avcC extradata sent once as CONFIG_VIDEO), 0x03 AUDIO (raw AAC
frame; ASC sent as CONFIG_AUDIO), 0x04 CONFIG_VIDEO, 0x05 CONFIG_AUDIO,
0x06 CONTROL (JSON, studio->daemon: start/stop/mark_highlight/export_clip),
0x07 STATS (JSON, daemon->studio: kbps, dropped).

Daemon muxes FLV (RTMPS) and MPEG-TS (clip buffer) from these; no reencode.
