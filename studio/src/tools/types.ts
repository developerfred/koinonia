import type { ChatBuffer } from "../chat/ring";
import type { MetricsStore } from "../metrics";
import type { SceneState } from "../scene";
import type { ApprovalQueue } from "../approvals";
import type { TokenAccounting } from "../usage";

export interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean }
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/** Everything tools need from the studio; faked in tests. */
export interface StudioApi {
  chat: ChatBuffer;
  metrics: MetricsStore;
  scenes: SceneState;
  approvals: ApprovalQueue;
  tokens: TokenAccounting;
  setAudio(source: string, p: { muted?: boolean; volume?: number }): boolean;
  startStream(targets?: string[]): Promise<{ state: string; detail?: string }>;
  stopStream(): Promise<{ state: string }>;
  streamState(): string;
  captureFrame(opts: { width: number; quality: number }): Promise<{ mime: string; b64: string } | null>;
  createPoll(q: string, options: string[], durationSec: number): { id: number };
  pinMessage(id: number): boolean;
  markHighlight(label?: string): { id: number; t: number };
  exportClip(secondsBack: number, title?: string): Promise<{ id: string; state: string; path?: string; seconds?: number; error?: string }>;
  now(): number;
}
