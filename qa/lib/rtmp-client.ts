// Tiny RTMP publisher used to self-test the sink and to generate soak traffic. Mirrors what koinonia-d's rtmp.zig does.
import net from "node:net";
import { randomBytes } from "node:crypto";
import { decodeAmf, encodeAmf, type Amf } from "./amf0.ts";

export class RtmpPublisher {
  sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private chunk = 128;
  constructor(readonly host: string, readonly port: number, readonly app = "live", readonly key = "k") {}

  private wake() { this.waiters.splice(0).forEach((w) => w()); }
  private async need(n: number): Promise<Buffer> {
    while (this.buf.length < n) await new Promise<void>((r) => this.waiters.push(r));
    const b = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return b;
  }
  private msg(csid: number, type: number, sid: number, ts: number, payload: Buffer, fmt0 = true) {
    const ext = ts >= 0xffffff;
    const h = Buffer.alloc(12 + (ext ? 4 : 0));
    h[0] = (fmt0 ? 0 : 0) | (csid & 0x3f);
    h.writeUIntBE(ext ? 0xffffff : ts, 1, 3); h.writeUIntBE(payload.length, 4, 3); h[7] = type; h.writeUInt32LE(sid, 8);
    if (ext) h.writeUInt32BE(ts, 12);
    const parts: Buffer[] = [h];
    for (let o = 0; o < payload.length; o += this.chunk) {
      if (o > 0) { parts.push(Buffer.from([0xc0 | (csid & 0x3f)])); if (ext) parts.push(Buffer.from(h.subarray(12, 16))); }
      parts.push(payload.subarray(o, o + this.chunk));
    }
    this.sock.write(Buffer.concat(parts));
  }

  async connect(): Promise<void> {
    this.sock = net.connect(this.port, this.host);
    this.sock.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    this.sock.on("error", () => {}); this.sock.on("close", () => this.wake());
    await new Promise<void>((r) => this.sock.once("connect", () => r()));
    const c1 = Buffer.concat([Buffer.alloc(8), randomBytes(1528)]);
    this.sock.write(Buffer.concat([Buffer.from([3]), c1]));
    const s0 = await this.need(1); if (s0[0] !== 3) throw new Error("bad S0");
    const s1 = Buffer.from(await this.need(1536)); const s2 = await this.need(1536);
    if (!s2.subarray(8).equals(c1.subarray(8))) throw new Error("S2 does not echo C1");
    this.sock.write(s1);
    // chunk size 4096 (like koinonia-d)
    this.msg(2, 1, 0, 0, Buffer.from([0, 0, 0x10, 0])); this.chunk = 4096;
    this.msg(3, 20, 0, 0, encodeAmf(["connect", 1, { app: this.app, type: "nonprivate", flashVer: "qa", tcUrl: `rtmp://${this.host}:${this.port}/${this.app}` }]));
    await this.expectCmd("_result", 1);
    this.msg(3, 20, 0, 0, encodeAmf(["releaseStream", 2, null, this.key]));
    this.msg(3, 20, 0, 0, encodeAmf(["FCPublish", 3, null, this.key]));
    this.msg(3, 20, 0, 0, encodeAmf(["createStream", 4, null]));
    const r = await this.expectCmd("_result", 4);
    const sid = Number(r[3]);
    this.msg(8, 20, sid, 0, encodeAmf(["publish", 0, null, this.key, "live"]));
    const st = await this.expectCmd("onStatus", 0);
    const code = (st[3] as Record<string, Amf>).code;
    if (code !== "NetStream.Publish.Start") throw new Error(`publish rejected: ${String(code)}`);
    this.sid = sid;
  }
  sid = 1;
  private srvChunk = 128;
  private async expectCmd(name: string, txn: number): Promise<Amf[]> {
    for (;;) {
      const b0 = (await this.need(1))[0]!;
      const fmt = b0 >> 6;
      const hl = [11, 7, 3, 0][fmt]!;
      const h = hl ? await this.need(hl) : Buffer.alloc(0);
      // We only receive fmt0 first-chunks for each message from our sink; later chunks are fmt3 continuation.
      if (fmt !== 0) throw new Error("unexpected non-fmt0 chunk from server");
      const len = h.readUIntBE(3, 3), type = h[6]!;
      let payload = Buffer.alloc(0);
      while (payload.length < len) {
        const n = Math.min(this.srvChunk, len - payload.length);
        payload = Buffer.concat([payload, await this.need(n)]);
        if (payload.length < len) await this.need(1); // fmt3 basic header
      }
      if (type === 1) this.srvChunk = payload.readUInt32BE(0) & 0x7fffffff;
      if (type === 20) { const v = decodeAmf(payload); if (v[0] === name && v[1] === txn) return v; }
    }
  }
  /** Send an FLV tag body as an RTMP message. */
  tag(type: 8 | 9 | 18, ts: number, body: Buffer) { this.msg(type === 9 ? 6 : type === 8 ? 4 : 5, type, this.sid, ts, body); }
  end() { this.sock.end(); }
}
