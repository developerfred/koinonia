// Fake RTMP ingest server ("sink") used as the publish target of koinonia-d.
// Implements: plain handshake (C0/C1/S0/S1/S2/C2), chunk-stream reassembly (fmt 0-3, extended timestamps,
// Set Chunk Size), AMF0 commands connect/releaseStream/FCPublish/createStream/publish, and captures A/V/script messages.
// Not implemented: RTMPS/TLS (point the daemon at rtmp://127.0.0.1:<port>/app), RTMPE, encrypted handshake.
import net from "node:net";
import { randomBytes } from "node:crypto";
import { decodeAmf, encodeAmf, type Amf, type AmfObj } from "./amf0";

export interface Tag { type: 8 | 9 | 18; ts: number; streamId: number; body: Buffer; conn: number }
export interface Session {
  id: number;
  handshake: { s0Ok: boolean; c1Len: number; c2EchoesS1: boolean; c1Zero: boolean } ;
  commands: { name: string; txn: number; args: Amf[] }[];
  app?: string; tcUrl?: string; streamKey?: string; publishType?: string;
  chunkSizeFromClient: number;
  tags: Tag[];
  bytesIn: number;
  closed: boolean;
  protocolErrors: string[];
}
export interface SinkOptions {
  /** Close the connection after receiving this many A/V tags (reconnect tests). */
  dropAfterTags?: number;
  /** Throttle reads to this many bytes per second (slow sink). 0/undefined = unlimited. */
  bytesPerSec?: number;
  /** Reject publish (NetStream.Publish.BadName). */
  rejectPublish?: boolean;
  name?: string;
}

const HS = 1536;

export class RtmpSink {
  readonly sessions: Session[] = [];
  private server = net.createServer((s) => this.onConn(s));
  private sockets = new Set<net.Socket>();
  port = 0;
  constructor(public opts: SinkOptions = {}) {}

