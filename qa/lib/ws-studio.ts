// A fake "studio": speaks the browser->daemon framing over WebSocket, records daemon status frames.
import WebSocket from "ws";
import { fixture } from "./env";
import { encode, type Golden, type RefFrame } from "./golden";
import { mulberry32 } from "./prng.mjs";

export interface Studio {
  ws: WebSocket;
  status: any[];
  closed: Promise<{ code: number; reason: string }>;
  send(b: Uint8Array): void;
  waitStatus(pred: (s: any) => boolean, ms?: number, what?: string): Promise<any>;
  close(): void;
}

export function openStudio(url: string, headers?: Record<string, string>): Promise<Studio> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const status: any[] = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
    ws.on("message", (d, isBin) => { if (!isBin) { try { status.push(JSON.parse(d.toString())); } catch { /* ignore */ } } else { try { status.push(JSON.parse(Buffer.from(d as Buffer).subarray(10).toString())); } catch { /* ignore */ } } });
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode })));
    ws.on("open", () => resolve({
      ws, status, closed,
      send: (b) => ws.send(b),
      async waitStatus(pred, ms = 5000, what = "status") {
        const t0 = Date.now();
        for (;;) {
          const hit = status.find(pred); if (hit) return hit;
          if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; got ${JSON.stringify(status).slice(0, 400)}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      close: () => ws.close(),
    }));
  });
}

const golden = () => fixture<Golden>("protocol/golden.json");
export const goldenBytes = (name: string) => Uint8Array.from(Buffer.from(golden().valid.find((v) => v.name === name)!.bytes, "hex"));

/** The canonical session (without clip/stop) as raw frames, in order. */
export function goldenSession(): { name: string; bytes: Uint8Array }[] {
  return golden().valid.filter((v) => ["start", "video_config", "audio_config", "video_key", "audio_1", "video_p", "audio_2", "video_p_negcts"].includes(v.name))
    .map((v) => ({ name: v.name, bytes: Uint8Array.from(Buffer.from(v.bytes, "hex")) }));
}

export function mk(kind: number, flags: number, dts: number, cts: number, payload: Uint8Array): Uint8Array {
  return encode({ kind, flags, dts_ms: dts, cts_offset_ms: cts, payload } as RefFrame);
}

/** Deterministic media generator: `seconds` of 30 fps video (IDR every 2 s) + 48k/1024 AAC, interleaved by dts. */
export function* mediaFrames(seconds: number, opts: { seed?: number; videoBytes?: number } = {}): Generator<Uint8Array> {
  const r = mulberry32(opts.seed ?? 7);
  const vsize = opts.videoBytes ?? 6000;
  let v = 0, a = 0;
  const vEvery = 1000 / 30, aEvery = 1024 / 48;
  while (true) {
    const vt = Math.round(v * vEvery), at = Math.round(a * aEvery);
    if (Math.min(vt, at) >= seconds * 1000) return;
    if (vt <= at) {
      const key = v % 60 === 0;
      const n = key ? vsize * 4 : Math.max(8, Math.floor(vsize * (0.5 + r())));
      const body = new Uint8Array(n); for (let i = 0; i < n; i++) body[i] = (r() * 256) | 0;
      const nal = new Uint8Array(5 + n); new DataView(nal.buffer).setUint32(0, n + 1); nal[4] = key ? 0x65 : 0x41; nal.set(body, 5);
      yield mk(0x12, key ? 1 : 0, vt, 0, nal); v++;
    } else {
      const n = 150 + ((r() * 100) | 0); const p = new Uint8Array(n); for (let i = 0; i < n; i++) p[i] = (r() * 256) | 0;
      yield mk(0x13, 0, at, 0, p); a++;
    }
  }
}
