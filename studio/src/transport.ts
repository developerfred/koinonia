import { FLAG_KEY, Kind, decodeFrame, encodeFrame, jsonPayload, parseJsonPayload, type KindValue } from "./protocol";

export type DaemonStatus = { type: string; [k: string]: unknown };
export type TransportState = "connecting" | "open" | "closed";

export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:7878/ingest";

/** Body of the protocol `start` frame (daemon/PROTOCOL.md). Stream keys never travel here. */
export interface StartParams {
  destinations?: string[];
  width: number; height: number; fps: number;
  video_kbps: number; audio_kbps: number;
  sample_rate: number; channels: number;
}

export class Transport {
  private ws: WebSocket | null = null;
  private waiters: { type: string; res: (s: DaemonStatus) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  onStatus: (s: DaemonStatus) => void = () => {};
  onState: (s: TransportState) => void = () => {};
  /** drop non-key media when the socket buffer exceeds this (backpressure) */
  maxBuffered = 4 * 1024 * 1024;
  droppedForBackpressure = 0;
  lastStatus: DaemonStatus | null = null;

  constructor(private url = DEFAULT_DAEMON_URL) {}
  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /**
   * Opens the socket, waits for the daemon's `ready`, sends `start` (must be the first frame) and
   * waits for `started` (or an `error`, which rejects).
   */
  async connect(start: StartParams, timeoutMs = 5000): Promise<DaemonStatus> {
    // The daemon sends `ready` right after the upgrade: arm the waiter before the socket exists.
    const ready = this.expect("ready", timeoutMs);
    ready.catch(() => {});
    await new Promise<void>((res, rej) => {
      this.onState("connecting");
      const ws = (this.ws = new WebSocket(this.url));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { this.onState("open"); res(); };
      ws.onerror = () => rej(new Error(`cannot reach daemon at ${this.url.replace(/token=[^&]*/, "token=***")} (is koinonia-d running?)`));
      ws.onclose = (e) => { this.onState("closed"); this.flushWaiters({ type: "closed", code: e.code }); };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return; // daemon only sends binary frames
        try {
          const f = decodeFrame(new Uint8Array(e.data));
          if (f.kind !== Kind.STATUS) return;
          const s = parseJsonPayload(f.payload) as DaemonStatus | null;
          if (s && typeof s.type === "string") this.dispatch(s);
        } catch { /* ignore malformed status */ }
      };
    });
    await ready;
    const started = this.expect("started", timeoutMs, true);
    this.sendControl(Kind.START, start);
    const s = await started;
    if (s.type === "error") throw new Error(String(s.message ?? "daemon error"));
    if (s.type === "closed") throw new Error("daemon closed the connection");
    return s;
  }

  private dispatch(s: DaemonStatus) {
    this.lastStatus = s;
    this.waiters = this.waiters.filter((w) => {
      if (w.type === s.type || (s.type === "error" && w.type !== "stats")) { clearTimeout(w.timer); w.res(s); return false; }
      return true;
    });
    this.onStatus(s);
  }
  private flushWaiters(s: DaemonStatus) { for (const w of this.waiters) { clearTimeout(w.timer); w.res(s); } this.waiters = []; }

  private expect(type: string, ms: number, resolveOnError = false): Promise<DaemonStatus> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w.res !== wrap); rej(new Error(`daemon did not answer '${type}' in ${ms}ms`)); }, ms);
      const wrap = (s: DaemonStatus) => (s.type === "error" && !resolveOnError ? rej(new Error(String(s.message ?? "daemon error"))) : res(s));
      this.waiters.push({ type, res: wrap, timer });
    });
  }

  /** Low-level frame send. Media is dropped (never queued unbounded) when the socket is backed up. */
  send(kind: KindValue, flags: number, dtsMs: number, ctsOffsetMs: number, payload: Uint8Array): boolean {
    if (!this.open) return false;
    const media = kind === Kind.VIDEO_CHUNK || kind === Kind.AUDIO_CHUNK;
    if (media && this.ws!.bufferedAmount > this.maxBuffered && !(flags & FLAG_KEY)) { this.droppedForBackpressure++; return false; }
    this.ws!.send(encodeFrame({ kind, flags, dtsMs, ctsOffsetMs, payload }));
    return true;
  }
  private sendControl(kind: KindValue, body?: unknown): boolean {
    return this.send(kind, 0, 0, 0, body === undefined ? new Uint8Array(0) : jsonPayload(body));
  }

  /** Ask the daemon to write an MPEG-TS clip from its ring buffer; resolves with the `clip` status. */
  async clip(secondsBack: number, title?: string, timeoutMs = 15000): Promise<DaemonStatus> {
    if (!this.open) return { type: "error", message: "daemon_offline" };
    const p = this.expect("clip", timeoutMs, true).catch((e: Error) => ({ type: "error", message: e.message }) as DaemonStatus);
    this.sendControl(Kind.CLIP, { seconds_back: secondsBack, ...(title ? { title } : {}) });
    return p;
  }
  stop() { this.sendControl(Kind.STOP); }
  close() { this.ws?.close(); this.ws = null; this.flushWaiters({ type: "closed" }); }
}
