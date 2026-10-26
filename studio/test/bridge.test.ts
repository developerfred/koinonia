// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals";
import { PageBridge } from "../src/bridge";
import { ChatBuffer } from "../src/chat/ring";
import { Studio } from "../src/studio";
import { buildTools } from "../src/tools/tools";
import { mountApp } from "../src/ui/app";
import { STORAGE_KEY } from "../src/ui/prefs";
import { TokenAccounting } from "../src/usage";

class FakeSock { readyState = 1; sent: any[] = []; onopen: any; onclose: any; onerror: any; onmessage: any;
  send(s: string) { this.sent.push(JSON.parse(s)); } close() {} }
const mk = () => {
  const sink = { approvals: new ApprovalQueue(), recordTokens: vi.fn() };
  const sock = new FakeSock();
  const tools = [{ name: "echo", description: "d", inputSchema: { type: "object" }, execute: async (a: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(a) }] }) }];
  const b = new PageBridge("ws://x", () => tools, sink, () => sock as never);
  b.start();
  return { b, sink, sock };
};

describe("PageBridge", () => {
  it("answers tools/list and tools/call, errors on unknown tools", async () => {
    const { b, sock } = mk();
    await b.handle(JSON.stringify({ id: 1, method: "tools/list" }));
    expect(sock.sent[0]).toMatchObject({ id: 1, result: { tools: [{ name: "echo" }] } });
    await b.handle(JSON.stringify({ id: 2, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } }));
    expect(sock.sent[1].result.content[0].text).toBe('{"a":1}');
    await b.handle(JSON.stringify({ id: 3, method: "tools/call", params: { name: "nope" } }));
    expect(sock.sent[2].error.message).toContain("unknown tool");
  });
  it("mirrors approvals, forwards the human decision, settles and records tokens", async () => {
    const { b, sink, sock } = mk();
    await b.handle(JSON.stringify({ method: "approval.requested", params: { id: "apr-1", agent: "moderator", tool: "ban_user", args: { user: "t" }, reason: "r" } }));
    expect(sink.approvals.pending()).toHaveLength(1);
    await sink.approvals.approve("ext:apr-1");
    expect(sock.sent.at(-1)).toEqual({ method: "approval.decide", params: { id: "apr-1", approve: true } });
    await b.handle(JSON.stringify({ method: "approval.result", params: { id: "apr-1", ok: true, detail: "done" } }));
    expect(sink.approvals.get("ext:apr-1")).toMatchObject({ status: "executed", result: "done" });
    await b.handle(JSON.stringify({ method: "tokens.usage", params: { agent: "producer", model: "m", inputTokens: 10, outputTokens: 5 } }));
    expect(sink.recordTokens).toHaveBeenCalledWith(expect.objectContaining({ agent: "producer", inputTokens: 10, outputTokens: 5 }));
  });
  it("ignores malformed input", async () => {
    const { b, sock } = mk();
    await b.handle("not json"); await b.handle(JSON.stringify({ method: "approval.requested", params: {} }));
    expect(sock.sent).toEqual([]);
  });
});

describe("Studio wiring", () => {
  it("attachChat feeds the buffer with ids; recordTokens feeds the token series and report", () => {
    const s = new Studio();
    let cb: any; s.attachChat({ onMessage: (f) => { cb = f; return () => {}; } });
    cb({ message: { ts: 5, platform: "twitch", id: "m1", user: { id: "u1", name: "Ana" }, text: "oi" } });
    expect(s.chat.get(1)).toMatchObject({ user: "Ana", mid: "m1", uid: "u1" });
    s.recordTokens({ agent: "producer", model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 50 });
    expect(s.metrics.query("tokens", 60, "count").v).toBe(1);
    expect(s.tokens.report()).toMatchObject({ spent: 150, calls: 1 });
  });
  it("daemon stats map to the health metrics", () => {
    const s = new Studio();
    (s as any).onDaemon({ type: "stats", in_kbps: 2610, dropped: { twitch: 1, youtube: 3 }, dests: { twitch: "live" } });
    expect(s.metrics.query("kbps", 60, "last").v).toBe(2610);
    expect(s.metrics.query("dropped", 60, "last").v).toBe(4);
    expect(s.diag.dests.twitch).toBe("live");
  });
});

describe("approvals panel + token panel", () => {
  const mount = () => {
    document.body.innerHTML = "";
    const host: any = new Studio();
    const root = document.createElement("div"); document.body.append(root);
    const store = new Map([[STORAGE_KEY, JSON.stringify({ onboarded: true, view: "painel" })]]);
    const app = mountApp(root, host, { storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    return { host, root, app };
  };
  it("shows proposals with approve/deny buttons; approve runs the executor", async () => {
    const { host, root, app } = mount();
    host.approvals.executor = async () => ({ ok: true, detail: "banned" });
    const run = (n: string, a: Record<string, unknown>) => buildTools(host).find((t) => t.name === n)!.execute(a);
    await run("ban_user", { user: "troll", reason: "spam" });
    await run("timeout_user", { user: "other", seconds: 60 });
    const items = root.querySelectorAll("#apr-list li");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toContain("timeout other 60s");
    (root.querySelector('li[data-status="pending"] [data-act="deny"]') as HTMLElement).click();
    const ban = [...root.querySelectorAll<HTMLElement>("#apr-list li")].find((l) => l.textContent!.includes("ban troll"))!;
    (ban.querySelector('[data-act="approve"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(root.querySelector('li[data-status="executed"]')!.textContent).toContain("banned");
    expect(root.querySelector("#apr-empty")!.hasAttribute("hidden")).toBe(true);
    app.destroy();
  });
  it("token panel follows recordTokens and uses the UI budget", () => {
    const { host, root, app } = mount();
    host.recordTokens({ agent: "a", model: "m", inputTokens: 90_000, outputTokens: 0 });
    app.tick();
    expect(root.querySelector("#tok-text")!.textContent).toMatch(/90\.000 de 200\.000/);
    expect(host.tokens.budget).toBe(200_000);
    app.destroy();
  });
});
void ChatBuffer; void TokenAccounting;
