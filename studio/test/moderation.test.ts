import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals";
import { ChatBuffer } from "../src/chat/ring";
import { MetricsStore } from "../src/metrics";
import { makeModExecutor } from "../src/moderation";
import { SceneState } from "../src/scene";
import { buildTools } from "../src/tools/tools";
import type { StudioApi } from "../src/tools/types";
import { TokenAccounting } from "../src/usage";

function api(): StudioApi {
  const chat = new ChatBuffer(50);
  return {
    chat, metrics: new MetricsStore(100), scenes: new SceneState(), approvals: new ApprovalQueue(), tokens: new TokenAccounting(),
    setAudio: () => true, startStream: async () => ({ state: "live" }), stopStream: async () => ({ state: "idle" }), streamState: () => "idle",
    captureFrame: async () => null, createPoll: () => ({ id: 1 }), pinMessage: () => true, markHighlight: () => ({ id: 1, t: 1 }),
    exportClip: async () => ({ id: "c", state: "saved" }), now: () => 1,
  };
}
const call = async (a: StudioApi, name: string, args: Record<string, unknown>) => {
  const r = await buildTools(a).find((t) => t.name === name)!.execute(args);
  return { r, j: JSON.parse(r.content[0]!.text) };
};

describe("moderation tools are proposals", () => {
  it("ban_user/timeout_user/delete_message only queue; the executor is never called", async () => {
    const a = api(); const ex = vi.fn(async () => ({ ok: true, detail: "x" })); a.approvals.executor = ex;
    a.chat.push({ ts: 1, platform: "twitch", user: "troll", text: "spam" });
    expect((await call(a, "ban_user", { user: "@troll", reason: "spam" })).j.status).toBe("pending_approval");
    expect((await call(a, "timeout_user", { user: "troll", seconds: 99999999 })).j.status).toBe("pending_approval");
    expect((await call(a, "delete_message", { id: 1 })).j.status).toBe("pending_approval");
    expect(ex).not.toHaveBeenCalled();
    const p = a.approvals.pending();
    expect(p.map((x) => x.tool)).toEqual(["ban_user", "timeout_user", "delete_message"]);
    expect(p[0]!.args.user).toBe("troll");
    expect(p[1]!.args.seconds).toBe(1209600); // clamped
  });
  it("validates input", async () => {
    const a = api();
    expect((await call(a, "ban_user", {})).r.isError).toBe(true);
    expect((await call(a, "delete_message", { id: 77 })).r.isError).toBe(true);
  });
  it("human approval of a page-originated proposal runs the executor once", async () => {
    const a = api(); const ex = vi.fn(async () => ({ ok: true, detail: "done" })); a.approvals.executor = ex;
    const { j } = await call(a, "ban_user", { user: "troll" });
    const item = await a.approvals.approve(j.id);
    expect(item.status).toBe("executed");
    expect(ex).toHaveBeenCalledTimes(1);
    await expect(a.approvals.approve(j.id)).rejects.toThrow();
  });
  it("deny never executes; duplicate proposals collapse; queue is bounded", async () => {
    const a = api(); const ex = vi.fn(async () => ({ ok: true, detail: "" })); a.approvals.executor = ex;
    const x = (await call(a, "ban_user", { user: "u" })).j.id;
    expect((await call(a, "ban_user", { user: "u" })).j.id).toBe(x);
    a.approvals.deny(x);
    expect(ex).not.toHaveBeenCalled();
    for (let i = 0; i < 25; i++) await call(a, "ban_user", { user: "n" + i });
    expect(a.approvals.pending().length).toBe(20);
  });
  it("expired proposals cannot be approved", async () => {
    let t = 0; const q = new ApprovalQueue(() => t, 1000);
    const a = api(); (a as { approvals: ApprovalQueue }).approvals = q;
    const { j } = await call(a, "ban_user", { user: "u" });
    t = 5000;
    await expect(q.approve(j.id)).rejects.toThrow(/expired/);
  });
});

