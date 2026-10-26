import type { CaptionCue, CaptionStyle } from "./captions.js";
import type { CropPlan } from "./reframe.js";
import type { Moment, Ms } from "./types.js";

export type ExportStepKind = "extract" | "decode" | "crop" | "scale" | "captions" | "loudnorm" | "encode" | "mux";

export interface ExportJob {
  version: 1;
  id: string;
  createdAtMs: number;
  source: {
    /** Opaque reference resolved by the daemon (e.g. ring-buffer id or file path). */
    ref: string;
    startMs: Ms;
    endMs: Ms;
  };
  output: {
    container: "mp4";
    width: number;
    height: number;
    fps: number;
    /** WebCodecs codec strings. */
    videoCodec: string;
    videoBitrate: number;
    audioCodec: string;
    audioBitrate: number;
    sampleRate: number;
    /** Where the executor should leave the result (opaque ref). */
    destRef: string;
  };
  /** Crop windows are relative to the source timeline (tMs absolute). */
  crop: CropPlan;
  captions: { cues: CaptionCue[]; style: CaptionStyle; /** cue times are relative to clip start */ relativeToClipStart: true } | null;
  audio: { targetLufs: number | null };
  steps: ExportStepKind[];
  metadata: { title: string; description?: string; momentId?: string; hashtags?: string[] };
}

export interface BuildJobInput {
  id: string;
  sourceRef: string;
  destRef: string;
  moment: Pick<Moment, "id" | "startMs" | "endMs">;
  crop: CropPlan;
  captions?: { cues: CaptionCue[]; style: CaptionStyle } | null;
  title: string;
  description?: string;
  hashtags?: string[];
  now?: () => number;
  output?: Partial<ExportJob["output"]>;
  targetLufs?: number | null;
}

export function buildExportJob(i: BuildJobInput): ExportJob {
  const steps: ExportStepKind[] = ["extract", "decode", "crop", "scale"];
  if (i.captions) steps.push("captions");
  if (i.targetLufs !== null) steps.push("loudnorm");
  steps.push("encode", "mux");
  return {
    version: 1,
    id: i.id,
    createdAtMs: (i.now ?? Date.now)(),
    source: { ref: i.sourceRef, startMs: i.moment.startMs, endMs: i.moment.endMs },
    output: { container: "mp4", width: 1080, height: 1920, fps: 30, videoCodec: "avc1.640028", videoBitrate: 8_000_000, audioCodec: "mp4a.40.2", audioBitrate: 128_000, sampleRate: 48000, destRef: i.destRef, ...i.output },
    crop: i.crop,
    captions: i.captions ? { ...i.captions, relativeToClipStart: true } : null,
    audio: { targetLufs: i.targetLufs === undefined ? -14 : i.targetLufs },
    steps,
    metadata: { title: i.title, description: i.description, momentId: i.moment.id, hashtags: i.hashtags },
  };
}

export interface JobIssue {
  severity: "error" | "warning";
  message: string;
}

export function validateExportJob(job: ExportJob, limits: { maxDurationMs?: Ms; minDurationMs?: Ms } = {}): JobIssue[] {
  const issues: JobIssue[] = [];
  const d = job.source.endMs - job.source.startMs;
  if (d <= 0) issues.push({ severity: "error", message: "source range is empty" });
  if (d > (limits.maxDurationMs ?? 180_000)) issues.push({ severity: "error", message: `duration ${d}ms exceeds max` });
  if (d < (limits.minDurationMs ?? 3000)) issues.push({ severity: "warning", message: "clip shorter than 3s" });
  if (job.output.width * 16 !== job.output.height * 9) issues.push({ severity: "error", message: "output is not 9:16" });
  if (!job.crop.keyframes.length) issues.push({ severity: "error", message: "crop plan has no keyframes" });
  const k = job.crop.keyframes;
  if (k.length && (k[0]!.tMs > job.source.startMs + 500 || k[k.length - 1]!.tMs < job.source.endMs - 500)) issues.push({ severity: "warning", message: "crop plan does not cover the whole source range" });
  if (!job.captions) issues.push({ severity: "warning", message: "no captions" });
  return issues;
}

export type ExportProgress = { step: ExportStepKind; fraction: number };

/** Implemented by the studio (WebCodecs worker) or daemon. */
export interface ExportExecutor {
  run(job: ExportJob, onProgress?: (p: ExportProgress) => void): Promise<{ destRef: string; bytes: number; durationMs: Ms }>;
}

export async function runExport(executor: ExportExecutor, job: ExportJob, onProgress?: (p: ExportProgress) => void) {
  const errors = validateExportJob(job).filter((i) => i.severity === "error");
  if (errors.length) throw new Error(`invalid export job: ${errors.map((e) => e.message).join("; ")}`);
  return executor.run(job, onProgress);
}
