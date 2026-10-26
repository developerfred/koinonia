import { describe, expect, it } from "vitest";
import { FLAG_KEY, HEADER_BYTES, Kind, decodeFrame, encodeFrame, jsonPayload, parseJsonPayload } from "../src/protocol";

describe("protocol (daemon/PROTOCOL.md v1)", () => {
  it("uses a 10-byte header", () => expect(HEADER_BYTES).toBe(10));

  it("matches the documented byte layout exactly", () => {
    const b = encodeFrame({ kind: Kind.VIDEO_CHUNK, flags: FLAG_KEY, dtsMs: 0x01020304, ctsOffsetMs: -2, payload: new Uint8Array([9, 8]) });
    expect([...b]).toEqual([0x12, 1, 1, 2, 3, 4, 0xff, 0xff, 0xff, 0xfe, 9, 8]);
  });

  it("kind values", () => {
    expect([Kind.START, Kind.STOP, Kind.CLIP, Kind.VIDEO_CONFIG, Kind.AUDIO_CONFIG, Kind.VIDEO_CHUNK, Kind.AUDIO_CHUNK, Kind.STATUS])
      .toEqual([1, 2, 3, 0x10, 0x11, 0x12, 0x13, 0x80]);
  });

  it("roundtrips including negative cts and empty payload", () => {
    const f = decodeFrame(encodeFrame({ kind: Kind.AUDIO_CHUNK, flags: 0, dtsMs: 4_000_000_000, ctsOffsetMs: -5, payload: new Uint8Array([1, 2, 3]) }));
    expect(f).toMatchObject({ kind: Kind.AUDIO_CHUNK, flags: 0, dtsMs: 4_000_000_000, ctsOffsetMs: -5 });
    expect([...f.payload]).toEqual([1, 2, 3]);
    expect(decodeFrame(encodeFrame({ kind: Kind.STOP, flags: 0, dtsMs: 0, ctsOffsetMs: 0, payload: new Uint8Array(0) })).payload.length).toBe(0);
  });

  it("rejects truncated and unknown kinds", () => {
    expect(() => decodeFrame(new Uint8Array(9))).toThrow("Truncated");
    const b = encodeFrame({ kind: Kind.STOP, flags: 0, dtsMs: 0, ctsOffsetMs: 0, payload: new Uint8Array(0) });
    b[0] = 0x55;
    expect(() => decodeFrame(b)).toThrow("UnknownKind");
  });

  it("json payload helpers", () => {
    expect(parseJsonPayload(jsonPayload({ type: "ready", version: 1 }))).toEqual({ type: "ready", version: 1 });
    expect(parseJsonPayload(new Uint8Array([0xff]))).toBeNull();
  });
});
