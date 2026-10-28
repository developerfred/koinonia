import { ChatBuffer } from "./chat/ring";
import { MetricsStore } from "./metrics";
import { SceneState } from "./scene";
import { FLAG_KEY, Kind } from "./protocol";
import { Transport, type DaemonStatus } from "./transport";
import { sanitizeCfg } from "./encoder-config";
import { ApprovalQueue } from "./approvals";
import { makeModExecutor, type ModConnector } from "./moderation";
import { TokenAccounting, type UsageEvent } from "./usage";
import { codecFailureMessage, detectSupport, fallbackMessage, probeCodecs } from "./support";
import type { StudioApi } from "./tools/types";
import type { EncodeConfig, FromWorker, ToWorker } from "./worker/messages";

export const DEFAULT_CFG: EncodeConfig = { width: 1280, height: 720, fps: 30, videoBitrate: 3_000_000, audioBitrate: 128_000, keyframeSec: 2 };

export interface StudioOptions {
  daemonUrl?: string;
  /** shared secret for KOINONIA_TOKEN; sent as ?token= (loopback only) */
  token?: string;
  cfg?: Partial<EncodeConfig>;
}

/** Structural subset of connectors/ UnifiedChat used here. */
export interface UnifiedLike {
  onMessage(cb: (i: { message: { ts: number; platform: string; id: string; user: { id: string; name: string }; text: string } }) => void): () => void;
}

export class Studio implements StudioApi {
  chat = new ChatBuffer(500);
  metrics = new MetricsStore();
  scenes = new SceneState();
  approvals = new ApprovalQueue();
  tokens = new TokenAccounting();
  connectors = new Map<string, ModConnector>();
  transport: Transport;
  readonly cfg: EncodeConfig;
  /** wall clock (ms) of session t0 (dts 0) and counters for external measurement (qa / benchmarks) */
  diag = { wallStartMs: 0, framesEncoded: 0, workerFps: 0, encQueue: 0, aacChunks: 0, dests: {} as Record<string, string>, lastStatus: null as DaemonStatus | null, errors: [] as string[], encoder: "" as string, bitrateMode: "" as string, warnings: [] as string[], trace: false, log: [] as [number, number, number, number][], codecs: null as null | { video: boolean; audio: boolean } };
  private worker: Worker | null = null;
  private state = "idle";
  private streams: { cam?: MediaStream; screen?: MediaStream } = {};
  private audioTracks = new Map<string, MediaStreamTrack>();
  private polls = 0;
  private highlights: { id: number; t: number; label?: string }[] = [];
  private pinned: number[] = [];
  private localPolls: { id: number; q: string; options: string[]; durationSec: number; at: number }[] = [];
  private snapWaiters = new Map<number, (b: Blob | null) => void>();
  private snapId = 0;
  log: (s: string) => void = () => {};
  support = detectSupport();

  constructor(o: StudioOptions | string = {}) {
    const opt: StudioOptions = typeof o === "string" ? { daemonUrl: o } : o;
    this.cfg = sanitizeCfg({ ...DEFAULT_CFG, ...Object.fromEntries(Object.entries(opt.cfg ?? {}).filter(([, v]) => v !== undefined)) } as EncodeConfig);
    let url = opt.daemonUrl;
    if (url && opt.token && !/[?&]token=/.test(url)) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(opt.token);
    this.transport = new Transport(url);
    this.transport.onStatus = (s) => this.onDaemon(s);
    this.scenes.onChange((snap) => this.post({ t: "scene", snap }));
    this.approvals.executor = makeModExecutor(this.chat, () => this.connectors);
  }

  /** daemon `status` frames -> health metrics the panels/agents already read (kbps, dropped). */
  private onDaemon(s: DaemonStatus) {
    this.diag.lastStatus = s;
    if (s.type === "stats") {
      if (typeof s.in_kbps === "number") this.metrics.push("kbps", s.in_kbps);
      const d = s.dropped;
      if (d && typeof d === "object") this.metrics.push("dropped", Object.values(d as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0));
      if (s.dests && typeof s.dests === "object") Object.assign(this.diag.dests, s.dests);
    } else if (s.type === "dest" && typeof s.name === "string") {
      this.diag.dests[s.name] = String(s.state);
      if (s.state === "error") { this.metrics.push("errors", 1); this.log(`destino ${s.name}: ${String(s.error ?? "erro")}`); }
    } else if (s.type === "error") {
      this.metrics.push("errors", 1);
      this.diag.errors.push(String(s.message));
      this.log("daemon: " + String(s.message));
    }
  }

