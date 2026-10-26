export interface Support { ok: boolean; missing: string[]; aacEncode?: boolean }

export function detectSupport(g: Record<string, unknown> = globalThis as never): Support {
  const missing: string[] = [];
  const need = (k: string, label = k) => { if (typeof g[k] === "undefined") missing.push(label); };
  need("VideoEncoder"); need("AudioEncoder"); need("OffscreenCanvas"); need("Worker");
  need("MediaStreamTrackProcessor"); need("WebSocket");
  return { ok: missing.length === 0, missing };
}

export function fallbackMessage(s: Support): string {
  if (s.ok) return "";
  return `This browser lacks: ${s.missing.join(", ")}. Use a recent Chromium-based browser (Chrome/Edge 94+). ` +
    `Preview and agent tools still work, but streaming is disabled.`;
}

/** Async probe: H.264 and AAC encoder configs actually supported (AAC is a known risk, plan phase 0). */
export async function probeCodecs(w: number, h: number, fps: number) {
  const g = globalThis as unknown as {
    VideoEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
    AudioEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
  };
  const video = g.VideoEncoder ? !!(await g.VideoEncoder.isConfigSupported({
    codec: "avc1.640028", width: w, height: h, framerate: fps, avc: { format: "avc" } }).catch(() => ({ supported: false }))).supported : false;
  const audio = g.AudioEncoder ? !!(await g.AudioEncoder.isConfigSupported({
    codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 }).catch(() => ({ supported: false }))).supported : false;
  return { video, audio };
}
