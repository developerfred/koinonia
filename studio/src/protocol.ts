export const Kind = {
  HELLO: 1, VIDEO: 2, AUDIO: 3, CONFIG_VIDEO: 4, CONFIG_AUDIO: 5, CONTROL: 6, STATS: 7,
} as const;
export type KindValue = (typeof Kind)[keyof typeof Kind];
export const FLAG_KEY = 1;
export const HEADER_BYTES = 18;

export interface Frame {
  kind: KindValue;
  flags: number;
  seq: number;
  ptsUs: number;
  payload: Uint8Array;
}

export function encodeFrame(f: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + f.payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, f.kind);
  dv.setUint8(1, f.flags);
  dv.setUint32(2, f.seq >>> 0);
  dv.setBigInt64(6, BigInt(Math.round(f.ptsUs)));
  dv.setUint32(14, f.payload.byteLength);
  out.set(f.payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.byteLength < HEADER_BYTES) throw new Error("short frame");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = dv.getUint32(14);
  if (buf.byteLength < HEADER_BYTES + len) throw new Error("truncated payload");
  return {
    kind: dv.getUint8(0) as KindValue,
    flags: dv.getUint8(1),
    seq: dv.getUint32(2),
    ptsUs: Number(dv.getBigInt64(6)),
    payload: buf.subarray(HEADER_BYTES, HEADER_BYTES + len),
  };
}

export const jsonPayload = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
