import type { ApprovalRequest } from "./approval.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { BridgeTransport } from "./webmcp.ts";

/**
 * Connects an orchestrator to the studio page through a bridge transport:
 *  - `approval.requested` (bus) -> page shows it in its approvals panel (the human decides THERE);
 *  - page `approval.decide`     -> gate.approve()/deny(); approval runs the original tool call on the page
 *    (which only executes thanks to the single-use grant the page minted when the human clicked approve);
 *  - result / expiry            -> page (`approval.result`, `approval.closed`);
 *  - `economy.usage` (bus)      -> page token ledger (`tokens.usage`).
 * Agents themselves have no way to reach approve/deny.
 */
export function linkBridge(orch: Orchestrator, t: BridgeTransport, log: (s: string) => void = () => {}): () => void {
  const notify = (m: string, p: Record<string, unknown>) => { try { t.notify?.(m, p); } catch (e) { log(`bridge notify failed: ${String(e)}`); } };
  const live = new Map<string, ApprovalRequest>();
  const offs = [
    orch.bus.on("approval.requested", (e) => {
      const r = e.payload as ApprovalRequest;
      live.set(r.id, r);
      notify("approval.requested", { id: r.id, agent: r.agent, tool: r.tool, args: r.args, reason: r.reason, expiresAt: r.expiresAt });
    }),
    orch.bus.on("economy.usage", (e) => notify("tokens.usage", e.payload as Record<string, unknown>)),
  ];
  t.onNotification = (method, params) => {
    if (method !== "approval.decide" || typeof params.id !== "string") return;
    const id = params.id;
    if (params.approve === true) {
      orch.approvals.approve(id, "studio-ui").then(
        (r) => { live.delete(id); const txt = r.result?.content.map((c) => c.text).join(" ") ?? ""; notify("approval.result", { id, ok: !r.result?.isError, detail: txt.slice(0, 300) }); },
        (err) => { live.delete(id); notify("approval.result", { id, ok: false, detail: String((err as Error).message ?? err) }); },
      );
    } else {
      try { orch.approvals.deny(id, "studio-ui"); } catch { /* already decided/expired */ }
      live.delete(id);
    }
  };
  const sweep = setInterval(() => {
    for (const [id, r] of live) if (r.status === "expired") { live.delete(id); notify("approval.closed", { id, status: "expired" }); }
  }, 1000);
  return () => { clearInterval(sweep); offs.forEach((o) => o()); t.onNotification = null; };
}