  /** Feed the chat buffer from connectors/ UnifiedChat (ids kept so moderation can address them). */
  attachChat(u: UnifiedLike, connectors: Record<string, ModConnector> = {}): () => void {
    for (const [k, c] of Object.entries(connectors)) this.connectors.set(k, c);
    return u.onMessage(({ message: m }) => {
      this.chat.push({ ts: m.ts, platform: m.platform, user: m.user.name, text: m.text, mid: m.id, uid: m.user.id });
      this.metrics.push("chat_msgs", 1);
    });
  }

  /** Agent token usage (bridge notification `tokens.usage`) -> ledger + "tokens" series read by the budget panel. */
  recordTokens(u: UsageEvent): void {
    this.metrics.push("tokens", this.tokens.record(u));
  }
  setTokenBudget(n: number) { this.tokens.budget = n; }

  now() { return Date.now(); }
  streamState() { return this.state; }
  get supportMessage() { return fallbackMessage(this.support); }

  private post(m: ToWorker, tr: Transferable[] = []) { this.worker?.postMessage(m, tr); }

  /** Creates worker + offscreen canvas. Preview is a separate on-page canvas fed via captureStream? (stubbed: preview = raw camera). */
  private ensureWorker() {
    if (this.worker) return;
    const canvas = document.createElement("canvas");
    const off = canvas.transferControlToOffscreen();
    const w = (this.worker = new Worker(new URL("./worker/compositor.worker.ts", import.meta.url), { type: "module" }));
    w.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    this.post({ t: "init", canvas: off, cfg: this.cfg }, [off]);
    this.post({ t: "scene", snap: this.scenes.snapshot() });
  }

