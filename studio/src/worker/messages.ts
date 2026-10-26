import type { SceneSnapshot } from "../scene";

export interface EncodeConfig { width: number; height: number; fps: number; videoBitrate: number; audioBitrate: number; keyframeSec: number }

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
  | { t: "chunk"; kind: "video" | "audio"; key: boolean; ptsUs: number; data: Uint8Array }
  | { t: "stats"; fps: number; dropped: number }
  | { t: "snap"; reqId: number; blob: Blob | null }
  | { t: "error"; msg: string };
