// Integration: koinonia-d (black box) <-> fake studio (WebSocket) <-> two fake RTMP sinks.
// Skipped with a reason while the daemon binary is missing / does not listen yet.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { RtmpSink, analyzeTags } from "../lib/rtmp-sink";
import { startDaemon, probeDaemon } from "../lib/daemon-proc";
import { openStudio, goldenSession, mk, mediaFrames } from "../lib/ws-studio";
import { fixture } from "../lib/env";
import type { Golden } from "../lib/golden";

const golden = fixture<Golden>("protocol/golden.json");
const probe = await probeDaemon();
if (!probe.ok) console.warn(`[qa] SKIP daemon integration: ${probe.reason}`);
const d = describe.skipIf(!probe.ok);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c().catch(() => {}); });

async function rig(sinkOpts: { twitch?: ConstructorParameters<typeof RtmpSink>[0]; youtube?: ConstructorParameters<typeof RtmpSink>[0] } = {}, envExtra: Record<string, string> = {}) {
  const twitch = await new RtmpSink(sinkOpts.twitch).listen();
  const youtube = await new RtmpSink(sinkOpts.youtube).listen();
  const daemon = await startDaemon({ sinks: { twitch, youtube }, keys: { twitch: "live_twitchKEY123", youtube: "yt-KEY-456" }, env: envExtra });
  cleanup.push(async () => { await daemon.stop(); await twitch.close(); await youtube.close(); });
  return { twitch, youtube, daemon };
}
/** Send `start`, wait until every expected sink has accepted a publish, then return (frames sent earlier would be dropped by design). */
async function begin(studio: Awaited<ReturnType<typeof openStudio>>, sinks: RtmpSink[], start: Uint8Array) {
  studio.send(start);
  for (const s of sinks) await s.waitFor(() => s.sessions.some((x) => x.streamKey !== undefined), 8000, "publish accepted");
}
const bodies = (s: RtmpSink) => s.tags.filter((t) => t.type !== 18).map((t) => `${t.type}:${t.ts}:${t.body.toString("hex")}`);

