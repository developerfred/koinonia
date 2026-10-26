// Independent reference codec for the browser->daemon framing. Intentionally imports NOTHING from studio/ or daemon/.
export interface GoldenValid { name: string; bytes: string; kind: number; flags: number; dts_ms: number; cts_offset_ms: number; payload: string; flv: null | { tag_type: number; timestamp_ms: number; body: string } }
export interface Golden { header_len: number; kinds: Record<string, number>; flag_keyframe: number; valid: GoldenValid[]; invalid: { name: string; bytes: string; error: string }[]; start_json: Record<string, unknown> }
export interface RefFrame { kind: number; flags: number; dts_ms: number; cts_offset_ms: number; payload: Uint8Array }

export const HEADER_LEN = 10;
const BROWSER_KINDS = new Set([0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13]);
const NEEDS_PAYLOAD = new Set([0x01, 0x03, 0x10, 0x11, 0x12, 0x13]);

export function decode(b: Uint8Array): RefFrame {
  if (b.length < HEADER_LEN) throw new Error("Truncated");
  if (!BROWSER_KINDS.has(b[0]!)) throw new Error("UnknownKind");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const payload = b.subarray(HEADER_LEN);
  if (NEEDS_PAYLOAD.has(b[0]!) && payload.length === 0) throw new Error("BadPayload");
  return { kind: b[0]!, flags: b[1]!, dts_ms: dv.getUint32(2), cts_offset_ms: dv.getInt32(6), payload };
}

export function encode(f: RefFrame): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + f.payload.length);
  const dv = new DataView(out.buffer);
  out[0] = f.kind; out[1] = f.flags; dv.setUint32(2, f.dts_ms); dv.setInt32(6, f.cts_offset_ms);
  out.set(f.payload, HEADER_LEN);
  return out;
}
