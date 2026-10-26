// Security: stream keys must never reach logs, status frames, or error values (PROTOCOL.md: "Keys are redacted by every log/format path").
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { RtmpSink } from "../lib/rtmp-sink";
import { startDaemon, probeDaemon } from "../lib/daemon-proc";
import { openStudio, goldenSession, mediaFrames, mk } from "../lib/ws-studio";
import { P, listFiles, ready } from "../lib/env";

const probe = await probeDaemon();
if (!probe.ok) console.warn(`[qa] SKIP stream-key log test: ${probe.reason}`);
const KEYS = { twitch: "live_9988776655_ZzTopSecretKeyAAA", youtube: "abcd-efgh-ijkl-mnop-QQQsecret" };
const TOKEN = "tok_SuperSecretIngestToken";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c().catch(() => {}); });

describe.skipIf(!probe.ok)("runtime: stream keys never appear in daemon output", () => {
  const scenario = async (name: string, sinkOpts: { twitch?: any; youtube?: any }, closeEarly = false) => {
    const twitch = await new RtmpSink(sinkOpts.twitch).listen();
    const youtube = await new RtmpSink(sinkOpts.youtube).listen();
    const daemon = await startDaemon({ sinks: { twitch, youtube }, keys: KEYS, token: TOKEN, env: { RUST_LOG: "", KOINONIA_LOG: "debug", KOINONIA_LOG_LEVEL: "debug", ZIG_LOG: "debug" } });
    cleanup.push(async () => { await daemon.stop(); await twitch.close(); await youtube.close(); });
    const studio = await openStudio(daemon.wsUrl(`/ingest?token=${TOKEN}`));
    await studio.waitStatus((s) => s.type === "ready");
    const gs = goldenSession();
    studio.send(gs[0]!.bytes);
    await new Promise((r) => setTimeout(r, 800)); // let destinations connect
    for (const f of gs.slice(1)) studio.send(f.bytes);
    for (const f of mediaFrames(2)) studio.send(f);
    await new Promise((r) => setTimeout(r, 600));
    if (closeEarly) await twitch.close(); // destination vanishes mid-stream -> error/reconnect log paths
    await new Promise((r) => setTimeout(r, 600));
    studio.send(mk(0x02, 0, 5000, 0, new Uint8Array()));
    await new Promise((r) => setTimeout(r, 300));
    studio.close();
    await new Promise((r) => setTimeout(r, 200));
    const statusDump = JSON.stringify(studio.status);
    return { log: daemon.log(), statusDump, name };
  };
  const forbidden = [...Object.values(KEYS), TOKEN];

  for (const [name, opts, early] of [
    ["healthy publish", {}, false],
    ["destination rejects publish", { twitch: { rejectPublish: true } }, false],
    ["destination vanishes mid-stream", {}, true],
  ] as const) {
    it(`${name}: no key/token in stdout/stderr or status frames`, async () => {
      const r = await scenario(name, opts, early);
      for (const secret of forbidden) {
        expect(r.log, `secret leaked in daemon log (${name})`).not.toContain(secret);
        expect(r.statusDump, `secret leaked in status frame (${name})`).not.toContain(secret);
      }
      // URL-with-key forms and common encodings
      for (const secret of forbidden) {
        expect(r.log).not.toContain(encodeURIComponent(secret));
        expect(r.log).not.toContain(Buffer.from(secret).toString("hex"));
        expect(r.log).not.toContain(Buffer.from(secret).toString("base64"));
      }
    });
  }
});

// Static heuristic: log/print statements in daemon sources that format something named key/token without redaction.
describe.runIf(ready.daemonSources())("static: daemon sources do not format keys into logs", () => {
  it("no print/log call interpolates a key/token identifier unredacted", () => {
    const offenders: string[] = [];
    for (const f of listFiles(`${P.daemon}/src`, [".zig"])) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|test\b)/.test(line)) return;
        const isLog = /(std\.log\.|\blog\.(err|warn|info|debug)\b|debug\.print|\.print\(|std\.log\.scoped)/.test(line);
        if (!isLog) return;
        const keyish = /\b(key|stream_key|token|secret)\b|\.(key|token|secret)\b/i.test(line);
        const reveals = /\.reveal\(/.test(line);
        // `{f}` on a Secret-typed value uses its redacting format(); anything else touching a key in a log call is suspect.
        if (reveals || (keyish && !/\{f\}/.test(line) && !/redact|mask|\*\*\*\*/i.test(line))) offenders.push(`${f.replace(P.daemon + "/", "daemon/")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "log statements that may leak secrets:\n" + offenders.join("\n")).toEqual([]);
  });
});