describe("bridge-mirrored approvals (agents runtime)", () => {
  it("approve mints one single-use grant; the page tool then executes exactly once", async () => {
    const a = api(); const ex = vi.fn(async () => ({ ok: true, detail: "ok" })); a.approvals.executor = ex;
    const decide = vi.fn(); a.approvals.sink = { decide };
    const args = { user: "troll", reason: "spam" };
    // without approval: a direct call is just a proposal
    expect((await call(a, "ban_user", args)).j.status).toBe("pending_approval");
    a.approvals.mirror({ id: "apr-9", agent: "moderator", tool: "ban_user", args });
    await a.approvals.approve("ext:apr-9");
    expect(decide).toHaveBeenCalledWith("apr-9", true);
    expect(ex).not.toHaveBeenCalled(); // the runtime executes via the tool call below
    const first = await call(a, "ban_user", args);
    expect(first.j.status).toBe("executed");
    expect(ex).toHaveBeenCalledTimes(1);
    expect((await call(a, "ban_user", args)).j.status).toBe("pending_approval"); // grant was single use
    expect(ex).toHaveBeenCalledTimes(1);
  });
  it("a grant does not authorise different arguments", async () => {
    const a = api(); const ex = vi.fn(async () => ({ ok: true, detail: "" })); a.approvals.executor = ex;
    a.approvals.mirror({ id: "1", tool: "ban_user", args: { user: "a" } });
    await a.approvals.approve("ext:1");
    expect((await call(a, "ban_user", { user: "b" })).j.status).toBe("pending_approval");
    expect(ex).not.toHaveBeenCalled();
  });
  it("deny is forwarded and settle records the result", async () => {
    const a = api(); const decide = vi.fn(); a.approvals.sink = { decide };
    a.approvals.mirror({ id: "2", tool: "ban_user", args: { user: "a" } });
    a.approvals.deny("ext:2");
    expect(decide).toHaveBeenCalledWith("2", false);
    a.approvals.mirror({ id: "3", tool: "ban_user", args: { user: "a" } });
    a.approvals.settle("3", false, "boom");
    expect(a.approvals.get("ext:3")).toMatchObject({ status: "failed", result: "boom" });
  });
});

describe("executor is honest", () => {
  it("reports not-executed without a connector, and uses the connector when present", async () => {
    const chat = new ChatBuffer(10);
    chat.push({ ts: 1, platform: "twitch", user: "Troll", text: "x", mid: "m-1", uid: "u-1" });
    const conns = new Map<string, never>();
    const ex = makeModExecutor(chat, () => conns);
    expect((await ex("ban_user", { user: "Troll", platform: "twitch" })).ok).toBe(false);
    const calls: string[] = [];
    conns.set("twitch", {
      requestBan: (u: string) => { calls.push("ban:" + u); return { id: "p1" }; },
      requestTimeout: (u: string, s: number) => { calls.push(`to:${u}:${s}`); return { id: "p2" }; },
      deleteMessage: async (id: string) => { calls.push("del:" + id); },
      executeProposal: async (id: string) => { calls.push("exec:" + id); },
      proposalStore: { approve: (id: string) => calls.push("appr:" + id) },
    } as never);
    expect((await ex("ban_user", { user: "troll" })).ok).toBe(true);
    expect((await ex("timeout_user", { user: "troll", seconds: 30 })).ok).toBe(true);
    expect((await ex("delete_message", { id: 1 })).ok).toBe(true);
    expect(calls).toEqual(["ban:u-1", "appr:p1", "exec:p1", "to:u-1:30", "appr:p2", "exec:p2", "del:m-1"]);
    expect((await ex("ban_user", { user: "ghost" })).ok).toBe(false);
  });
});

describe("get_token_report", () => {
  it("is compact and reflects recorded usage", async () => {
    const a = api(); a.tokens.budget = 1000;
    a.tokens.record({ agent: "moderator", model: "claude-haiku-5-5", inputTokens: 600, outputTokens: 250 });
    const { j } = await call(a, "get_token_report", {});
    expect(j).toMatchObject({ spent: 850, budget: 1000, level: "warn", calls: 1 });
    expect(j.byAgent).toBeUndefined();
    expect((await call(a, "get_token_report", { verbosity: "full" })).j.byAgent.moderator).toBeTruthy();
  });
});
