import type { ChatBuffer } from "./chat/ring";
import type { ModExecutor } from "./approvals";

/** Structural subset of connectors/ ChatConnector (keeps studio free of a hard build dependency on it). */
export interface ModConnector {
  requestBan(userId: string, reason?: string): { id: string };
  requestTimeout(userId: string, sec: number, reason?: string): { id: string };
  deleteMessage(id: string): Promise<void>;
  executeProposal(id: string): Promise<void>;
  proposalStore: { approve(id: string): unknown };
}

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Executes an ALREADY human-approved moderation action through the platform connector.
 * Anonymous/read-only connectors or connectors without a moderation API fail loudly instead of pretending.
 */
export function makeModExecutor(chat: ChatBuffer, connectors: () => Map<string, ModConnector>): ModExecutor {
  return async (tool, args) => {
    const platform = s(args.platform) ?? "twitch";
    const c = connectors().get(platform);
    if (!c) return { ok: false, detail: `not executed: no ${platform} connector attached (action approved but recorded only)` };
    try {
      if (tool === "delete_message") {
        const m = chat.get(Number(args.id));
        if (!m?.mid) return { ok: false, detail: "not executed: message has no platform id (not from a connector)" };
        await c.deleteMessage(m.mid);
        return { ok: true, detail: `deleted message ${m.mid}` };
      }
      const user = s(args.user);
      if (!user) return { ok: false, detail: "missing user" };
      const uid = chat.lastFrom(user, platform)?.uid ?? s(args.user_id);
      if (!uid) return { ok: false, detail: `not executed: ${user} has no recent message with a platform user id` };
      const p = tool === "ban_user" ? c.requestBan(uid, s(args.reason)) : c.requestTimeout(uid, Number(args.seconds) || 600, s(args.reason));
      c.proposalStore.approve(p.id);
      await c.executeProposal(p.id);
      return { ok: true, detail: `${tool} executed on ${platform} for ${user}` };
    } catch (e) {
      return { ok: false, detail: `not executed: ${(e as Error).message}` };
    }
  };
}