  private sendTracks(id: "camera" | "screen", s: MediaStream) {
    const P = (globalThis as unknown as { MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const vt = s.getVideoTracks()[0];
    if (!vt) return;
    const readable = new P({ track: vt }).readable;
    this.post({ t: "source", id, stream: readable }, [readable as unknown as Transferable]);
  }

  async enableCamera(): Promise<MediaStream> {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { width: this.cfg.width, height: this.cfg.height, frameRate: this.cfg.fps },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
    this.streams.cam = s;
    const at = s.getAudioTracks()[0];
    if (at) this.audioTracks.set("mic", at);
    if (this.support.ok) { this.ensureWorker(); this.sendTracks("camera", s); this.sendAudio(at); }
    return s;
  }
  async enableScreen(): Promise<MediaStream> {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: this.cfg.fps }, audio: true });
    this.streams.screen = s;
    const at = s.getAudioTracks()[0];
    if (at) this.audioTracks.set("screen", at); // NOTE: only one audio track feeds the encoder today (mixing stubbed)
    if (this.support.ok) { this.ensureWorker(); this.sendTracks("screen", s); }
    return s;
  }
  private sendAudio(t?: MediaStreamTrack) {
    if (!t) return;
    const P = (globalThis as unknown as { MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> } }).MediaStreamTrackProcessor;
    const readable = new P({ track: t }).readable;
    this.post({ t: "audio", stream: readable }, [readable as unknown as Transferable]);
  }

  private onWorker(m: FromWorker) {
    switch (m.t) {
      case "config": this.transport.send(m.kind === "video" ? Kind.VIDEO_CONFIG : Kind.AUDIO_CONFIG, 0, 0, 0, m.data); break;
      case "chunk":
        if (m.kind === "video") this.diag.framesEncoded++; else this.diag.aacChunks++;
        // [0=video|1=audio, dts_ms, wall ms when handed to the socket, bytes]; only while tracing (benchmarks)
        if (this.diag.trace && this.diag.log.length < 200_000) this.diag.log.push([m.kind === "video" ? 0 : 1, m.dtsMs, Date.now(), m.data.byteLength]);
        this.transport.send(m.kind === "video" ? Kind.VIDEO_CHUNK : Kind.AUDIO_CHUNK, m.key && m.kind === "video" ? FLAG_KEY : 0, m.dtsMs, m.ctsMs, m.data);
        break;
      case "encoder": this.diag.encoder = m.mode; this.diag.bitrateMode = m.bitrateMode; break;
      case "warn": this.log("worker: " + m.msg); this.diag.warnings.push(m.msg); break;
      case "started": this.diag.wallStartMs = m.wallStartMs; break;
      case "stats":
        this.diag.workerFps = m.fps; this.diag.encQueue = m.encQueue;
        this.metrics.push("fps", m.fps); this.metrics.push("enc_dropped", m.dropped);
        this.metrics.push("ws_dropped", this.transport.droppedForBackpressure);
        break;
      case "snap": this.snapWaiters.get(m.reqId)?.(m.blob); this.snapWaiters.delete(m.reqId); break;
      case "error": this.log("worker: " + m.msg); this.diag.errors.push(m.msg); this.metrics.push("errors", 1); break;
    }
  }

  async startStream(targets?: string[]) {
    if (this.state === "live") return { state: "live" };
    if (!this.support.ok) return { state: "unsupported", detail: this.supportMessage };
    if (!this.worker) return { state: "error", detail: "enable camera or screen first" };
    const codecs = await probeCodecs(this.cfg.width, this.cfg.height, this.cfg.fps);
    this.diag.codecs = codecs;
    const why = codecFailureMessage(codecs);
    if (why) return { state: "unsupported", detail: why };
    const c = this.cfg;
    try {
      await this.transport.connect({
        destinations: targets?.length ? targets : undefined, // absent = every destination configured in the daemon
        width: c.width, height: c.height, fps: c.fps,
        video_kbps: Math.round(c.videoBitrate / 1000), audio_kbps: Math.round(c.audioBitrate / 1000),
        sample_rate: 48000, channels: 2,
      });
    } catch (e) { this.transport.close(); return { state: "error", detail: (e as Error).message }; }
    this.post({ t: "start" });
    this.state = "live";
    return { state: "live" };
  }
  async stopStream() {
    this.post({ t: "stop" });
    // give the worker's flush a moment to emit its last chunks before STOP ends the session
    await new Promise((r) => setTimeout(r, 300));
    this.transport.stop();
    this.transport.close();
    this.state = "idle";
    return { state: "idle" };
  }

  setAudio(source: string, p: { muted?: boolean; volume?: number }) {
    const t = this.audioTracks.get(source);
    if (!t) return false;
    if (p.muted !== undefined) t.enabled = !p.muted;
    // volume: stubbed (needs WebAudio GainNode graph feeding the encoder)
    return true;
  }

  async captureFrame(o: { width: number; quality: number }) {
    if (!this.worker) return null;
    const id = ++this.snapId;
    const blob = await new Promise<Blob | null>((res) => {
      this.snapWaiters.set(id, res);
      this.post({ t: "snap", reqId: id, width: o.width, quality: o.quality });
      setTimeout(() => { if (this.snapWaiters.delete(id)) res(null); }, 3000);
    });
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { mime: blob.type, b64: btoa(bin) };
  }

  // Polls and pins have no platform API behind them yet: they are recorded locally only (documented gap).
  createPoll(q: string, options: string[], durationSec: number) {
    const id = ++this.polls;
    this.localPolls.push({ id, q, options, durationSec, at: this.now() });
    return { id };
  }
  pinMessage(id: number) {
    if (!this.chat.get(id)) return false;
    this.pinned.push(id);
    return true;
  }
  markHighlight(label?: string) {
    const h = { id: this.highlights.length + 1, t: this.now(), label };
    this.highlights.push(h);
    return { id: h.id, t: h.t };
  }
  async exportClip(secondsBack: number, title?: string) {
    const id = "clip-" + this.now().toString(36);
    if (!this.transport.open) return { id, state: "daemon_offline" };
    const r = await this.transport.clip(secondsBack, title);
    if (r.type === "clip" && r.ok) return { id, state: "saved", path: String(r.path), seconds: Number(r.seconds) };
    return { id, state: "failed", error: String(r.message ?? r.type) };
  }
}