  async listen(port = 0): Promise<this> {
    await new Promise<void>((res) => this.server.listen(port, "127.0.0.1", res));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  url(app = "live"): string { return `rtmp://127.0.0.1:${this.port}/${app}`; }
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => this.server.close(() => res()));
  }
  get tags(): Tag[] { return this.sessions.flatMap((s) => s.tags); }

  async waitFor(pred: () => boolean, ms = 5000, what = "condition"): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`RtmpSink: timeout waiting for ${what} (sessions=${this.sessions.length}, tags=${this.tags.length})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private onConn(sock: net.Socket) {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => {});
    const sess: Session = {
      id: this.sessions.length, handshake: { s0Ok: false, c1Len: 0, c2EchoesS1: false, c1Zero: false }, commands: [],
      chunkSizeFromClient: 128, tags: [], bytesIn: 0, closed: false, protocolErrors: [],
    };
    this.sessions.push(sess);
    sock.on("close", () => { sess.closed = true; });

    let buf = Buffer.alloc(0);
    let state: "c0c1" | "c2" | "chunks" = "c0c1";
    let s1: Buffer | undefined;
    const chunkStreams = new Map<number, { ts: number; delta: number; len: number; type: number; sid: number; payload: Buffer[]; have: number; ext: boolean }>();
    let rxChunk = 128;
    let avTags = 0;
    let txStreamId = 0;

    const sendMsg = (csid: number, type: number, sid: number, payload: Buffer, ts = 0) => {
      const hdr = Buffer.alloc(12);
      hdr[0] = csid & 0x3f; // fmt 0
      hdr.writeUIntBE(ts, 1, 3); hdr.writeUIntBE(payload.length, 4, 3); hdr[7] = type; hdr.writeUInt32LE(sid, 8);
      const parts: Buffer[] = [hdr];
      for (let o = 0; o < payload.length; o += 4096) {
        if (o > 0) parts.push(Buffer.from([0xc0 | (csid & 0x3f)]));
        parts.push(payload.subarray(o, o + 4096));
      }
      if (payload.length === 0) { /* header only */ }
      sock.write(Buffer.concat(parts));
    };
    const ctl = (type: number, data: number[]) => sendMsg(2, type, 0, Buffer.from(data));
    // we send chunks of at most 4096 -> announce it
    const announce = () => ctl(1, [0, 0, 0x10, 0]);
    const reply = (name: string, txn: number, ...rest: Amf[]) => sendMsg(3, 20, 0, encodeAmf([name, txn, ...rest]));

    const onMessage = (type: number, sid: number, ts: number, payload: Buffer) => {
      if (type === 1) { rxChunk = payload.readUInt32BE(0) & 0x7fffffff; sess.chunkSizeFromClient = rxChunk; return; }
      if (type === 8 || type === 9 || type === 18) {
        sess.tags.push({ type, ts, streamId: sid, body: payload, conn: sess.id });
        if (type !== 18 && ++avTags === this.opts.dropAfterTags) setTimeout(() => sock.destroy(), 0);
        return;
      }
      if (type === 20) {
        let vals: Amf[];
        try { vals = decodeAmf(payload); } catch (e) { sess.protocolErrors.push(`amf: ${(e as Error).message}`); return; }
        const name = String(vals[0]); const txn = Number(vals[1] ?? 0);
        sess.commands.push({ name, txn, args: vals.slice(2) });
        if (name === "connect") {
          const o = (vals[2] ?? {}) as AmfObj; sess.app = String(o.app ?? ""); sess.tcUrl = String(o.tcUrl ?? "");
          ctl(5, [0, 0x26, 0x25, 0xa0]); // window ack size 2.5M
          ctl(6, [0, 0x26, 0x25, 0xa0, 2]); // set peer bandwidth
          announce();
          reply("_result", txn, { fmsVer: "FMS/3,0,1,123", capabilities: 31 }, { level: "status", code: "NetConnection.Connect.Success", description: "Connection succeeded.", objectEncoding: 0 });
        } else if (name === "createStream") {
          txStreamId = 1; reply("_result", txn, null, txStreamId);
        } else if (name === "publish") {
          sess.streamKey = String(vals[3]); sess.publishType = String(vals[4] ?? "");
          const ok = !this.opts.rejectPublish;
          sendMsg(5, 20, sid, encodeAmf(["onStatus", 0, null, { level: ok ? "status" : "error", code: ok ? "NetStream.Publish.Start" : "NetStream.Publish.BadName", description: ok ? "Publishing" : "rejected" }]));
        }
      }
    };

    const pump = () => {
      for (;;) {
        if (state === "c0c1") {
          if (buf.length < 1 + HS) return;
          sess.handshake.s0Ok = buf[0] === 3; sess.handshake.c1Len = HS;
          const c1 = buf.subarray(1, 1 + HS);
          sess.handshake.c1Zero = c1.readUInt32BE(4) === 0;
          buf = buf.subarray(1 + HS);
          s1 = Buffer.concat([Buffer.alloc(8), randomBytes(HS - 8)]);
          const s2 = Buffer.concat([c1.subarray(0, 4), Buffer.alloc(4), c1.subarray(8)]); // echo C1 random bytes
          sock.write(Buffer.concat([Buffer.from([3]), s1, s2]));
          state = "c2";
        } else if (state === "c2") {
          if (buf.length < HS) return;
          sess.handshake.c2EchoesS1 = buf.subarray(8, HS).equals(s1!.subarray(8));
          buf = buf.subarray(HS); state = "chunks";
        } else {
          // chunk parsing
          let o = 0;
          const b0 = buf[o]; if (b0 === undefined) return;
          const fmt = b0 >> 6; let csid = b0 & 0x3f; o++;
          if (csid === 0) { if (buf.length < o + 1) return; csid = buf[o]! + 64; o++; }
          else if (csid === 1) { if (buf.length < o + 2) return; csid = buf.readUInt16LE(o) + 64; o += 2; }
          const hlen = [11, 7, 3, 0][fmt]!;
          if (buf.length < o + hlen) return;
          let cs = chunkStreams.get(csid);
          if (!cs && fmt !== 0) { sess.protocolErrors.push(`fmt ${fmt} chunk on unknown csid ${csid}`); sock.destroy(); return; }
          if (!cs) cs = { ts: 0, delta: 0, len: 0, type: 0, sid: 0, payload: [], have: 0, ext: false };
          let tsField = 0;
          let p = o;
          if (fmt <= 2) { tsField = buf.readUIntBE(p, 3); p += 3; }
          if (fmt <= 1) { cs.len = buf.readUIntBE(p, 3); cs.type = buf[p + 3]!; p += 4; }
          if (fmt === 0) { cs.sid = buf.readUInt32LE(p); p += 4; }
          let ext = false;
          if (fmt <= 2) ext = tsField === 0xffffff; else ext = cs.ext;
          if (ext) { if (buf.length < p + 4) return; tsField = buf.readUInt32BE(p); p += 4; }
          const first = cs.have === 0;
          const take = Math.min(rxChunk, cs.len - cs.have);
          if (buf.length < p + take) return;
          if (first) {
            if (fmt === 0) cs.ts = tsField; else if (fmt <= 2) { cs.delta = tsField; cs.ts = (cs.ts + tsField) >>> 0; } else cs.ts = (cs.ts + cs.delta) >>> 0;
            cs.ext = ext;
          }
          cs.payload.push(Buffer.from(buf.subarray(p, p + take))); cs.have += take;
          buf = buf.subarray(p + take);
          chunkStreams.set(csid, cs);
          if (cs.have >= cs.len) {
            const payload = Buffer.concat(cs.payload); cs.payload = []; cs.have = 0;
            onMessage(cs.type, cs.sid, cs.ts, payload);
          }
        }
      }
    };

    let paused = false;
    const bps = this.opts.bytesPerSec ?? 0;
    sock.on("data", (d) => {
      sess.bytesIn += d.length;
      buf = Buffer.concat([buf, d]);
      try { pump(); } catch (e) { sess.protocolErrors.push(String(e)); sock.destroy(); }
      if (bps > 0 && !paused) {
        paused = true; sock.pause();
        setTimeout(() => { paused = false; sock.resume(); }, Math.ceil((d.length / bps) * 1000));
      }
    });
  }
}

export interface FlvAnalysis { problems: string[]; video: Tag[]; audio: Tag[]; script: Tag[] }

/** Structural checks of a captured RTMP A/V stream against the FLV spec + PROTOCOL.md derived-output rules. */
export function analyzeTags(tags: Tag[]): FlvAnalysis {
  const problems: string[] = [];
  const video = tags.filter((t) => t.type === 9), audio = tags.filter((t) => t.type === 8), script = tags.filter((t) => t.type === 18);
  const meta = script[0];
  if (!meta) problems.push("no onMetaData script tag");
  else {
    // RTMP publishers send ["@setDataFrame","onMetaData",{...}]; FLV files carry ["onMetaData",{...}]. Accept both.
    const v = decodeAmf(meta.body); const name = v[0] === "@setDataFrame" ? v[1] : v[0];
    if (name !== "onMetaData") problems.push(`first script tag is ${String(v[0])}, expected onMetaData`);
  }
  const vh = video[0];
  if (!vh) problems.push("no video tags");
  else if ((vh.body[0]! & 0x0f) !== 7 || vh.body[1] !== 0) problems.push("first video tag is not an AVC sequence header");
  const ah = audio[0];
  if (!ah) problems.push("no audio tags");
  else if (ah.body[0]! >> 4 !== 10 || ah.body[1] !== 0) problems.push("first audio tag is not an AAC sequence header");
  const firstMedia = video.find((t) => t.body[1] === 1);
  if (firstMedia && (firstMedia.body[0]! >> 4) !== 1) problems.push("first video NALU tag is not a keyframe");
  for (const [name, arr] of [["video", video], ["audio", audio]] as const) {
    let last = -1;
    for (const t of arr) { if (t.ts < last) { problems.push(`${name} timestamps go backwards (${last} -> ${t.ts})`); break; } last = t.ts; }
  }
  return { problems, video, audio, script };
}
