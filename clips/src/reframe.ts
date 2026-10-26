import type { Box, Ms } from "./types.js";

export interface Detection extends Box {
  kind: "face" | "subject";
  confidence: number;
  /** Optional track id (e.g. active speaker) so callers can bias towards it. */
  trackId?: string;
}

export interface FrameDetections {
  tMs: Ms;
  boxes: Detection[];
}

export interface ReframeOptions {
  srcWidth: number;
  srcHeight: number;
  /** Output aspect ratio w/h. Default 9/16. */
  aspect: number;
  /** Planner sampling step for keyframes. */
  stepMs: Ms;
  /** EMA factor per step in (0,1]; lower = smoother. */
  smoothing: number;
  /** No movement while the target stays inside this fraction of the crop size from the current center. */
  deadzone: number;
  /** Max pan speed in px/s of source. */
  maxSpeedPxPerSec: number;
  /** Faces outweigh generic subjects by this factor. */
  faceBias: number;
  minConfidence: number;
  /** Keep tracking the last known target this long after detections vanish, then ease to `fallback`. */
  holdMs: Ms;
  /** Where to rest with nothing detected: 0..1 along the free axis. */
  fallback: number;
  /** Fraction of the target box height to keep a face headroom offset on the vertical axis (portrait sources only). */
  headroom: number;
  /** When several people are visible, include them all if they fit in the crop; otherwise follow `preferTrackId`/largest. */
  preferTrackId?: string;
}

export const DEFAULT_REFRAME: Omit<ReframeOptions, "srcWidth" | "srcHeight"> = {
  aspect: 9 / 16,
  stepMs: 100,
  smoothing: 0.15,
  deadzone: 0.12,
  maxSpeedPxPerSec: 900,
  faceBias: 2,
  minConfidence: 0.4,
  holdMs: 1500,
  fallback: 0.5,
  headroom: 0,
};

export interface CropKeyframe {
  tMs: Ms;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropPlan {
  srcWidth: number;
  srcHeight: number;
  /** Output pixel size of the final clip. */
  outWidth: number;
  outHeight: number;
  /** Linear interpolation between keyframes (ordered, evenly spaced). */
  keyframes: CropKeyframe[];
  interpolation: "linear";
}

/** Target (center along the free axis) from one frame's detections, or null if none usable. */
function pickTarget(boxes: Detection[], o: ReframeOptions, axis: "x" | "y", cropSize: number): number | null {
  const good = boxes.filter((b) => b.confidence >= o.minConfidence);
  if (!good.length) return null;
  const weight = (b: Detection) => b.confidence * b.w * b.h * (b.kind === "face" ? o.faceBias : 1) * (o.preferTrackId && b.trackId === o.preferTrackId ? 4 : 1);
  const lo = (b: Detection) => (axis === "x" ? b.x : b.y);
  const len = (b: Detection) => (axis === "x" ? b.w : b.h);
  // Try keeping everyone in frame.
  const minV = Math.min(...good.map(lo));
  const maxV = Math.max(...good.map((b) => lo(b) + len(b)));
  if (maxV - minV <= cropSize) return (minV + maxV) / 2;
  // Otherwise follow the heaviest box.
  const best = good.reduce((a, b) => (weight(b) > weight(a) ? b : a));
  let c = lo(best) + len(best) / 2;
  if (axis === "y" && o.headroom) c -= len(best) * o.headroom;
  return c;
}

export function planReframe(frames: FrameDetections[], startMs: Ms, endMs: Ms, opts: Partial<ReframeOptions> & { srcWidth: number; srcHeight: number }): CropPlan {
  const o: ReframeOptions = { ...DEFAULT_REFRAME, ...opts };
  const { srcWidth: W, srcHeight: H } = o;
  const wide = W / H >= o.aspect;
  const cropW = wide ? Math.round(H * o.aspect) : W;
  const cropH = wide ? H : Math.round(W / o.aspect);
  const axis: "x" | "y" = wide ? "x" : "y";
  const cropSize = wide ? cropW : cropH;
  const full = wide ? W : H;
  const free = full - cropSize;
  const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
  const keyframes: CropKeyframe[] = [];

  let center = free * o.fallback + cropSize / 2;
  let lastTarget: number | null = null;
  let lastSeen = -Infinity;
  let initialized = false;
  let fi = 0;
  let current: Detection[] = [];
  const dt = o.stepMs / 1000;
  for (let t = startMs; t <= endMs + 1e-6; t += o.stepMs) {
    while (fi < sorted.length && sorted[fi]!.tMs <= t) {
      current = sorted[fi]!.boxes;
      if (current.some((b) => b.confidence >= o.minConfidence)) lastSeen = sorted[fi]!.tMs;
      fi++;
    }
    const fresh = t - lastSeen <= o.holdMs;
    const picked = fresh ? pickTarget(current, o, axis, cropSize) : null;
    let target: number;
    if (picked !== null) {
      lastTarget = picked;
      target = picked;
    } else if (lastTarget !== null && t - lastSeen <= o.holdMs) target = lastTarget;
    else target = free * o.fallback + cropSize / 2;
    if (!initialized && picked !== null) {
      center = Math.max(cropSize / 2, Math.min(full - cropSize / 2, picked)); // start on the subject, no opening pan
      initialized = true;
    }
    // deadzone, EMA, speed limit
    let next = center;
    if (Math.abs(target - center) > o.deadzone * cropSize) {
      next = center + (target - center) * o.smoothing;
      const maxStep = o.maxSpeedPxPerSec * dt;
      next = center + Math.max(-maxStep, Math.min(maxStep, next - center));
    }
    center = next;
    const pos = Math.max(0, Math.min(free, Math.round(center - cropSize / 2)));
    keyframes.push(wide ? { tMs: Math.round(t), x: pos, y: 0, w: cropW, h: cropH } : { tMs: Math.round(t), x: 0, y: pos, w: cropW, h: cropH });
  }
  return { srcWidth: W, srcHeight: H, outWidth: 1080, outHeight: 1920, keyframes, interpolation: "linear" };
}

export function cropAt(plan: CropPlan, tMs: Ms): CropKeyframe {
  const k = plan.keyframes;
  if (!k.length) throw new Error("empty crop plan");
  if (tMs <= k[0]!.tMs) return k[0]!;
  const last = k[k.length - 1]!;
  if (tMs >= last.tMs) return last;
  let lo = 0;
  let hi = k.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid]!.tMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = k[lo]!;
  const b = k[hi]!;
  const f = (tMs - a.tMs) / (b.tMs - a.tMs);
  return { tMs, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, w: a.w, h: a.h };
}
