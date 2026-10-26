// Contract: both ends of the browser->daemon wire must conform to the SAME golden frames
// (qa/fixtures/protocol/golden.json, normative source: daemon/PROTOCOL.md + daemon/src/framing.zig).
//   - this file: golden self-consistency (reference codec) + the studio side
//   - qa/zig/conformance.zig: the daemon side (daemon's real parser, run via `make qa-zig`)
//   - integration/daemon-publish.test.ts: the daemon as a black box over WebSocket
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, P, ready } from "../lib/env";
import { decode, encode, type Golden } from "../lib/golden";

const golden = fixture<Golden>("protocol/golden.json");
const h2b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("golden fixtures (reference codec)", () => {
  for (const v of golden.valid) {
    it(`decodes ${v.name}`, () => {
      const f = decode(h2b(v.bytes));
      expect(f).toMatchObject({ kind: v.kind, flags: v.flags, dts_ms: v.dts_ms, cts_offset_ms: v.cts_offset_ms });
      expect(Buffer.from(f.payload).toString("hex")).toBe(v.payload);
    });
    it(`re-encodes ${v.name} byte-identically`, () => {
      const f = decode(h2b(v.bytes));
      expect(Buffer.from(encode(f)).toString("hex")).toBe(v.bytes);
    });
  }
  for (const v of golden.invalid) {
    it(`rejects ${v.name} with ${v.error}`, () => {
      expect(() => decode(h2b(v.bytes))).toThrow(v.error);
    });
  }
  it("covers every browser-sendable kind", () => {
    const seen = new Set(golden.valid.map((v) => v.kind));
    for (const [name, k] of Object.entries(golden.kinds)) if (name !== "status") expect(seen.has(k), name).toBe(true);
  });
});

describe("PROTOCOL.md presence", () => {
  it("daemon/PROTOCOL.md exists (referenced by build.zig.zon .paths)", () => {
    if (!ready.protocolMd()) throw new Error("daemon/PROTOCOL.md is missing; framing has no normative document");
  });
  it.runIf(ready.protocolMd())("PROTOCOL.md mentions every kind byte and the header length", () => {
    const md = readFileSync(join(P.daemon, "PROTOCOL.md"), "utf8").toLowerCase();
    for (const k of Object.values(golden.kinds)) expect(md, `kind 0x${k.toString(16)}`).toMatch(new RegExp(`0x0*${k.toString(16)}\\b`));
    expect(md).toContain(String(golden.header_len));
  });
});

describe.runIf(existsSync(join(P.studio, "src", "protocol.ts")))("studio framing vs golden", async () => {
  const studio: any = await import("../../studio/src/protocol");

  it("HEADER_BYTES equals daemon header_len", () => {
    expect(studio.HEADER_BYTES).toBe(golden.header_len);
  });

  it("Kind constants match daemon kind bytes", () => {
    // Accepted studio names per daemon kind (studio may rename; update the alias table, not the golden).
    const alias: Record<string, string[]> = {
      start: ["START", "HELLO"], stop: ["STOP"], clip: ["CLIP", "EXPORT_CLIP"], video_config: ["VIDEO_CONFIG", "CONFIG_VIDEO"],
      audio_config: ["AUDIO_CONFIG", "CONFIG_AUDIO"], video_chunk: ["VIDEO_CHUNK", "VIDEO"], audio_chunk: ["AUDIO_CHUNK", "AUDIO"],
    };
    for (const [dk, names] of Object.entries(alias)) {
      const sn = names.find((n) => n in studio.Kind);
      expect(sn, `studio Kind has none of ${names.join("/")}`).toBeDefined();
      expect(studio.Kind[sn!], `${dk} -> ${sn}`).toBe(golden.kinds[dk]);
    }
  });

  it("studio decode+encode round-trips every golden frame", () => {
    for (const v of golden.valid) {
      const bytes = h2b(v.bytes);
      const f = studio.decodeFrame(bytes);
      const again = studio.encodeFrame(f);
      expect(Buffer.from(again).toString("hex"), v.name).toBe(v.bytes);
    }
  });

  it("studio decodeFrame rejects the golden Truncated/UnknownKind frames with an Error", () => {
    for (const v of golden.invalid.filter((i) => (i.error === "Truncated" || i.error === "UnknownKind") && !i.name.includes("status"))) { // studio legitimately DECODES daemon status frames (0x80)
      expect(() => studio.decodeFrame(h2b(v.bytes)), v.name).toThrow(Error);
    }
  });

  it("studio encodeFrame builds golden bytes from golden fields (field names adapt: dtsMs|dts_ms)", () => {
    for (const v of golden.valid) {
      const f = { kind: v.kind, flags: v.flags, dtsMs: v.dts_ms, dts_ms: v.dts_ms, ctsOffsetMs: v.cts_offset_ms, cts_offset_ms: v.cts_offset_ms, payload: h2b(v.payload) };
      expect(Buffer.from(studio.encodeFrame(f)).toString("hex"), v.name).toBe(v.bytes);
    }
  });
});
