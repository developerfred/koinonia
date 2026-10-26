// Minimal AMF0 codec (enough for RTMP connect/createStream/publish/onStatus and onMetaData).
export type Amf = number | boolean | string | null | AmfObj | Amf[];
export interface AmfObj { [k: string]: Amf }

export function encodeAmf(vals: Amf[]): Buffer {
  const parts: Buffer[] = [];
  const w = (v: Amf): void => {
    if (v === null) parts.push(Buffer.from([5]));
    else if (typeof v === "number") { const b = Buffer.alloc(9); b[0] = 0; b.writeDoubleBE(v, 1); parts.push(b); }
    else if (typeof v === "boolean") parts.push(Buffer.from([1, v ? 1 : 0]));
    else if (typeof v === "string") { const s = Buffer.from(v); const h = Buffer.alloc(3); h[0] = 2; h.writeUInt16BE(s.length, 1); parts.push(h, s); }
    else if (Array.isArray(v)) { const h = Buffer.alloc(5); h[0] = 10; h.writeUInt32BE(v.length, 1); parts.push(h); v.forEach(w); }
    else {
      parts.push(Buffer.from([3]));
      for (const [k, x] of Object.entries(v)) { const kb = Buffer.from(k); const h = Buffer.alloc(2); h.writeUInt16BE(kb.length); parts.push(h, kb); w(x); }
      parts.push(Buffer.from([0, 0, 9]));
    }
  };
  vals.forEach(w);
  return Buffer.concat(parts);
}

export function decodeAmf(buf: Buffer): Amf[] {
  let o = 0;
  const str = (): string => { const n = buf.readUInt16BE(o); o += 2; const s = buf.toString("utf8", o, o + n); o += n; return s; };
  const props = (): AmfObj => {
    const r: AmfObj = {};
    for (;;) {
      if (buf[o] === 0 && buf[o + 1] === 0 && buf[o + 2] === 9) { o += 3; return r; }
      const k = str(); r[k] = val();
    }
  };
  const val = (): Amf => {
    const t = buf[o++];
    switch (t) {
      case 0: { const n = buf.readDoubleBE(o); o += 8; return n; }
      case 1: return buf[o++] !== 0;
      case 2: return str();
      case 3: return props();
      case 5: case 6: return null;
      case 8: o += 4; return props();
      case 10: { const n = buf.readUInt32BE(o); o += 4; return Array.from({ length: n }, val); }
      default: throw new Error(`unsupported AMF0 marker ${t} at ${o - 1}`);
    }
  };
  const out: Amf[] = [];
  while (o < buf.length) out.push(val());
  return out;
}
