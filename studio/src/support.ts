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

/** Human-readable browser name from a user agent string (best effort; Edge/Brave/Opera before Chrome). */
export function detectBrowser(ua: string = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ""): string {
  const m = (re: RegExp) => ua.match(re)?.[1];
  if (!ua) return "unknown browser";
  if (/Edg\//.test(ua)) return `Microsoft Edge ${m(/Edg\/(\d+)/) ?? ""}`.trim();
  if (/OPR\//.test(ua)) return `Opera ${m(/OPR\/(\d+)/) ?? ""}`.trim();
  if (/Firefox\//.test(ua)) return `Firefox ${m(/Firefox\/(\d+)/) ?? ""}`.trim();
  if (/Chromium\//.test(ua)) return `Chromium ${m(/Chromium\/(\d+)/) ?? ""}`.trim();
  if (/Chrome\//.test(ua)) return `Chrome-based browser ${m(/Chrome\/(\d+)/) ?? ""} (${ua.includes("Brave") ? "Brave" : "Chrome or a Chromium build"})`.trim();
  if (/Safari\//.test(ua)) return `Safari ${m(/Version\/(\d+)/) ?? ""}`.trim();
  return ua.slice(0, 60);
}

export interface CodecProbe {
  video: boolean; audio: boolean;
  /** which H.264 configs the browser accepted: hardware / software / no preference */
  h264: { hardware: boolean; software: boolean; any: boolean };
  /** per-probe error text, when isConfigSupported threw */
  errors: string[];
}

/** Message for a failed codec probe: browser, which probe failed, what to do. Never blames the user's stream setup. */
export function codecFailureMessage(p: CodecProbe, ua?: string): string | null {
  const browser = detectBrowser(ua);
  const todo = "Open the studio in Google Chrome (recent version) or use the Koinonia desktop app, then try again.";
  if (!p.video) {
    const tried = `H.264 (avc1.640028, ${p.h264.hardware ? "hardware ok" : "hardware failed"}, ${p.h264.software ? "software ok" : "software failed"}, default ${p.h264.any ? "ok" : "failed"})`;
    return `H.264 encoding is unavailable in ${browser}: the WebCodecs VideoEncoder probe failed for ${tried}${p.errors.length ? "; error: " + p.errors[0] : ""}. ${todo}`;
  }
  if (!p.audio) {
    return `AAC encoding is unavailable in ${browser}: the WebCodecs AudioEncoder probe failed for mp4a.40.2 (AAC-LC, 48 kHz stereo). Twitch and YouTube need AAC. ${todo}`;
  }
  return null;
}

/** Async probe: H.264 and AAC encoder configs actually supported (AAC is a known risk, plan phase 0). */
export async function probeCodecs(w: number, h: number, fps: number): Promise<CodecProbe> {
  const g = globalThis as unknown as {
    VideoEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
    AudioEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
  };
  const errors: string[] = [];
  const ok = async (enc: typeof g.VideoEncoder, cfg: unknown) => {
    if (!enc) { errors.push("encoder API missing"); return false; }
    try { return !!(await enc.isConfigSupported(cfg)).supported; } catch (e) { errors.push(String((e as Error).message ?? e)); return false; }
  };
  const v = (hw: string) => ok(g.VideoEncoder, { codec: "avc1.640028", width: w, height: h, framerate: fps, hardwareAcceleration: hw, latencyMode: "realtime", avc: { format: "avc" } });
  const [hardware, software, any] = [await v("prefer-hardware"), await v("prefer-software"), await v("no-preference")];
  const audio = await ok(g.AudioEncoder, { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 });
  return { video: hardware || software || any, audio, h264: { hardware, software, any }, errors };
}
