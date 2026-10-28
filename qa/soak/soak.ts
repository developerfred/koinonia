#!/usr/bin/env tsx
// Soak / load test for koinonia-d. Usage:
//   tsx soak/soak.ts [--profile smoke|full] [--seconds N] [--rate realtime|max] [--slow-bps N] [--reconnect-every N] [--video-bytes N]
// Profiles: smoke (CI, ~12 s, realtime, one slow sink, one reconnecting sink) and full (10 min, 4x bitrate).
// Verdict (exit code 1 on failure): daemon alive, fast sink got >= 95% of frames with valid FLV structure, slow sink did not stall the
// fast one, dropped destination reconnected with sequence headers replayed, RSS growth below limit, no protocol errors on the sinks.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { RtmpSink, analyzeTags } from "../lib/rtmp-sink";
import { startDaemon, probeDaemon } from "../lib/daemon-proc";
import { openStudio, goldenSession, mediaFrames, mk } from "../lib/ws-studio";
import { QA } from "../lib/env";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const profile = arg("profile", "smoke")!;
const P = profile === "full"
  ? { seconds: 600, videoBytes: 24_000, slowBps: 60_000, reconnectEvery: 3000, rssGrowthMb: 64, minFast: 0.95 }
  : { seconds: 12, videoBytes: 6_000, slowBps: 40_000, reconnectEvery: 400, rssGrowthMb: 48, minFast: 0.9 };
const seconds = Number(arg("seconds", String(P.seconds)));
const realtime = arg("rate", "realtime") === "realtime";
const slowBps = Number(arg("slow-bps", String(P.slowBps)));
const reconnectEvery = Number(arg("reconnect-every", String(P.reconnectEvery)));
const videoBytes = Number(arg("video-bytes", String(P.videoBytes)));

const probe = await probeDaemon();
if (!probe.ok) { console.log(`[soak] SKIPPED: ${probe.reason}`); process.exit(process.env.QA_REQUIRE_DAEMON ? 1 : 0); }

const rss = (pid: number) => { try { return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024; } catch { return NaN; } };
const fast = await new RtmpSink().listen();
const slow = await new RtmpSink({ bytesPerSec: slowBps }).listen();
const flaky = await new RtmpSink({ dropAfterTags: reconnectEvery }).listen();
const daemon = await startDaemon({ sinks: { twitch: fast, youtube: slow, flaky }, keys: { twitch: "k1", youtube: "k2", flaky: "k3" } });
const failures: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); };

try {
  const studio = await openStudio(daemon.wsUrl());
  await studio.waitStatus((s) => s.type === "ready");
  const gs = goldenSession();
  studio.send(mk(0x01, 0, 0, 0, Buffer.from(JSON.stringify({ width: 1280, height: 720, fps: 30 })))); // no destinations => all configured
  for (const s of [fast, slow, flaky]) await s.waitFor(() => s.sessions.some((x) => x.streamKey), 10000, "publish accepted");
  studio.send(gs[1]!.bytes); studio.send(gs[2]!.bytes);

  const samples: number[] = [];
  const sampler = setInterval(() => samples.push(rss(daemon.proc.pid!)), 1000);
  let frames = 0, bytes = 0, maxBuffered = 0;
  const t0 = Date.now();
  for (const f of mediaFrames(seconds, { videoBytes })) {
    studio.send(f); frames++; bytes += f.length;
    maxBuffered = Math.max(maxBuffered, studio.ws.bufferedAmount);
    if (realtime) {
      // pace to wall clock using the frame's dts
      const dts = new DataView(f.buffer, f.byteOffset).getUint32(2);
      const wait = dts - (Date.now() - t0);
      if (wait > 4) await new Promise((r) => setTimeout(r, wait));
    } else if (studio.ws.bufferedAmount > 8e6) await new Promise((r) => setTimeout(r, 5));
  }
  const elapsed = (Date.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, 1500));
  clearInterval(sampler);

  const media = (s: RtmpSink) => s.tags.filter((t) => t.type !== 18).length;
  const a = analyzeTags(fast.tags);
  console.log(`[soak] sent ${frames} frames (${(bytes / 1e6).toFixed(1)} MB) in ${elapsed.toFixed(1)} s; fast=${media(fast)} slow=${media(slow)} flaky=${media(flaky)} sessions(flaky)=${flaky.sessions.length}; ws max buffered ${(maxBuffered / 1e3).toFixed(0)} kB`);
  check(daemon.alive(), "daemon still alive");
  check(media(fast) >= frames * P.minFast, `fast sink received >= ${P.minFast * 100}% of frames (${media(fast)}/${frames})`);
  check(a.problems.length === 0, `fast sink FLV structure valid ${a.problems.join("; ")}`);
  check(fast.sessions.every((s) => s.protocolErrors.length === 0), "no RTMP protocol errors on fast sink");
  check(media(slow) < media(fast), `slow sink shed load (dropped) instead of stalling ingest (${media(slow)} < ${media(fast)})`);
  check(elapsed < seconds * 2 + 10, `ingest was not back-pressured by the slow sink (took ${elapsed.toFixed(1)} s for ${seconds} s of media)`);
  const expectReconnects = Math.floor(media(fast) / reconnectEvery) > 1;
  if (expectReconnects) {
    check(flaky.sessions.length >= 2, `dropped destination reconnected (${flaky.sessions.length} sessions)`);
    const later = flaky.sessions.slice(1).filter((s) => s.tags.length > 3);
    const probs = later.flatMap((s) => analyzeTags(s.tags).problems.filter((p) => !/onMetaData/.test(p)).map((p) => `session ${s.id}: ${p}`));
    check(later.length > 0 && probs.length === 0, `every reconnect replays sequence headers and resumes at a keyframe ${later.length ? probs.join("; ") : "(no reconnect session received media)"}`);
  }
  const valid = samples.filter((x) => Number.isFinite(x));
  if (valid.length > 6) {
    const base = valid[Math.min(4, valid.length - 1)]!, end = valid[valid.length - 1]!;
    check(end - base < P.rssGrowthMb, `RSS growth ${(end - base).toFixed(1)} MB < ${P.rssGrowthMb} MB (start ${base.toFixed(0)} -> end ${end.toFixed(0)} MB)`);
  }
  const report = { profile, seconds, frames, bytes, elapsed, fast: media(fast), slow: media(slow), flaky: media(flaky), flakySessions: flaky.sessions.length, rssMb: valid, failures };
  mkdirSync(join(QA, ".out"), { recursive: true });
  writeFileSync(join(QA, ".out", "soak.json"), JSON.stringify(report, null, 2));
  studio.close();
} catch (e) { failures.push(String(e)); console.error(e); }
finally { await daemon.stop(); await Promise.all([fast.close(), slow.close(), flaky.close()]); }
if (failures.length) { console.error(`[soak] FAILED: ${failures.length} check(s)`); process.exit(1); }
console.log("[soak] OK");
void existsSync;
