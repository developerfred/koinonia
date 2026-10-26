/// <reference lib="webworker" />
import type { EncodeConfig, FromWorker, ToWorker } from "./messages";
import type { Layer, SceneSnapshot } from "../scene";

const ctxW = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, tr: Transferable[] = []) => ctxW.postMessage(m, tr);

let canvas!: OffscreenCanvas;
let g!: OffscreenCanvasRenderingContext2D;
let cfg!: EncodeConfig;
let snap: SceneSnapshot = { scene: "main", layers: [] };
const latest: Partial<Record<"camera" | "screen", VideoFrame>> = {};
let venc: VideoEncoder | null = null;
let aenc: AudioEncoder | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let live = false;
let frameN = 0, dropped = 0, renderedSince = 0, lastStats = 0;
let t0 = 0;
/** audio capture clock -> session clock offset (us), fixed on the first audio sample after start */
let audioBase: number | null = null;
let audioChunks = 0;

async function pump<T extends VideoFrame | AudioData>(stream: ReadableStream<T>, on: (v: T) => void) {
  const r = stream.getReader();
  try { for (;;) { const { value, done } = await r.read(); if (done) break; on(value); } }
  catch (e) { post({ t: "error", msg: String(e) }); }
}

function draw() {
  g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height);
  for (const l of snap.layers) {
    if (!l.visible) continue;
    g.globalAlpha = l.opacity;
    drawLayer(l);
  }
  g.globalAlpha = 1;
}
function drawLayer(l: Layer) {
  const x = l.x * canvas.width, y = l.y * canvas.height, w = l.w * canvas.width, h = l.h * canvas.height;
  if (l.source === "text") {
    if (!l.text) return;
    g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(x, y, w, h);
    g.fillStyle = "#fff"; g.font = `${Math.round(h * 0.5)}px system-ui`; g.textBaseline = "middle";
    g.fillText(l.text, x + h * 0.25, y + h / 2, w - h * 0.5);
    return;
  }
  if (l.source === "camera" || l.source === "screen") {
    const f = latest[l.source];
    if (f) g.drawImage(f, x, y, w, h); // NOTE: stretches; aspect-fit is a TODO
  }
  // "image" layers: stubbed
}

function reportStats() {
  const now = performance.now();
  if (now - lastStats <= 1000) return;
  post({ t: "stats", fps: Math.round((renderedSince * 1000) / (now - lastStats || 1)), dropped, encQueue: venc?.encodeQueueSize ?? 0, aacEncoded: audioChunks });
  renderedSince = 0; lastStats = now;
}

function tick() {
  draw(); renderedSince++;
  if (live && venc) {
    if (venc.encodeQueueSize > 4) dropped++;
    else {
      const ts = Math.round((performance.now() - t0) * 1000);
      const vf = new VideoFrame(canvas, { timestamp: ts });
      const key = frameN % Math.max(1, cfg.fps * cfg.keyframeSec) === 0;
      try { venc.encode(vf, { keyFrame: key }); frameN++; }
      catch (e) { post({ t: "error", msg: "video encode: " + String(e) }); }
      vf.close();
    }
  }
  reportStats();
}

/** AAC encoder is configured for 48 kHz stereo (what `start` announces). Mono mics are common: duplicate to both channels. */
let audioWarned = false;
function toStereo48k(a: AudioData): AudioData | null {
  if (a.sampleRate !== 48000) {
    if (!audioWarned) { audioWarned = true; post({ t: "error", msg: `audio sample rate ${a.sampleRate} unsupported (need 48000)` }); }
    return null;
  }
  if (a.numberOfChannels === 2) return a;
  const n = a.numberOfFrames;
  const buf = new Float32Array(n * 2);
  a.copyTo(buf.subarray(0, n), { planeIndex: 0, format: "f32-planar" });
  if (a.numberOfChannels > 1) a.copyTo(buf.subarray(n), { planeIndex: 1, format: "f32-planar" });
  else buf.copyWithin(n, 0, n);
  return new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: a.timestamp, data: buf });
}

function startEncoders() {
  venc = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d) post({ t: "config", kind: "video", data: new Uint8Array(d as ArrayBuffer).slice() });
      const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
      post({ t: "chunk", kind: "video", key: chunk.type === "key", dtsMs: Math.round(chunk.timestamp / 1000), ctsMs: 0, data: buf }, [buf.buffer]);
    },
    error: (e) => post({ t: "error", msg: "video encoder: " + e.message }),
  });
  venc.configure({
    codec: "avc1.640028", width: cfg.width, height: cfg.height, framerate: cfg.fps, bitrate: cfg.videoBitrate,
    hardwareAcceleration: "prefer-hardware", latencyMode: "realtime", avc: { format: "avc" },
  });
  aenc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d) post({ t: "config", kind: "audio", data: new Uint8Array(d as ArrayBuffer).slice() });
      const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
      audioChunks++;
      post({ t: "chunk", kind: "audio", key: true, dtsMs: Math.max(0, Math.round((chunk.timestamp - (audioBase ?? 0)) / 1000)), ctsMs: 0, data: buf }, [buf.buffer]);
    },
    error: (e) => post({ t: "error", msg: "audio encoder: " + e.message }),
  });
  aenc.configure({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: cfg.audioBitrate });
}

ctxW.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.t) {
    case "init":
      canvas = m.canvas; cfg = m.cfg; canvas.width = cfg.width; canvas.height = cfg.height;
      g = canvas.getContext("2d")!;
      timer = setInterval(tick, 1000 / cfg.fps); // worker timers are not throttled like page rAF
      break;
    case "source":
      latest[m.id]?.close(); delete latest[m.id];
      if (m.stream) void pump(m.stream, (f) => { latest[m.id]?.close(); latest[m.id] = f; });
      break;
    case "audio":
      if (m.stream) void pump(m.stream, (a) => {
        if (live && aenc && aenc.state === "configured") {
          // Capture-clock timestamps are unrelated to the video clock (performance.now() - t0): rebase on first sample.
          if (audioBase === null) audioBase = a.timestamp - (performance.now() - t0) * 1000;
          const st = toStereo48k(a);
          if (st) { try { aenc.encode(st); } catch (e) { post({ t: "error", msg: "audio encode: " + String(e) }); } if (st !== a) st.close(); }
        }
        a.close();
      });
      break;
    case "scene": snap = m.snap; break;
    case "start": startEncoders(); frameN = 0; dropped = 0; audioBase = null; audioChunks = 0; t0 = performance.now(); live = true;
      post({ t: "started", wallStartMs: performance.timeOrigin + t0 }); break;
    case "stop":
      live = false;
      try { await venc?.flush(); await aenc?.flush(); } catch { /* ignore */ }
      venc?.close(); aenc?.close(); venc = aenc = null;
      break;
    case "snap": {
      const w = Math.min(m.width, canvas.width), h = Math.round((w * canvas.height) / canvas.width);
      const oc = new OffscreenCanvas(w, h);
      oc.getContext("2d")!.drawImage(canvas, 0, 0, w, h);
      const blob = await oc.convertToBlob({ type: "image/jpeg", quality: m.quality }).catch(() => null);
      post({ t: "snap", reqId: m.reqId, blob });
      break;
    }
  }
};
void timer;
