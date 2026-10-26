/** All timestamps are milliseconds on a single session timeline (0 = start of recording buffer). */
export type Ms = number;

export interface ChatEvent {
  tMs: Ms;
  user: string;
  text: string;
  /** Emote names already resolved by the platform adapter (optional). */
  emotes?: string[];
}

/** Loudness sample, in dB (dBFS peak/RMS or LUFS short-term; only relative change matters). */
export interface AudioSample {
  tMs: Ms;
  db: number;
}

export interface Word {
  text: string;
  startMs: Ms;
  endMs: Ms;
  confidence?: number;
}

export interface TranscriptSegment {
  startMs: Ms;
  endMs: Ms;
  text: string;
  words?: Word[];
}

export type StreamEventType =
  | "raid"
  | "poll_start"
  | "poll_end"
  | "sub"
  | "subgift"
  | "cheer"
  | "scene"
  | "follow"
  | (string & {});

export interface StreamEvent {
  tMs: Ms;
  type: StreamEventType;
  /** Free-form payload, e.g. { viewers: 120 } for raids, { votes: 85 } for polls. */
  data?: Record<string, number | string>;
}

export type SignalName = "chatRate" | "chatBurst" | "audio" | "transcript" | "event";

export interface Reason {
  signal: SignalName;
  /** 0..1 strength of this signal in the moment's peak bucket. */
  score: number;
  /** Human-readable explanation. */
  text: string;
  atMs: Ms;
}

export interface Moment {
  id: string;
  startMs: Ms;
  endMs: Ms;
  peakMs: Ms;
  /** Fused score 0..1. */
  score: number;
  /** Max per-signal score inside the moment. */
  signals: Partial<Record<SignalName, number>>;
  reasons: Reason[];
  /** One-line explanation built from the reasons. */
  summary: string;
}

export interface Box {
  /** Pixels in source frame coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
}
