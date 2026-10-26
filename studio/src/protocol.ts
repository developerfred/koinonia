/**
 * Wire framing for the koinonia-d ingest socket. Contract: daemon/PROTOCOL.md (v1).
 * 10-byte big-endian header + payload; one WebSocket binary message == one frame.
 */
export const Kind = {
  START: 0x01,
  STOP: 0x02,
  CLIP: 0x03,
  VIDEO_CONFIG: 0x10,
  AUDIO_CONFIG: 0x11,
  VIDEO_CHUNK: 0x12,
  AUDIO_CHUNK: 0x13,
  STATUS: 0x80,
} as const;
export type KindValue = (typeof Kind)[keyof typeof Kind];
export const FLAG_KEY = 1;
export const HEADER_BYTES = 10;
export const PROTOCOL_VERSION = 1;

export interface Frame {
  kind: KindValue;
  flags: number;
  /** decode timestamp, ms since session start (u32) */
  dtsMs: number;
  /** pts - dts in ms (i32); 0 for audio and B-frame-less video */
  ctsOffsetMs: number;
  payload: Uint8Array;
}

const KINDS = new Set<number>(Object.values(Kind));

export function encodeFrame(f: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + f.payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, f.kind);
  dv.setUint8(1, f.flags);
  dv.setUint32(2, Math.max(0, Math.round(f.dtsMs)) >>> 0);
  dv.setInt32(6, Math.round(f.ctsOffsetMs) | 0);
  out.set(f.payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.byteLength < HEADER_BYTES) throw new Error("Truncated");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = dv.getUint8(0);
  if (!KINDS.has(kind)) throw new Error("UnknownKind");
  return {
    kind: kind as KindValue,
    flags: dv.getUint8(1),
    dtsMs: dv.getUint32(2),
    ctsOffsetMs: dv.getInt32(6),
    payload: buf.subarray(HEADER_BYTES),
  };
}

export const jsonPayload = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
export const parseJsonPayload = (p: Uint8Array): Record<string, unknown> | null => {
  try { const v = JSON.parse(new TextDecoder().decode(p)); return v && typeof v === "object" ? v : null; } catch { return null; }
};
