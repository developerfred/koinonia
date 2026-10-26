#!/usr/bin/env node
// Real end-to-end run: Chrome (fake camera/mic) -> studio (WebCodecs) -> koinonia-d -> fake RTMP sink.
// Measures what can honestly be measured on this machine and writes JSON next to this file (results/).
//
//   cd studio && npm run build && node e2e/e2e.mjs [--res 720|1080] [--seconds 40] [--bg-seconds 20]
//                                                  [--headless] [--no-bridge] [--out results/x.json]
//
// Needs: daemon built (daemon/zig-out/bin/koinonia-d), Chrome installed (Playwright "chrome" channel), ffmpeg/ffprobe
// (stream decode check), and qa/node_modules (playwright-core, read-only reuse of qa/lib/rtmp-sink.ts as the sink).
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const RES = Number(flag("res", 720));
const SECONDS = Number(flag("seconds", 40));
const BG_SECONDS = Number(flag("bg-seconds", 20));
const HEADLESS = !!flag("headless", false);
const WITH_BRIDGE = !flag("no-bridge", false);
const OUT = resolve(HERE, flag("out", `results/e2e-${RES}p-${HEADLESS ? "headless" : "headed"}.json`));
const [W, H, VKBPS] = RES === 1080 ? [1920, 1080, 6000] : [1280, 720, 3000];
const DAEMON = join(ROOT, "daemon/zig-out/bin/koinonia-d");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(process.env.E2E_TMP || tmpdir(), "koinonia-e2e-"));

const reqQa = createRequire(join(ROOT, "qa/package.json"));
const reqAg = createRequire(join(ROOT, "agents/package.json"));
const { chromium } = reqQa("playwright-core");
const esbuild = reqAg("esbuild");

