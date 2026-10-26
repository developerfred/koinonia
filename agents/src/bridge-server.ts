import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";

/**
 * Server side of the agents <-> studio-page bridge (matches `BridgeClient` / `webSocketTransport` in webmcp.ts).
 * The page cannot listen, so it connects OUT to this relay, like the agents do:
 *
 *   ws://127.0.0.1:9333/?role=page    the studio tab (answers tools/list, tools/call)
 *   ws://127.0.0.1:9333/              agents (default role) -- JSON-RPC style {id, method, params} -> {id, result|error}
 *
 * Besides request/response there are id-less notifications, relayed only between the right roles and only for a
 * fixed allowlist (so neither side can inject arbitrary traffic into the other):
 *   agent -> page : approval.requested, approval.result, approval.closed, tokens.usage
 *   page  -> agent: approval.decide
 *
 * Security: loopback bind by default; any upgrade with a non-loopback Origin is refused (a web page the user happens to
 * have open must not be able to drive the stream); optional shared secret via `?token=`; one page at a time; size limits.
 */
export interface BridgeServerOptions {
  port?: number;
  host?: string;
  token?: string;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxClients?: number;
  log?: (s: string) => void;
}

const TO_PAGE = new Set(["approval.requested", "approval.result", "approval.closed", "tokens.usage"]);
const TO_AGENTS = new Set(["approval.decide"]);
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface Client { sock: Duplex; role: "page" | "agent"; buf: Buffer; frag: Buffer[]; fragBytes: number; closed: boolean }
type Msg = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

export class BridgeServer {
  private http: Server;
  private clients = new Set<Client>();
  private pending = new Map<number, { agent: Client; origId: number; timer: ReturnType<typeof setTimeout> }>();
  private relayId = 0;
  port = 0;
  constructor(private o: BridgeServerOptions = {}) {
    this.http = createServer((_, res) => { res.writeHead(426, { "content-type": "text/plain" }); res.end("koinonia bridge: WebSocket only\n"); });
    this.http.on("upgrade", (req, sock) => this.upgrade(req, sock));
  }

  get page(): Client | undefined { return [...this.clients].find((c) => c.role === "page"); }
  get agentCount(): number { return [...this.clients].filter((c) => c.role === "agent").length; }
  get pageConnected(): boolean { return !!this.page; }

  async listen(): Promise<this> {
    await new Promise<void>((res, rej) => { this.http.once("error", rej); this.http.listen(this.o.port ?? 9333, this.o.host ?? "127.0.0.1", () => res()); });
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }
  async close(): Promise<void> {
    for (const c of this.clients) c.sock.destroy();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await new Promise<void>((res) => this.http.close(() => res()));
  }

  private reject(sock: Duplex, code: number, why: string) {
    sock.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private upgrade(req: IncomingMessage, sock: Duplex) {
    sock.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://x");
    const origin = String(req.headers.origin ?? "");
    if (origin) {
      let h = ""; try { h = new URL(origin).hostname; } catch { /* invalid */ }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(h)) return this.reject(sock, 403, "Forbidden");
    }
    if (this.o.token) {
      const got = Buffer.from(url.searchParams.get("token") ?? ""), want = Buffer.from(this.o.token);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return this.reject(sock, 403, "Forbidden");
    }
    const key = req.headers["sec-websocket-key"];
    if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string") return this.reject(sock, 400, "Bad Request");
    if (this.clients.size >= (this.o.maxClients ?? 8)) return this.reject(sock, 503, "Service Unavailable");
    const role = url.searchParams.get("role") === "page" ? "page" : "agent";
    if (role === "page") this.page?.sock.destroy(); // latest tab wins; stale tab is dropped
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c: Client = { sock, role, buf: Buffer.alloc(0), frag: [], fragBytes: 0, closed: false };
    this.clients.add(c);
    this.o.log?.(`bridge: ${role} connected`);
    sock.on("data", (d: Buffer) => this.onData(c, d));
    sock.on("close", () => this.drop(c));
  }

