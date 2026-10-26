// Validates the fake RTMP sink itself (so a daemon failure can be attributed to the daemon, not to the harness).
import { describe, it, expect, afterEach } from "vitest";
import { RtmpSink, analyzeTags } from "../lib/rtmp-sink";
import { RtmpPublisher } from "../lib/rtmp-client";
import { decodeAmf } from "../lib/amf0";
import { fixture } from "../lib/env";
import type { Golden } from "../lib/golden";

const golden = fixture<Golden>("protocol/golden.json");
let sink: RtmpSink | undefined;
afterEach(async () => { await sink?.close(); sink = undefined; });

describe("fake RTMP sink self-test", () => {
  it("handshake, connect, createStream, publish; captures FLV tags incl. big (multi-chunk) and extended-timestamp messages", async () => {
    sink = await new RtmpSink().listen();
    const pub = new RtmpPublisher("127.0.0.1", sink.port, "live", "STREAMKEY");
    await pub.connect();
    const meta = (await import("../lib/amf0")).encodeAmf(["onMetaData", { width: 1280, height: 720 }]);
    pub.tag(18, 0, meta);
    for (const v of golden.valid.filter((x) => x.flv)) pub.tag(v.flv!.tag_type as 8 | 9, v.flv!.timestamp_ms, Buffer.from(v.flv!.body, "hex"));
    pub.tag(9, 0x1000000, Buffer.alloc(10_000, 7)); // > chunk size and > 24-bit timestamp
    await sink.waitFor(() => sink!.tags.length >= golden.valid.filter((x) => x.flv).length + 2, 3000, "tags");
    const s = sink.sessions[0]!;
    expect(s.handshake).toMatchObject({ s0Ok: true, c2EchoesS1: true, c1Zero: true });
    expect(s.app).toBe("live");
    expect(s.streamKey).toBe("STREAMKEY");
    expect(s.commands.map((c) => c.name)).toEqual(["connect", "releaseStream", "FCPublish", "createStream", "publish"]);
    expect(decodeAmf(s.tags[0]!.body)[0]).toBe("onMetaData");
    const big = s.tags.at(-1)!;
    expect(big.ts).toBe(0x1000000);
    expect(big.body.length).toBe(10_000);
    expect(s.protocolErrors).toEqual([]);
    pub.end();
  });

  it("analyzeTags flags a stream missing sequence headers and accepts the golden session", () => {
    const mk = (type: 8 | 9 | 18, ts: number, hex: string) => ({ type, ts, streamId: 1, body: Buffer.from(hex, "hex"), conn: 0 });
    const bad = analyzeTags([mk(9, 0, "270100000011")]);
    expect(bad.problems.join("|")).toMatch(/onMetaData/);
    expect(bad.problems.join("|")).toMatch(/AVC sequence header/);
    const meta = { type: 18 as const, ts: 0, streamId: 1, body: (decodeAmf(Buffer.from([])), Buffer.from([2, 0, 10, ...Buffer.from("onMetaData"), 5])), conn: 0 };
    const good = analyzeTags([meta, ...golden.valid.filter((v) => v.flv).map((v) => mk(v.flv!.tag_type as 8 | 9, v.flv!.timestamp_ms, v.flv!.body))]);
    expect(good.problems).toEqual([]);
  });

  it("can reject publish and drop the connection after N tags", async () => {
    sink = await new RtmpSink({ rejectPublish: true }).listen();
    await expect(new RtmpPublisher("127.0.0.1", sink.port).connect()).rejects.toThrow(/rejected/);
  });
});
