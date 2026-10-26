#!/usr/bin/env node
// REFERENCE daemon used ONLY to self-check the QA harness (never shipped): speaks the same ingest protocol
// (daemon/PROTOCOL.md) and env config as koinonia-d, in ~150 lines of Node. `make qa-selfcheck` points KOINONIA_D_BIN at it,
// proving the integration/security/fuzz/soak tests are correct and would pass against a conforming daemon.
import net from "node:net";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { RtmpPublisher } from "./rtmp-client.ts";
import { encodeAmf } from "./amf0.ts";

const port = Number(process.env.KOINONIA_PORT ?? 7878);
const token = process.env.KOINONIA_TOKEN;
const dests = {};
for (const [k, v] of Object.entries(process.env)) {
  let m = /^KOINONIA_(TWITCH|YOUTUBE)_URL$/.exec(k) ?? /^KOINONIA_DEST_(.+)_URL$/.exec(k);
  if (!m) continue;
  const key = process.env[k.replace(/_URL$/, "_KEY")]; if (!key) continue;
  dests[m[1].toLowerCase()] = { url: new URL(v), key };
}
const KIND = { start: 1, stop: 2, clip: 3, vcfg: 0x10, acfg: 0x11, video: 0x12, audio: 0x13 };
let active = false;

class Dest {
  constructor(name, cfg, meta) { this.name = name; this.cfg = cfg; this.meta = meta; this.q = []; this.pub = null; this.needKey = true; this.state = "connecting"; this.stopped = false; this.connect(); }
  async connect() {
    while (!this.stopped) {
      try {
        const u = this.cfg.url;
        const p = new RtmpPublisher(u.hostname, Number(u.port), u.pathname.replace(/^\//, ""), this.cfg.key);
        await p.connect(); this.pub = p; this.needKey = true; this.state = "live";
        const closed = new Promise((r) => p.sock.once("close", r));
        p.tag(18, 0, Buffer.concat([encodeAmf(["onMetaData", { width: 1280, height: 720 }])]));
        if (state.vcfg) p.tag(9, 0, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), state.vcfg]));
        if (state.acfg) p.tag(8, 0, Buffer.concat([Buffer.from([0xaf, 0]), state.acfg]));
        this.flushLoop = setInterval(() => this.flush(), 5);
        await closed; clearInterval(this.flushLoop); this.pub = null; this.state = "reconnecting";
      } catch { this.state = "error"; }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  push(item) {
    if (!this.pub) return; // not connected: frames are dropped; resume on next keyframe
    if (this.q.length > 400) { const i = this.q.findIndex((x) => !x.key); if (i >= 0) this.q.splice(i, 1); }
    this.q.push(item);
  }
  flush() {
    const p = this.pub; if (!p || p.sock.destroyed) return;
    while (this.q.length && p.sock.writableLength < 64 * 1024) {
      const it = this.q.shift();
      if (it.type === 9 && this.needKey) { if (!it.key) continue; this.needKey = false; }
      p.tag(it.type, it.ts, it.body);
    }
  }
  stop() { this.stopped = true; clearInterval(this.flushLoop); try { this.pub?.end(); } catch { /* */ } }
}
const state = { vcfg: null, acfg: null };

const http = createServer((_q, r) => { r.writeHead(404).end(); });
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url, "http://x");
  const origin = req.headers.origin;
  if (token && url.searchParams.get("token") !== token) { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) && !process.env.KOINONIA_ALLOW_ANY_ORIGIN) { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  if (active) { sock.end("HTTP/1.1 409 Conflict\r\n\r\n"); return; }
  wss.handleUpgrade(req, sock, head, (ws) => session(ws));
});

function session(ws) {
  active = true; let live = []; state.vcfg = state.acfg = null;
  const status = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* */ } };
  status({ type: "ready", version: 1 });
  ws.on("close", () => { live.forEach((d) => d.stop()); active = false; });
  ws.on("message", (data, isBin) => {
    if (!isBin) return ws.close(1003, "text");
    const b = Buffer.from(data);
    if (b.length < 10) return;
    const kind = b[0], flags = b[1], dts = b.readUInt32BE(2), cts = b.readInt32BE(6), pl = b.subarray(10);
    const bad = () => { status({ type: "error", message: "protocol" }); ws.close(1002, "protocol"); };
    if (![1, 2, 3, 0x10, 0x11, 0x12, 0x13].includes(kind)) return bad();
    if (kind !== 2 && pl.length === 0) return bad();
    if (kind === KIND.start) {
      let o = {}; try { o = JSON.parse(pl.toString()); } catch { return bad(); }
      const want = o.destinations?.length ? o.destinations : Object.keys(dests);
      for (const n of want) { if (!dests[n]) { status({ type: "dest", name: n, state: "error", error: "UnknownDestination" }); status({ type: "error", message: "unknown destination" }); continue; } live.push(new Dest(n, dests[n])); }
      status({ type: "started", destinations: live.map((d) => ({ name: d.name, state: d.state })) });
    } else if (kind === KIND.stop) { live.forEach((d) => d.stop()); live = []; }
    else if (kind === KIND.vcfg) { state.vcfg = Buffer.from(pl); live.forEach((d) => d.pub?.tag(9, 0, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), pl]))); }
    else if (kind === KIND.acfg) { state.acfg = Buffer.from(pl); live.forEach((d) => d.pub?.tag(8, 0, Buffer.concat([Buffer.from([0xaf, 0]), pl]))); }
    else if (kind === KIND.video) {
      const key = !!(flags & 1); const c = Buffer.alloc(3); c.writeUIntBE(cts & 0xffffff, 0, 3);
      const body = Buffer.concat([Buffer.from([(key ? 0x17 : 0x27), 1]), c, pl]);
      live.forEach((d) => d.push({ type: 9, ts: dts, body, key }));
    } else if (kind === KIND.audio) {
      const body = Buffer.concat([Buffer.from([0xaf, 1]), pl]);
      live.forEach((d) => d.push({ type: 8, ts: dts, body, key: true }));
    }
  });
}
http.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
void net;
