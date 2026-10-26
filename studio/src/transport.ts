import { FLAG_KEY, Kind, encodeFrame, jsonPayload, type KindValue } from "./protocol";

export type ControlMsg = { op: string; [k: string]: unknown };

export class Transport {
  private ws: WebSocket | null = null;
  private seq = 0;
  onStats: (s: Record<string, unknown>) => void = () => {};
  onState: (s: "connecting" | "open" | "closed") => void = () => {};
  /** drop media when the socket buffer exceeds this (backpressure) */
  maxBuffered = 4 * 1024 * 1024;
  droppedForBackpressure = 0;

  constructor(private url = "ws://127.0.0.1:7777/ingest") {}
  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  connect(hello: Record<string, unknown>): Promise<void> {
    return new Promise((res, rej) => {
      this.onState("connecting");
      const ws = (this.ws = new WebSocket(this.url));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { this.seq = 0; this.send(Kind.HELLO, 0, 0, jsonPayload({ v: 1, ...hello })); this.onState("open"); res(); };
      ws.onerror = () => rej(new Error(`cannot reach daemon at ${this.url} (is koinonia-d running?)`));
      ws.onclose = () => this.onState("closed");
      ws.onmessage = (e) => {
        try { if (typeof e.data === "string") this.onStats(JSON.parse(e.data)); } catch { /* ignore */ }
      };
    });
  }
  send(kind: KindValue, flags: number, ptsUs: number, payload: Uint8Array): boolean {
    if (!this.open) return false;
    const media = kind === Kind.VIDEO || kind === Kind.AUDIO;
    if (media && this.ws!.bufferedAmount > this.maxBuffered && !(flags & FLAG_KEY)) { this.droppedForBackpressure++; return false; }
    this.ws!.send(encodeFrame({ kind, flags, seq: this.seq++, ptsUs, payload }));
    return true;
  }
  control(m: ControlMsg) { return this.send(Kind.CONTROL, 0, 0, jsonPayload(m)); }
  close() { this.ws?.close(); this.ws = null; }
}
