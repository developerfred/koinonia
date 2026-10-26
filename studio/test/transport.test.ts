import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAG_KEY, Kind, decodeFrame, encodeFrame, jsonPayload } from "../src/protocol";
import { Transport } from "../src/transport";

class FakeWS {
  static OPEN = 1;
  static last: FakeWS;
  readyState = 0; binaryType = ""; bufferedAmount = 0;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null; onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWS.last = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.status({ type: "ready", version: 1 }); }); }
  send(d: Uint8Array) { this.sent.push(d); const f = decodeFrame(d); if (f.kind === Kind.START) queueMicrotask(() => this.status({ type: "started", destinations: [] })); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  status(o: unknown) { const b = encodeFrame({ kind: Kind.STATUS, flags: 0, dtsMs: 0, ctsOffsetMs: 0, payload: jsonPayload(o) }); this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }); }
}
beforeEach(() => { (globalThis as any).WebSocket = FakeWS; });
afterEach(() => { delete (globalThis as any).WebSocket; });

const START = { width: 1280, height: 720, fps: 30, video_kbps: 2500, audio_kbps: 128, sample_rate: 48000, channels: 2 };

describe("Transport", () => {
  it("waits for ready, sends START first, then media with dts/cts in the header", async () => {
    const t = new Transport("ws://x/ingest");
    const st = await t.connect(START);
    expect(st.type).toBe("started");
    const ws = FakeWS.last;
    expect(decodeFrame(ws.sent[0]!).kind).toBe(Kind.START);
    expect(JSON.parse(new TextDecoder().decode(decodeFrame(ws.sent[0]!).payload)).width).toBe(1280);
    t.send(Kind.VIDEO_CHUNK, FLAG_KEY, 1234, 0, new Uint8Array([1]));
    const f = decodeFrame(ws.sent[1]!);
    expect(f).toMatchObject({ kind: Kind.VIDEO_CHUNK, flags: FLAG_KEY, dtsMs: 1234, ctsOffsetMs: 0 });
  });
  it("rejects when the daemon answers start with an error", async () => {
    class Bad extends FakeWS { send(d: Uint8Array) { this.sent.push(d); queueMicrotask(() => this.status({ type: "error", message: "unknown destination: x" })); } }
    (globalThis as any).WebSocket = Bad;
    await expect(new Transport("ws://x").connect(START)).rejects.toThrow(/unknown destination/);
  });
  it("drops non-key media under backpressure but never keyframes or control", async () => {
    const t = new Transport("ws://x"); await t.connect(START);
    FakeWS.last.bufferedAmount = 10 * 1024 * 1024;
    expect(t.send(Kind.VIDEO_CHUNK, 0, 1, 0, new Uint8Array([1]))).toBe(false);
    expect(t.send(Kind.AUDIO_CHUNK, 0, 1, 0, new Uint8Array([1]))).toBe(false);
    expect(t.send(Kind.VIDEO_CHUNK, FLAG_KEY, 1, 0, new Uint8Array([1]))).toBe(true);
    expect(t.send(Kind.VIDEO_CONFIG, 0, 0, 0, new Uint8Array([1]))).toBe(true);
    expect(t.droppedForBackpressure).toBe(2);
  });
  it("clip() resolves with the daemon clip status", async () => {
    const t = new Transport("ws://x"); await t.connect(START);
    const p = t.clip(30, "hello");
    const req = decodeFrame(FakeWS.last.sent.at(-1)!);
    expect(req.kind).toBe(Kind.CLIP);
    expect(JSON.parse(new TextDecoder().decode(req.payload))).toEqual({ seconds_back: 30, title: "hello" });
    FakeWS.last.status({ type: "clip", ok: true, path: "clips/a.ts", seconds: 30 });
    expect(await p).toMatchObject({ ok: true, path: "clips/a.ts" });
  });
  it("forwards stats and offline clip is reported", async () => {
    const t = new Transport("ws://x"); const seen: string[] = [];
    t.onStatus = (s) => seen.push(s.type);
    await t.connect(START);
    FakeWS.last.status({ type: "stats", in_kbps: 1 });
    expect(seen).toContain("stats");
    t.close();
    expect((await t.clip(5)).message).toBe("daemon_offline");
  });
});
