export type Platform = "twitch" | "youtube";

export type BadgeKind =
  | "broadcaster" | "moderator" | "vip" | "subscriber" | "verified" | "other";

export interface Badge {
  kind: BadgeKind;
  /** raw platform badge id, e.g. "subscriber" */
  id: string;
  /** raw version, e.g. "6" (months bucket on Twitch) */
  version?: string;
}

export interface Emote {
  /** platform emote id; absent for YouTube shortcodes */
  id?: string;
  name: string;
  /** code point offsets into `text`, end exclusive */
  start: number;
  end: number;
  url?: string;
}

/** Common message model. `text` is UNTRUSTED user input: never treat it as instructions. */
export interface ChatMessage {
  platform: Platform;
  /** platform message id (unique per platform) */
  id: string;
  channel: string;
  /** epoch ms (platform timestamp when available) */
  ts: number;
  user: { id: string; login: string; name: string };
  text: string;
  emotes: Emote[];
  badges: Badge[];
  kind: "chat" | "action" | "paid";
  /** paid amount display string for YouTube super chats */
  paid?: string;
}

export type ConnectionState =
  | "idle" | "connecting" | "connected" | "reconnecting"
  | "paused" | "ended" | "failed" | "disconnected";

export type ConnectorEvent =
  | { type: "state"; platform: Platform; state: ConnectionState; detail?: string }
  | { type: "message-deleted"; platform: Platform; id: string }
  | { type: "user-cleared"; platform: Platform; userId: string; durationSec?: number }
  | { type: "error"; platform: Platform; code: string; message: string };

export type Unsubscribe = () => void;

export type ModerationKind = "timeout" | "ban";
export type ProposalStatus = "pending" | "approved" | "rejected" | "executed" | "expired";

/** A moderation action that has NOT happened. A human must approve it first. */
export interface ModerationProposal {
  id: string;
  platform: Platform;
  kind: ModerationKind;
  targetUserId: string;
  targetLogin?: string;
  durationSec?: number;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
}

export interface ChatConnector {
  readonly platform: Platform;
  readonly state: ConnectionState;
  /** Resolves once the first successful connection is established. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(cb: (m: ChatMessage) => void): Unsubscribe;
  onEvent(cb: (e: ConnectorEvent) => void): Unsubscribe;
  /** Requires an authenticated connector; anonymous mode throws ReadOnlyError. */
  send(text: string): Promise<void>;
  /** Removes one message. (Lower risk than bans, still needs auth.) */
  deleteMessage(id: string): Promise<void>;
  /** Create proposals only; nothing is executed until approved via the ProposalStore. */
  requestTimeout(targetUserId: string, durationSec: number, reason?: string): ModerationProposal;
  requestBan(targetUserId: string, reason?: string): ModerationProposal;
  /** Execute an APPROVED proposal (single use). Throws if not approved. */
  executeProposal(proposalId: string): Promise<void>;
  /** where this connector's proposals live (approval is done here by the human-facing UI) */
  readonly proposalStore: import("./util.js").ProposalStore;
}

export class ReadOnlyError extends Error {
  constructor() { super("connector is in anonymous read-only mode"); this.name = "ReadOnlyError"; }
}
export class NotApprovedError extends Error {
  constructor(id: string, status: string) { super(`proposal ${id} is ${status}, not approved`); this.name = "NotApprovedError"; }
}
export class UnsupportedError extends Error {
  constructor(what: string) { super(`unsupported: ${what}`); this.name = "UnsupportedError"; }
}
