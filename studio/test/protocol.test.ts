import { describe, expect, it } from "vitest";
import { FLAG_KEY, HEADER_BYTES, Kind, decodeFrame, encodeFrame } from "../src/protocol";

describe("protocol", () => {
  it("roundtrips", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const b = encodeFrame({ kind: Kind.VIDEO, flags: FLAG_KEY, seq: 7, ptsUs: 1_234_567, payload });
    expect(b.length).toBe(HEADER_BYTES + 3);
    const f = decodeFrame(b);
    expect(f).toMatchObject({ kind: Kind.VIDEO, flags: FLAG_KEY, seq: 7, ptsUs: 1_234_567 });
    expect([...f.payload]).toEqual([1, 2, 3]);
  });
  it("rejects bad input", () => {
    expect(() => decodeFrame(new Uint8Array(3))).toThrow();
    const b = encodeFrame({ kind: Kind.AUDIO, flags: 0, seq: 0, ptsUs: 0, payload: new Uint8Array(5) });
    expect(() => decodeFrame(b.subarray(0, b.length - 1))).toThrow();
  });
});