d("daemon -> RTMP sinks", () => {
  beforeAll(() => { expect(probe.ok).toBe(true); });

  it("handshake, publish with configured key, onMetaData + sequence headers + golden FLV tags on BOTH destinations", async () => {
    const { twitch, youtube, daemon } = await rig();
    const studio = await openStudio(daemon.wsUrl());
    await studio.waitStatus((s) => s.type === "ready", 3000, "ready");
    const gs = goldenSession();
    await begin(studio, [twitch, youtube], gs[0]!.bytes);
    for (const f of gs.slice(1)) studio.send(f.bytes);
    const expected = golden.valid.filter((v) => v.flv);
    for (const sink of [twitch, youtube]) await sink.waitFor(() => sink.tags.filter((t) => t.type !== 18).length >= expected.length, 5000, "golden tags");

    for (const [sink, key] of [[twitch, "live_twitchKEY123"], [youtube, "yt-KEY-456"]] as const) {
      const s = sink.sessions[0]!;
      expect(s.handshake).toMatchObject({ s0Ok: true, c2EchoesS1: true });
      expect(s.app).toBe("app");
      expect(s.streamKey).toBe(key);
      expect(s.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["connect", "createStream", "publish"]));
      expect(s.protocolErrors).toEqual([]);
      const a = analyzeTags(sink.tags);
      expect(a.problems).toEqual([]);
      const got = sink.tags.filter((t) => t.type !== 18);
      expect(got.map((t) => `${t.type}:${t.ts}:${t.body.toString("hex")}`)).toEqual(expected.map((v) => `${v.flv!.tag_type}:${v.flv!.timestamp_ms}:${v.flv!.body}`));
    }
    // fan-out: identical media on both
    expect(bodies(twitch)).toEqual(bodies(youtube));
    studio.send(mk(0x02, 0, 100, 0, new Uint8Array()));
    studio.close();
  });

  it("respects start.destinations (only twitch)", async () => {
    const { twitch, youtube, daemon } = await rig();
    const studio = await openStudio(daemon.wsUrl());
    await studio.waitStatus((s) => s.type === "ready");
    const sess = goldenSession();
    const start = mk(0x01, 0, 0, 0, Buffer.from(JSON.stringify({ destinations: ["twitch"] })));
    await begin(studio, [twitch], start); sess.slice(1).forEach((f) => studio.send(f.bytes));
    await twitch.waitFor(() => twitch.tags.length > 4, 5000, "twitch tags");
    await new Promise((r) => setTimeout(r, 300));
    expect(youtube.sessions.length).toBe(0);
    studio.close();
  });

  it("unknown destination name yields a status error", async () => {
    const { daemon } = await rig();
    const studio = await openStudio(daemon.wsUrl());
    await studio.waitStatus((s) => s.type === "ready");
    studio.send(mk(0x01, 0, 0, 0, Buffer.from(JSON.stringify({ destinations: ["nope"] }))));
    await studio.waitStatus((s) => s.type === "error" || (s.type === "dest" && s.state === "error"), 3000, "error status");
    studio.close();
  });

  it("slow destination does not stall the other (non-blocking fan-out)", async () => {
    const { twitch, youtube, daemon } = await rig({ youtube: { bytesPerSec: 20_000 } });
    const studio = await openStudio(daemon.wsUrl());
    await studio.waitStatus((s) => s.type === "ready");
    const [start, vcfg, acfg] = goldenSession();
    await begin(studio, [twitch, youtube], start!.bytes); [vcfg, acfg].forEach((f) => studio.send(f!.bytes));
    const t0 = Date.now(); let frames = 0;
    for (const f of mediaFrames(6)) { studio.send(f); frames++; }
    await twitch.waitFor(() => twitch.tags.filter((t) => t.type !== 18).length >= frames * 0.95, 8000, "fast sink receives ~all frames");
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(analyzeTags(twitch.tags).problems).toEqual([]);
    expect(youtube.tags.filter((t) => t.type !== 18).length).toBeLessThan(twitch.tags.filter((t) => t.type !== 18).length); // slow one dropped frames
    expect(daemon.alive()).toBe(true);
    studio.close();
  });

  it("reconnects a dropped destination: replays configs and resumes at a keyframe", async () => {
    const { youtube, daemon } = await rig({ youtube: { dropAfterTags: 40 } });
    const studio = await openStudio(daemon.wsUrl());
    await studio.waitStatus((s) => s.type === "ready");
    const [start, vcfg, acfg] = goldenSession();
    await begin(studio, [youtube], start!.bytes); [vcfg, acfg].forEach((f) => studio.send(f!.bytes));
    const it = mediaFrames(12);
    const pump = (async () => { for (const f of it) { studio.send(f); await new Promise((r) => setTimeout(r, 2)); } })();
    await youtube.waitFor(() => youtube.sessions.length >= 2 && youtube.sessions[1]!.tags.length > 5, 20000, "second youtube session");
    await pump;
    const second = youtube.sessions[1]!;
    const a = analyzeTags(second.tags);
    expect(a.problems.filter((p) => !/onMetaData/.test(p))).toEqual([]);
    studio.close();
  });
});

d("daemon ingest socket contract (PROTOCOL.md)", () => {
  it("second concurrent session is rejected with HTTP 409", async () => {
    const { daemon } = await rig();
    const a = await openStudio(daemon.wsUrl());
    await a.waitStatus((s) => s.type === "ready");
    await expect(openStudio(daemon.wsUrl())).rejects.toMatchObject({ statusCode: 409 });
    a.close();
  });

  it("unknown kind -> status error then close 1002", async () => {
    const { daemon } = await rig();
    const s = await openStudio(daemon.wsUrl());
    await s.waitStatus((x) => x.type === "ready");
    s.send(Uint8Array.from([0x77, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
    expect((await s.closed).code).toBe(1002);
    expect(daemon.alive()).toBe(true);
  });

  it("text message -> close 1003", async () => {
    const { daemon } = await rig();
    const s = await openStudio(daemon.wsUrl());
    await s.waitStatus((x) => x.type === "ready");
    s.ws.send("hello");
    expect((await s.closed).code).toBe(1003);
  });

  it("KOINONIA_TOKEN: missing/wrong token -> 403, correct token accepted", async () => {
    const { daemon } = await rig({}, { KOINONIA_TOKEN: "s3cret" });
    await expect(openStudio(daemon.wsUrl("/ingest"))).rejects.toMatchObject({ statusCode: 403 });
    await expect(openStudio(daemon.wsUrl("/ingest?token=wrong"))).rejects.toMatchObject({ statusCode: 403 });
    const ok = await openStudio(daemon.wsUrl("/ingest?token=s3cret"));
    await ok.waitStatus((x) => x.type === "ready");
    ok.close();
  });

  it("foreign Origin is rejected", async () => {
    const { daemon } = await rig();
    await expect(openStudio(daemon.wsUrl(), { Origin: "https://evil.example" })).rejects.toBeDefined();
    const ok = await openStudio(daemon.wsUrl(), { Origin: "http://localhost:5173" });
    ok.close();
  });
});
