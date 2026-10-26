import raw from "./fixtures/session.json";
import type { AudioSample, ChatEvent, StreamEvent, TranscriptSegment } from "../src/types.js";

export interface Session {
  startMs: number;
  endMs: number;
  chat: ChatEvent[];
  audio: AudioSample[];
  transcript: TranscriptSegment[];
  events: StreamEvent[];
}
export const session = raw as unknown as Session;
