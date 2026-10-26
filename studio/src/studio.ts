import { ChatBuffer } from "./chat/ring";
import { MetricsStore } from "./metrics";
import { SceneState } from "./scene";
import { FLAG_KEY, Kind } from "./protocol";
import { Transport } from "./transport";
import { detectSupport, fallbackMessage, probeCodecs } from "./support";
import type { StudioApi } from "./tools/types";
import type { EncodeConfig, FromWorker, ToWorker } from "./worker/messages";

const CFG: EncodeConfig = { width: 1280, height: 720, fps: 30, videoBitrate: 3_000_000, audioBitrate: 128_000, keyframeSec: 2 };

export class Studio implements StudioApi {
  chat = new ChatBuffer(500);
  metrics = new MetricsStore();
  scenes = new SceneState();
  transport: Transport;
  private worker: Worker | null = null;
  private state = "idle";
  private streams: { cam?: MediaStream; screen?: MediaStream } = {};
  private audioTracks = new Map<string, MediaStreamTrack>();
  private polls = 0;
  private highlights: { id: number; t: number; label?: string }[] = [];
  private pinned: number[] = [];
  private snapWaiters = new Map<number, (b: Blob | null) => void>();
  private snapId = 0;
  log: (s: string) => void = () => {};
  support = detectSupport();

  constructor(daemonUrl?: string) {
    this.transport = new Transport(daemonUrl);
    this.transport.onStats = (s) => {
      if (typeof s.kbps === "number") this.metrics.push("kbps", s.kbps);
      if (typeof s.dropped === "number") this.metrics.push("dropped", s.dropped);
    };
    this.scenes.onChange((snap) => this.post({ t: "scene", snap }));
  }

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
    this.post({ t: "init", canvas: off, cfg: CFG }, [off]);
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
      video: { width: CFG.width, height: CFG.height, frameRate: CFG.fps },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
    this.streams.cam = s;
    const at = s.getAudioTracks()[0];
    if (at) this.audioTracks.set("mic", at);
    if (this.support.ok) { this.ensureWorker(); this.sendTracks("camera", s); this.sendAudio(at); }
    return s;
  }
  async enableScreen(): Promise<MediaStream> {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: CFG.fps }, audio: true });
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
      case "config": this.transport.send(m.kind === "video" ? Kind.CONFIG_VIDEO : Kind.CONFIG_AUDIO, 0, 0, m.data); break;
      case "chunk": this.transport.send(m.kind === "video" ? Kind.VIDEO : Kind.AUDIO, m.key ? FLAG_KEY : 0, m.ptsUs, m.data); break;
      case "stats":
        this.metrics.push("fps", m.fps); this.metrics.push("enc_dropped", m.dropped);
        this.metrics.push("ws_dropped", this.transport.droppedForBackpressure);
        break;
      case "snap": this.snapWaiters.get(m.reqId)?.(m.blob); this.snapWaiters.delete(m.reqId); break;
      case "error": this.log("worker: " + m.msg); this.metrics.push("errors", 1); break;
    }
  }

  async startStream(targets?: string[]) {
    if (this.state === "live") return { state: "live" };
    if (!this.support.ok) return { state: "unsupported", detail: this.supportMessage };
    if (!this.worker) return { state: "error", detail: "enable camera or screen first" };
    const codecs = await probeCodecs(CFG.width, CFG.height, CFG.fps);
    if (!codecs.video) return { state: "unsupported", detail: "H.264 encoding unavailable in this browser" };
    if (!codecs.audio) return { state: "unsupported", detail: "AAC encoding unavailable (WebCodecs AAC needs Chrome on Win/macOS or recent builds); Opus fallback needs daemon transcode (not implemented)" };
    try { await this.transport.connect({ video: CFG, targets: targets ?? ["twitch", "youtube"] }); }
    catch (e) { return { state: "error", detail: (e as Error).message }; }
    this.transport.control({ op: "start", targets });
    this.post({ t: "start" });
    this.state = "live";
    return { state: "live" };
  }
  async stopStream() {
    this.post({ t: "stop" });
    this.transport.control({ op: "stop" });
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

  // Platform actions are stubbed: forwarded to the daemon as control messages; no Twitch/YouTube API yet.
  createPoll(q: string, options: string[], durationSec: number) {
    const id = ++this.polls;
    this.transport.control({ op: "create_poll", id, q, options, durationSec });
    return { id };
  }
  pinMessage(id: number) {
    if (!this.chat.get(id)) return false;
    this.pinned.push(id);
    this.transport.control({ op: "pin_message", id });
    return true;
  }
  markHighlight(label?: string) {
    const h = { id: this.highlights.length + 1, t: this.now(), label };
    this.highlights.push(h);
    this.transport.control({ op: "mark_highlight", ...h });
    return { id: h.id, t: h.t };
  }
  async exportClip(secondsBack: number, title?: string) {
    const id = "clip-" + this.now().toString(36);
    const sent = this.transport.control({ op: "export_clip", id, secondsBack, title });
    return { id, state: sent ? "requested" : "daemon_offline" };
  }
}