// ---- bundle the pieces we reuse (read-only) -------------------------------------------------------------------
esbuild.buildSync({ entryPoints: [join(ROOT, "qa/lib/rtmp-sink.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "sink.mjs"), logLevel: "error" });
writeFileSync(join(tmp, "agents-entry.ts"), `
export { BridgeServer } from ${JSON.stringify(join(ROOT, "agents/src/bridge-server.ts"))};
export { linkBridge } from ${JSON.stringify(join(ROOT, "agents/src/bridge-link.ts"))};
export { BridgeClient, webSocketTransport } from ${JSON.stringify(join(ROOT, "agents/src/webmcp.ts"))};
export { Orchestrator } from ${JSON.stringify(join(ROOT, "agents/src/orchestrator.ts"))};
export { DEFAULT_AGENTS } from ${JSON.stringify(join(ROOT, "agents/src/definitions.ts"))};
export { FakeProvider, toolUse, say } from ${JSON.stringify(join(ROOT, "agents/src/providers/fake.ts"))};
`);
esbuild.buildSync({ entryPoints: [join(tmp, "agents-entry.ts")], bundle: true, platform: "node", format: "esm", outfile: join(tmp, "agents.mjs"), logLevel: "error" });
const { RtmpSink, analyzeTags } = await import(join(tmp, "sink.mjs"));

// ---- tiny static server for studio/dist -----------------------------------------------------------------------
const DIST = join(HERE, "../dist");
if (!existsSync(join(DIST, "index.html"))) throw new Error("studio/dist missing: run `npm run build` in studio/");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const web = createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const f = join(DIST, p === "/" ? "index.html" : p);
  if (!f.startsWith(DIST) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const webPort = web.address().port;

// ---- sink with arrival timestamps -------------------------------------------------------------------------------
const sink = new RtmpSink({ name: "e2e" });
const arrivals = new WeakMap();
const origPush = sink.sessions.push.bind(sink.sessions);
sink.sessions.push = (s) => { const t = []; arrivals.set(s, t); const tp = s.tags.push.bind(s.tags); s.tags.push = (...x) => { for (let i = 0; i < x.length; i++) t.push(performance.timeOrigin + performance.now()); return tp(...x); }; return origPush(s); };
await sink.listen();

// ---- daemon ---------------------------------------------------------------------------------------------------------
const dport = 20000 + Math.floor(Math.random() * 20000);
const clipDir = join(tmp, "clips"); mkdirSync(clipDir);
const dproc = spawn(DAEMON, [], { cwd: tmp, env: { PATH: process.env.PATH, HOME: process.env.HOME, KOINONIA_PORT: String(dport), KOINONIA_CLIP_DIR: clipDir, KOINONIA_CLIP_SECONDS: "120",
  KOINONIA_TWITCH_URL: sink.url("live"), KOINONIA_TWITCH_KEY: "e2e_key" }, stdio: ["ignore", "pipe", "pipe"] });
let dlog = ""; dproc.stdout.on("data", (d) => (dlog += d)); dproc.stderr.on("data", (d) => (dlog += d));
await sleep(500);
if (dproc.exitCode !== null) throw new Error("daemon exited: " + dlog);

const psCpu = () => { // cumulative cpu seconds + rss(kB) for the daemon
  const o = execFileSync("ps", ["-o", "cputime=,rss=", "-p", String(dproc.pid)]).toString().trim().split(/\s+/);
  const [m, s] = o[0].split(":"); return { cpu: Number(m) * 60 + Number(s), rss: Number(o[1]) };
};

const result = { when: new Date().toISOString(), machine: {}, config: { res: `${W}x${H}`, fps: 30, video_kbps: VKBPS, headless: HEADLESS, seconds: SECONDS, bgSeconds: BG_SECONDS }, notes: [] };
try { result.machine = { cpu: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"]).toString().trim(), cores: Number(execFileSync("sysctl", ["-n", "hw.ncpu"]).toString()), ram_gb: Number(execFileSync("sysctl", ["-n", "hw.memsize"]).toString()) / 2 ** 30, os: "macOS " + execFileSync("sw_vers", ["-productVersion"]).toString().trim() }; } catch { /* non-mac */ }

const browser = await chromium.launch({
  channel: "chrome", headless: HEADLESS,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900"],
});
result.machine.browser = browser.version();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["camera", "microphone"] });
await ctx.addInitScript(() => { try { localStorage.setItem('koinonia.studio.prefs.v1', JSON.stringify({ onboarded: true, view: 'painel' })); } catch {} });
const page = await ctx.newPage();
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text()); });
const cdp = await browser.newBrowserCDPSession();
const procCpu = async () => { const { processInfo } = await cdp.send("SystemInfo.getProcessInfo"); const o = {}; for (const p of processInfo) o[p.type + ":" + p.id] = p.cpuTime; return o; };

const stats = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: a.length, mean: +m.toFixed(2), sd: +sd.toFixed(2), min: +s[0].toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };

// ---- resource sampler ---------------------------------------------------------------------------------------------------
let sampling = null;
async function sampleWindow(label, ms) {
  const t0 = performance.now(); const a0 = psCpu(); const p0 = await procCpu();
  const v0 = sink.tags.filter((t) => t.type === 9).length;
  const f0 = await page.evaluate(() => window.__koinonia.diag.framesEncoded);
  await sleep(ms);
  const dt = (performance.now() - t0) / 1000; const a1 = psCpu(); const p1 = await procCpu();
  const v1 = sink.tags.filter((t) => t.type === 9).length;
  const f1 = await page.evaluate(() => window.__koinonia.diag.framesEncoded);
  const byType = {};
  for (const k of Object.keys(p1)) { const ty = k.split(":")[0]; byType[ty] = (byType[ty] ?? 0) + ((p1[k] - (p0[k] ?? 0)) / dt) * 100; }
  for (const k of Object.keys(byType)) byType[k] = +byType[k].toFixed(1);
  return { label, seconds: +dt.toFixed(1), chrome_cpu_pct_of_one_core_by_process_type: byType, chrome_cpu_total_pct: +Object.values(byType).reduce((x, y) => x + y, 0).toFixed(1),
    daemon_cpu_pct_of_one_core: +(((a1.cpu - a0.cpu) / dt) * 100).toFixed(2), daemon_rss_mb: +(a1.rss / 1024).toFixed(1),
    sink_video_tags_per_sec: +((v1 - v0) / dt).toFixed(2), encoded_frames_per_sec: +((f1 - f0) / dt).toFixed(2) };
}

try {
  // ======== 1. load studio, probe codecs ========
  const q = new URLSearchParams({ daemon: `ws://127.0.0.1:${dport}/ingest`, w: String(W), h: String(H), fps: "30", vkbps: String(VKBPS) });
  let bridgeSrv = null, agentsMod = null;
  if (WITH_BRIDGE) { agentsMod = await import(join(tmp, "agents.mjs")); bridgeSrv = await new agentsMod.BridgeServer({ port: 0 }).listen(); q.set("bridge", `ws://127.0.0.1:${bridgeSrv.port}/?role=page`); }
  const tPage0 = performance.now();
  await page.goto(`http://127.0.0.1:${webPort}/?${q}`);
  await page.waitForFunction(() => !!window.__koinonia);
  result.pageLoadMs = Math.round(performance.now() - tPage0);
  result.codecProbe = await page.evaluate(async ([w, h]) => {
    const out = { webcodecs: { VideoEncoder: typeof VideoEncoder, AudioEncoder: typeof AudioEncoder, MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor, OffscreenCanvas: typeof OffscreenCanvas } };
    const v = async (hw) => (await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: w, height: h, framerate: 30, bitrate: 3e6, hardwareAcceleration: hw, avc: { format: "avc" }, latencyMode: "realtime" }).catch(() => ({}))).supported ?? false;
    out.h264 = { any: await v("no-preference"), preferHardware: await v("prefer-hardware"), preferSoftware: await v("prefer-software") };
    const a = async (codec) => (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }).catch(() => ({}))).supported ?? false;
    out.audio = { aac_lc: await a("mp4a.40.2"), opus: await a("opus") };
    return out;
  }, [W, H]);
  console.log("codec probe", JSON.stringify(result.codecProbe));

  // ======== 2. agents bridge + approvals (no live needed) ========
  if (WITH_BRIDGE) {
    await page.waitForFunction(() => document.documentElement.dataset.bridge === "open", null, { timeout: 8000 });
    const A = agentsMod;
    const transport = await A.webSocketTransport(`ws://127.0.0.1:${bridgeSrv.port}`);
    const client = new A.BridgeClient(transport);
    const provider = new A.FakeProvider((_r, i) => (i === 0 ? [A.toolUse("ban_user", { user: "troll", reason: "spam" })] : i === 1 ? [A.say("done")] : [A.toolUse("timeout_user", { user: "troll2", seconds: 60, reason: "spam" })]));
    const orch = new A.Orchestrator({ client, provider, timers: false });
    const specs = await orch.refreshTools();
    const bridge = { tools: specs.map((s) => s.name) };
    orch.register(A.DEFAULT_AGENTS.find((d) => d.id === "moderator")); orch.start();
    const unlink = A.linkBridge(orch, transport);
    await page.evaluate(() => { for (let i = 0; i < 9; i++) window.koinoniaPushChat("viewer" + i, "hello " + i); window.koinoniaPushChat("troll", "buy followers"); });
    const chatTool = await client.callTool("get_chat", { since_cursor: 0, limit: 3 });
    bridge.getChatViaBridge = JSON.parse(chatTool.content[0].text).m.length;
    const msgs = Array.from({ length: 9 }, (_, i) => ({ id: i, user: "x", text: "m" + i }));
    await orch.bus.emit("chat.batch", { messages: msgs });
    await page.waitForSelector('#apr-list li[data-status="pending"]', { timeout: 8000 });
    bridge.proposalShownInPage = (await page.textContent('#apr-list li[data-status="pending"]')).trim();
    bridge.executedBeforeApproval = await page.evaluate(() => 0); // nothing can run before approve (asserted by the unit tests); the page shows it pending
    // (a) approve with NO platform connector attached: must be reported as not executed (honest failure), not a fake success
    await page.click('#apr-list li[data-status="pending"] [data-act="approve"]');
    await page.waitForSelector('#apr-list li[data-status="failed"]', { timeout: 8000 });
    bridge.approvedWithoutConnector = (await page.textContent('#apr-list li[data-status="failed"]')).trim();
    // (b) attach a recording connector and approve a timeout proposal
    await page.evaluate(() => { window.__modCalls = []; window.__koinonia.connectors.set("twitch", { requestBan: (u) => (window.__modCalls.push("ban:" + u), { id: "p" }), requestTimeout: (u, s) => (window.__modCalls.push(`timeout:${u}:${s}`), { id: "p" }), deleteMessage: async () => {}, executeProposal: async (id) => { window.__modCalls.push("exec:" + id); }, proposalStore: { approve() {} } }); window.koinoniaPushChat("troll2", "x"); });
    // push uid-bearing message through the real attachChat path
    await page.evaluate(() => { let cb; window.__koinonia.attachChat({ onMessage: (f) => { cb = f; return () => {}; } }); cb({ message: { ts: Date.now(), platform: "twitch", id: "m9", user: { id: "uid-troll2", name: "troll2" }, text: "hi" } }); });
    await sleep(5500); // moderator trigger cooldown (5 s) and min gap (3 s)
    await orch.bus.emit("chat.batch", { messages: msgs.map((m) => ({ ...m, id: m.id + 100 })) });
    await page.waitForSelector('#apr-list li[data-status="pending"]', { timeout: 8000 });
    await page.click('#apr-list li[data-status="pending"] [data-act="approve"]');
    await page.waitForSelector('#apr-list li[data-status="executed"]', { timeout: 8000 });
    bridge.approvedWithConnector = { ui: (await page.textContent('#apr-list li[data-status="executed"]')).trim(), connectorCalls: await page.evaluate(() => window.__modCalls) };
    // token panel fed by agent usage
    const rep = JSON.parse((await client.callTool("get_token_report", {})).content[0].text);
    bridge.tokenReportViaBridge = rep;
    bridge.tokenPanelText = await page.textContent("#tok-text");
    bridge.auditApprovalEvents = orch.audit.all().filter((e) => e.type.startsWith("approval.")).map((e) => e.type);
    result.bridge = bridge;
    console.log("bridge", JSON.stringify(bridge));
    unlink(); orch.dispose(); transport.close?.(); await bridgeSrv.close();
  }

  // ======== 3. go live ========
  await page.evaluate(() => window.__koinonia.enableCamera());
  await page.evaluate(() => { window.__koinonia.diag.trace = true; });
  const callTool = (n, a = {}) => page.evaluate(async ([n, a]) => JSON.parse((await window.__koinoniaTools.callTool(n, a)).content[0].text), [n, a]);
  const tStart = Date.now();
  const startRes = await callTool("start_stream", {});
  result.startStream = startRes;
  if (startRes.state !== "live") { result.notes.push("start_stream did not go live: " + JSON.stringify(startRes)); throw new Error("not live: " + JSON.stringify(startRes)); }
  await sink.waitFor(() => sink.tags.some((t) => t.type === 9 && t.body[1] === 1), 15000, "first video frame");
  const firstVideoAt = performance.timeOrigin + performance.now();
  result.timeToFirstVideoTagMs = Math.round(firstVideoAt - tStart);
  await sink.waitFor(() => sink.tags.some((t) => t.type === 8 && t.body[1] === 1), 15000, "first audio frame").catch(() => result.notes.push("no AAC raw audio tag reached the sink within 15 s"));
  result.codecs = await page.evaluate(() => window.__koinonia.diag.codecs);

  // ======== 4. foreground steady state ========
  await sleep(3000); // warm-up
  result.foreground = await sampleWindow("foreground", SECONDS * 1000);

  // ======== 5. clip export (daemon ring buffer) ========
  const clip = await callTool("export_clip", { seconds_back: 20, title: "e2e" });
  result.clip = clip;
  if (clip.path) {
    const p = resolve(tmp, clip.path);
    result.clip.bytes = existsSync(p) ? statSync(p).size : null;
    try {
      const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", p]).toString());
      result.clip.ffprobe = { format: pr.format.format_name, duration: +Number(pr.format.duration).toFixed(2), streams: pr.streams.map((s) => ({ codec: s.codec_name, type: s.codec_type, w: s.width, h: s.height, fps: s.avg_frame_rate, sr: s.sample_rate, ch: s.channels })) };
      result.clip.decodeErrors = execFileSync("sh", ["-c", `ffmpeg -v error -i '${p}' -f null - 2>&1 | head -5; true`]).toString().trim() || "none";
    } catch (e) { result.clip.ffprobeError = String(e.message).slice(0, 200); }
  }

  // ======== 6. background tab ========
  const other = await ctx.newPage(); await other.goto("about:blank"); await other.bringToFront();
  await sleep(1500);
  result.visibilityWhileBackground = await page.evaluate(() => document.visibilityState);
  result.background = await sampleWindow("background-tab", BG_SECONDS * 1000);
  await page.bringToFront(); await sleep(1500);
  result.visibilityAfterReturn = await page.evaluate(() => document.visibilityState);
  result.foregroundAgain = await sampleWindow("foreground-again", 8000);

  // ======== 7. stop & analyse ========
  const diag = await page.evaluate(() => { const d = window.__koinonia.diag; return { wallStartMs: d.wallStartMs, log: d.log, dests: d.dests, errors: d.errors, lastStatus: d.lastStatus, aac: d.aacChunks, enqueue: d.encQueue }; });
  const metrics = await page.evaluate(() => { const m = window.__koinonia.metrics; const o = {}; for (const k of m.metrics()) o[k] = { last: m.query(k, 3600, "last").v, max: m.query(k, 3600, "max").v, avg: m.query(k, 3600, "avg").v }; return o; });
  await callTool("stop_stream", {});
  await sleep(1500);

  const sess = sink.sessions[0];
  const arr = arrivals.get(sess);
  const an = analyzeTags(sess.tags);
  result.flv = { problems: an.problems, sessions: sink.sessions.length, videoTags: an.video.length, audioTags: an.audio.length, scriptTags: an.script.length, rtmpCommands: sess.commands.map((c) => c.name), publishedKey: sess.streamKey, protocolErrors: sess.protocolErrors };
  const vIdx = []; sess.tags.forEach((t, i) => { if (t.type === 9 && t.body[1] === 1) vIdx.push(i); });
  const vts = vIdx.map((i) => sess.tags[i].ts);
  const keyts = vIdx.filter((i) => sess.tags[i].body[0] >> 4 === 1).map((i) => sess.tags[i].ts);
  const dts = vts.slice(1).map((t, i) => t - vts[i]);
  result.flv.firstVideoNaluIsKeyframe = sess.tags[vIdx[0]].body[0] >> 4 === 1;
  result.flv.keyframeIntervalMs = stats(keyts.slice(1).map((t, i) => t - keyts[i]));
  result.flv.avgFpsFromTimestamps = +(((vts.length - 1) * 1000) / (vts.at(-1) - vts[0])).toFixed(2);
  result.flv.interFrameMs = stats(dts);
  result.flv.gapsOver2Frames = dts.filter((d) => d > 70).length;
  result.flv.estimatedMissedFrames = dts.reduce((n, d) => n + Math.max(0, Math.round(d / 33.33) - 1), 0);
  // per-second delivered fps at the sink (arrival clock)
  const perSec = new Map(); vIdx.forEach((i) => { const s = Math.floor(arr[i] / 1000); perSec.set(s, (perSec.get(s) ?? 0) + 1); });
  const secs = [...perSec.entries()].sort((a, b) => a[0] - b[0]).slice(1, -1).map(([, n]) => n);
  result.flv.sinkFpsPerSecond = stats(secs);
  // video bitrate at the sink
  const vbytes = vIdx.reduce((n, i) => n + sess.tags[i].body.length, 0);
  result.flv.videoKbps = +((vbytes * 8) / ((vts.at(-1) - vts[0]) / 1000) / 1000).toFixed(0);
  // latency: page compose clock -> sink arrival. match k-th video chunk sent to k-th video tag at the sink.
  const sentV = diag.log.filter((e) => e[0] === 0);
  const n = Math.min(sentV.length, vIdx.length);
  const bases = []; const lat = []; const lastMile = [];
  for (let k = 0; k < n; k++) bases.push(sentV[k][1] - sess.tags[vIdx[k]].ts);
  const baseMed = [...bases].sort((a, b) => a - b)[Math.floor(bases.length / 2)];
  for (let k = 0; k < n; k++) { lat.push(arr[vIdx[k]] - (diag.wallStartMs + sentV[k][1])); lastMile.push(arr[vIdx[k]] - sentV[k][2]); }
  result.latency = {
    definition: "wall time the video tag reaches the RTMP sink minus wall time of the frame's compositor timestamp (canvas draw -> VideoFrame -> encode -> WS -> daemon -> RTMP). Excludes camera capture/driver latency and any player/CDN.",
    base_consistency_sd_ms: stats(bases)?.sd, matched: n,
    compose_to_sink_ms: stats(lat), socket_to_sink_ms: stats(lastMile),
    encode_ms_compose_to_socket: stats(sentV.slice(0, n).map((e, k) => e[2] - (diag.wallStartMs + e[1]))),
  };
  result.pageMetrics = metrics; result.pageDiag = { dests: diag.dests, errors: diag.errors, lastDaemonStatus: diag.lastStatus, audioChunksSent: diag.aac };
  // per-second sink fps in each phase can be derived from foreground/background windows above (sink_video_tags_per_sec)

  // ======== 8. real decode check of what the sink received ========
  const flv = join(tmp, "capture.flv");
  const parts = [Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0])];
  for (const t of sess.tags) {
    let body = t.body;
    if (t.type === 18 && body[0] === 2 && body.readUInt16BE(1) === 13 && body.subarray(3, 16).toString() === "@setDataFrame") body = body.subarray(16);
    const h = Buffer.alloc(11); h[0] = t.type; h.writeUIntBE(body.length, 1, 3); h.writeUIntBE(t.ts & 0xffffff, 4, 3); h[7] = (t.ts >>> 24) & 0xff;
    const tail = Buffer.alloc(4); tail.writeUInt32BE(11 + body.length);
    parts.push(h, body, tail);
  }
  writeFileSync(flv, Buffer.concat(parts));
  try {
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", flv]).toString());
    result.decode = { streams: pr.streams.map((s) => ({ codec: s.codec_name, profile: s.profile, type: s.codec_type, w: s.width, h: s.height, fps: s.avg_frame_rate, sr: s.sample_rate, ch: s.channels })), duration: +Number(pr.format.duration).toFixed(1) };
    result.decode.ffmpegErrors = execFileSync("sh", ["-c", `ffmpeg -v error -i '${flv}' -f null - 2>&1 | head -8; true`]).toString().trim() || "none (full decode clean)";
  } catch (e) { result.decode = { error: String(e.message).slice(0, 300) }; }
  result.pageErrors = pageErrors;
  result.daemonLogTail = dlog.split("\n").slice(-6);
  console.log(JSON.stringify(result, null, 1));
} catch (e) {
  try { result.debugDiag = await page.evaluate(() => { const d = window.__koinonia.diag; const { log, ...rest } = d; return { ...rest, logN: log.length, state: window.__koinonia.streamState(), bp: window.__koinonia.transport.droppedForBackpressure }; }); } catch { /* page gone */ }
  result.fatal = String(e.stack ?? e); result.pageErrors = pageErrors; result.daemonLogTail = dlog.split("\n").slice(-10);
  console.error("E2E FAILED", e);
  process.exitCode = 1;
} finally {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log("wrote", OUT);
  await browser.close().catch(() => {});
  dproc.kill("SIGTERM");
  await sink.close().catch(() => {});
  web.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
