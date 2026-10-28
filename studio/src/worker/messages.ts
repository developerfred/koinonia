import type { SceneSnapshot } from "../scene";

export interface EncodeConfig { width: number; height: number; fps: number; videoBitrate: number; audioBitrate: number; keyframeSec: number;
  /** auto = try hardware, fall back to software if it stalls (default) */
  /** benchmark switch: "variable" reproduces the old behaviour (default: constant, falling back to variable) */
  bitrateMode?: "constant" | "variable";
  encoder?: "auto" | "hardware" | "software" }

export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; cfg: EncodeConfig }
  | { t: "source"; id: "camera" | "screen"; stream: ReadableStream<VideoFrame> | null }
  | { t: "audio"; stream: ReadableStream<AudioData> | null }
  | { t: "scene"; snap: SceneSnapshot }
  | { t: "start" }
  | { t: "stop" }
  | { t: "snap"; reqId: number; width: number; quality: number };

export type FromWorker =
  | { t: "config"; kind: "video" | "audio"; data: Uint8Array }
  | { t: "chunk"; kind: "video" | "audio"; key: boolean; dtsMs: number; ctsMs: number; data: Uint8Array }
  | { t: "started"; wallStartMs: number }
  | { t: "stats"; fps: number; dropped: number; encQueue: number; aacEncoded: number }
  | { t: "snap"; reqId: number; blob: Blob | null }
  | { t: "encoder"; mode: "hardware" | "software"; bitrateMode: "constant" | "variable" }
  | { t: "warn"; msg: string }
  | { t: "error"; msg: string };