  private drop(c: Client) {
    if (c.closed) return;
    c.closed = true;
    this.clients.delete(c);
    this.o.log?.(`bridge: ${c.role} disconnected`);
    for (const [id, p] of this.pending) {
      if (c.role === "page") { clearTimeout(p.timer); this.pending.delete(id); this.reply(p.agent, { id: p.origId, error: { message: "studio page disconnected" } }); }
      else if (p.agent === c) { clearTimeout(p.timer); this.pending.delete(id); }
    }
  }

  // ---- minimal RFC 6455 (text frames, fragmentation, ping/pong, close) ----
  private onData(c: Client, d: Buffer) {
    c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d;
    const max = this.o.maxMessageBytes ?? 8 * 1024 * 1024;
    for (;;) {
      const b = c.buf;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0, op = b[0]! & 0x0f, masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(max)) return this.fail(c, 1009); len = Number(big); off = 10; }
      if (!masked) return this.fail(c, 1002); // clients MUST mask
      if (len > max) return this.fail(c, 1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      c.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.sendFrame(c, 0x8, payload.subarray(0, 2)); c.sock.end(); return; }
      if (op === 0x9) { this.sendFrame(c, 0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        c.frag.push(payload); c.fragBytes += payload.length;
        if (c.fragBytes > max) return this.fail(c, 1009);
        if (fin) { const text = Buffer.concat(c.frag).toString("utf8"); c.frag = []; c.fragBytes = 0; this.onMessage(c, text); }
        continue;
      }
      return this.fail(c, 1003); // binary/unknown opcodes are not part of this protocol
    }
  }
  private fail(c: Client, code: number) {
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.sendFrame(c, 0x8, p); c.sock.end();
  }
  private sendFrame(c: Client, op: number, payload: Buffer) {
    if (c.closed || c.sock.destroyed) return;
    const n = payload.length;
    const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const x = Buffer.alloc(10); x[0] = 0x80 | op; x[1] = 127; x.writeBigUInt64BE(BigInt(n), 2); return x; })();
    try { c.sock.write(Buffer.concat([h, payload])); } catch { /* socket gone */ }
  }
  private reply(c: Client, m: Msg) { this.sendFrame(c, 0x1, Buffer.from(JSON.stringify(m))); }

  // ---- routing ----
  private onMessage(c: Client, text: string) {
    let m: Msg;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (c.role === "agent" && typeof m.method === "string" && typeof m.id === "number") return this.agentRequest(c, m);
    if (c.role === "page" && typeof m.id === "number" && typeof m.method !== "string") return this.pageReply(m);
    if (typeof m.method === "string" && m.id === undefined) {
      const ok = c.role === "agent" ? TO_PAGE.has(m.method) : TO_AGENTS.has(m.method);
      if (!ok) return;
      const out = JSON.stringify({ method: m.method, params: m.params });
      for (const t of this.clients) if (t.role !== c.role) this.sendFrame(t, 0x1, Buffer.from(out));
    }
  }

  private agentRequest(agent: Client, m: Msg) {
    if (m.method !== "tools/list" && m.method !== "tools/call") return this.reply(agent, { id: m.id, error: { message: `unknown method ${m.method}` } });
    const page = this.page;
    if (!page) return this.reply(agent, { id: m.id, error: { message: "no studio page connected (open the studio with ?bridge=ws://127.0.0.1:" + this.port + ")" } });
    const id = ++this.relayId;
    const timer = setTimeout(() => { if (this.pending.delete(id)) this.reply(agent, { id: m.id, error: { message: `studio page did not answer ${m.method}` } }); }, this.o.requestTimeoutMs ?? 20_000);
    this.pending.set(id, { agent, origId: m.id!, timer });
    this.reply(page, { id, method: m.method, params: m.params });
  }
  private pageReply(m: Msg) {
    const p = this.pending.get(m.id!);
    if (!p) return;
    clearTimeout(p.timer); this.pending.delete(m.id!);
    this.reply(p.agent, m.error !== undefined ? { id: p.origId, error: m.error } : { id: p.origId, result: m.result });
  }
}
