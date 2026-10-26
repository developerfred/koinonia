// Property/fuzz tests for the studio's own framing code (decodeFrame must fail closed on hostile bytes).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { existsSync } from "node:fs";
import { P } from "../lib/env";

const has = existsSync(`${P.studio}/src/protocol.ts`);
describe.runIf(has)("studio protocol fuzz", async () => {
  const proto: any = has ? await import("../../studio/src/protocol") : {};

  it("decodeFrame(random bytes) either returns a frame or throws Error (never crashes / hangs)", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
      try { const f = proto.decodeFrame(bytes); expect(f.payload.byteLength).toBeLessThanOrEqual(bytes.byteLength); }
      catch (e) { expect(e).toBeInstanceOf(Error); }
    }), { numRuns: 5000, seed: 20261026 });
  });

  it("decodeFrame(mutated valid frame) never reads out of bounds", () => {
    const base = proto.encodeFrame({ kind: proto.Kind.VIDEO_CHUNK ?? proto.Kind.VIDEO, flags: 1, seq: 1, ptsUs: 1000, dtsMs: 1, dts_ms: 1, ctsOffsetMs: 0, cts_offset_ms: 0, payload: new Uint8Array(50).fill(7) });
    fc.assert(fc.property(fc.nat(base.length - 1), fc.integer({ min: 0, max: 255 }), fc.nat(base.length), (i, v, cut) => {
      const m = Uint8Array.from(base); m[i] = v;
      try { const f = proto.decodeFrame(m.subarray(0, cut)); expect(f.payload.byteLength).toBeLessThanOrEqual(cut); } catch (e) { expect(e).toBeInstanceOf(Error); }
    }), { numRuns: 3000, seed: 7 });
  });

  it("encodeFrame -> decodeFrame is identity for flags/payload across random frames", () => {
    const kinds = Object.values(proto.Kind) as number[];
    fc.assert(fc.property(fc.constantFrom(...kinds), fc.integer({ min: 0, max: 255 }), fc.uint8Array({ maxLength: 200 }), (kind, flags, payload) => {
      const g = proto.decodeFrame(proto.encodeFrame({ kind, flags, seq: 3, ptsUs: 5, dtsMs: 5, dts_ms: 5, ctsOffsetMs: 0, cts_offset_ms: 0, payload }));
      expect(g.kind).toBe(kind); expect(g.flags).toBe(flags); expect(Array.from(g.payload)).toEqual(Array.from(payload));
    }), { numRuns: 2000, seed: 99 });
  });
});
