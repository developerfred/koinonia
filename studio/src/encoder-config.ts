import type { EncodeConfig } from "./worker/messages";

export type HwPref = "prefer-hardware" | "prefer-software";
export type BitrateMode = "constant" | "variable";

/**
 * Bitrate strategy for live. With variable rate control (the WebCodecs default) an encoder is free to spend far less
 * than the target on static content: a mostly still screen+camera scene was observed at 79-156 kbps against a 3000 kbps
 * target, and ingest sites (YouTube/Twitch) then warn about low bitrate. So live asks for `bitrateMode: "constant"`
 * and falls back to "variable" only if the browser rejects it. Constant mode is a target, not a guarantee: no filler
 * data is injected (padding would waste upload and some encoders ignore it), the 2 s keyframe cadence bounds how
 * long a destination can see a thin stream, and the health panel reports the measured kbps so the streamer can act.
 */
export function videoConfig(cfg: EncodeConfig, pref: HwPref, mode: BitrateMode): VideoEncoderConfig {
  return {
    codec: "avc1.640028", width: cfg.width, height: cfg.height, framerate: cfg.fps, bitrate: cfg.videoBitrate,
    hardwareAcceleration: pref, latencyMode: "realtime", avc: { format: "avc" }, bitrateMode: mode,
  } as VideoEncoderConfig;
}

/** Prefers constant; uses variable when constant is unsupported or the probe throws. */
export async function chooseBitrateMode(
  cfg: EncodeConfig, pref: HwPref,
  isSupported: (c: VideoEncoderConfig) => Promise<{ supported?: boolean }>,
): Promise<BitrateMode> {
  if (cfg.bitrateMode === "variable") return "variable";
  try {
    if ((await isSupported(videoConfig(cfg, pref, "constant"))).supported) return "constant";
  } catch { /* fall through */ }
  return "variable";
}

const even = (n: number) => n - (n % 2);
/**
 * Canvas and H.264 need positive integers (H.264 4:2:0 also wants even sizes). URL params / callers can hand us
 * fractions, NaN or strings; coerce instead of letting `canvas.width = x` throw "not of type unsigned long".
 */
export function sanitizeCfg(cfg: EncodeConfig): EncodeConfig {
  const int = (v: unknown, d: number, min: number, max: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : d;
  };
  return {
    ...cfg,
    width: Math.max(2, even(int(cfg.width, 1280, 2, 7680))), height: Math.max(2, even(int(cfg.height, 720, 2, 4320))),
    fps: int(cfg.fps, 30, 1, 120), videoBitrate: int(cfg.videoBitrate, 3_000_000, 50_000, 100_000_000),
    audioBitrate: int(cfg.audioBitrate, 128_000, 16_000, 512_000), keyframeSec: int(cfg.keyframeSec, 2, 1, 10),
  };
}
