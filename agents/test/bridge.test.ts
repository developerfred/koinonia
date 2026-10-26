import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge-server.ts";
import { linkBridge } from "../src/bridge-link.ts";
import { BridgeClient, webSocketTransport } from "../src/webmcp.ts";
import type { BridgeTransport } from "../src/webmcp.ts";
import { DEFAULT_AGENTS } from "../src/definitions.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { FakeProvider, say, toolUse } from "../src/providers/fake.ts";

const WS = (globalThis as unknown as { WebSocket: new (u: string) => any }).WebSocket;
const wait = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

/** Stand-in for the studio page: speaks the page side of the protocol. */
function fakePage(url: string, tools: string[] = ["get_chat", "ban_user"]) {
  const calls: { name: string; args: unknown }[] = [];
  const notes: { method: string; params: any }[] = [];
  const ws = new WS(url + "/?role=page");
  ws.onmessage = (ev: { data: unknown }) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && m.method === "tools/list") ws.send(JSON.stringify({ id: m.id, result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } }));
    else if (m.id !== undefined && m.method === "tools/call") {
      calls.push({ name: m.params.name, args: m.params.arguments });
      if (m.params.name === "boom") ws.send(JSON.stringify({ id: m.id, error: { message: "tool exploded" } }));
      else ws.send(JSON.stringify({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: m.params.name }) }] } }));
    } else notes.push({ method: m.method, params: m.params });
  };
  const opened = new Promise<void>((r) => { ws.onopen = () => r(); });
  return { ws, calls, notes, opened };
}

let srv: BridgeServer, url: string;
beforeEach(async () => { srv = await new BridgeServer({ port: 0, requestTimeoutMs: 400 }).listen(); url = `ws://127.0.0.1:${srv.port}`; });
afterEach(async () => { await srv.close(); });

describe("bridge server <-> BridgeClient", () => {
  it("relays tools/list and tools/call to the page and results back", async () => {
    const page = fakePage(url); await page.opened; await wait(() => srv.pageConnected);
    const client = new BridgeClient(await webSocketTransport(url));
    expect((await client.listTools()).map((t) => t.name)).toEqual(["get_chat", "ban_user"]);
    const r = await client.callTool("get_chat", { since_cursor: 3 });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ ok: "get_chat" });
    expect(page.calls).toEqual([{ name: "get_chat", args: { since_cursor: 3 } }]);
    client.close();
  });
  it("surfaces tool errors, missing page and page timeouts as errors", async () => {
    const client = new BridgeClient(await webSocketTransport(url));
    await expect(client.listTools()).rejects.toThrow(/no studio page/);
    const r = await client.callTool("get_chat", {});
    expect(r.isError).toBe(true);
    const page = fakePage(url, ["boom"]); await page.opened; await wait(() => srv.pageConnected);
    expect((await client.callTool("boom", {})).content[0]!.text).toContain("tool exploded");
    page.ws.onmessage = null; // page goes silent
    expect((await client.callTool("x", {})).content[0]!.text).toContain("did not answer");
    client.close();
  });
  it("fails pending requests when the page disconnects", async () => {
    const page = fakePage(url); await page.opened; await wait(() => srv.pageConnected);
    page.ws.onmessage = null;
    const client = new BridgeClient(await webSocketTransport(url));
    const p = client.callTool("get_chat", {});
    await new Promise((r) => setTimeout(r, 30)); page.ws.close();
    expect((await p).content[0]!.text).toContain("disconnected");
    client.close();
  });
  it("only relays allowlisted notifications, in the right direction", async () => {
    const page = fakePage(url); await page.opened; await wait(() => srv.pageConnected);
    const t = await webSocketTransport(url);
    const got: string[] = []; t.onNotification = (m) => got.push(m);
    t.notify!("approval.requested", { id: "a" });
    t.notify!("approval.decide", { id: "a", approve: true });     // agents may not decide
    t.notify!("evil.method", {});
    page.ws.send(JSON.stringify({ method: "approval.decide", params: { id: "a", approve: false } }));
    page.ws.send(JSON.stringify({ method: "tokens.usage", params: { model: "x" } })); // page may not spoof usage
    await wait(() => page.notes.length >= 1 && got.length >= 1); await new Promise((r) => setTimeout(r, 80));
    expect(page.notes.map((n) => n.method)).toEqual(["approval.requested"]);
    expect(got).toEqual(["approval.decide"]);
    t.close?.();
  });
  it("rejects browser origins that are not loopback, and bad tokens", async () => {
    const net: any = await import("node:net" as string);
    const probe = (headers: string, path = "/") => new Promise<string>((res) => {
      const s = net.connect(srv.port, "127.0.0.1", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`));
      s.once("data", (d: Buffer) => { res(String(d).split("\r\n")[0]!); s.destroy(); });
    });
    expect(await probe("Origin: https://evil.example\r\n")).toContain("403");
    expect(await probe("Origin: http://localhost:5173\r\n")).toContain("101");
    expect(await probe("")).toContain("101");
    await srv.close();
    srv = await new BridgeServer({ port: 0, token: "s3cret" }).listen();
    expect(await probe("", "/?token=nope")).toContain("403");
    expect(await probe("", "/?token=s3cret")).toContain("101");
  });
});

describe("linkBridge: approvals travel to the page and back", () => {
  it("moderator ban -> approval.requested on the page -> page decides -> executed on the page", async () => {
    const page = fakePage(url); await page.opened; await wait(() => srv.pageConnected);
    const transport = await webSocketTransport(url);
    const client = new BridgeClient(transport);
    const provider = new FakeProvider((_r, i) => (i === 0 ? [toolUse("ban_user", { user: "troll", reason: "spam" })] : [say("done")]));
    const orch = new Orchestrator({ client, provider, timers: false });
    await orch.refreshTools();
    orch.register(DEFAULT_AGENTS.find((d) => d.id === "moderator")!);
    orch.start();
    const unlink = linkBridge(orch, transport);

    await orch.bus.emit("chat.batch", { messages: Array.from({ length: 9 }, (_, i) => ({ id: i, user: "x", text: "m" + i })) });
    await wait(() => page.notes.some((n) => n.method === "approval.requested"));
    expect(page.calls.filter((c) => c.name === "ban_user")).toEqual([]); // nothing executed yet
    const req = page.notes.find((n) => n.method === "approval.requested")!.params;
    expect(req).toMatchObject({ agent: "moderator", tool: "ban_user", args: { user: "troll", reason: "spam" } });

    page.ws.send(JSON.stringify({ method: "approval.decide", params: { id: req.id, approve: true } }));
    await wait(() => page.notes.some((n) => n.method === "approval.result"));
    expect(page.calls.filter((c) => c.name === "ban_user")).toEqual([{ name: "ban_user", args: { user: "troll", reason: "spam" } }]);
    expect(page.notes.find((n) => n.method === "approval.result")!.params).toMatchObject({ id: req.id, ok: true });

    // token usage is forwarded for the page's budget panel
    expect(page.notes.some((n) => n.method === "tokens.usage" && n.params.agent === "moderator")).toBe(true);
    unlink(); orch.dispose(); transport.close?.();
  });

  it("a denial from the page never executes", async () => {
    const page = fakePage(url); await page.opened; await wait(() => srv.pageConnected);
    const transport = await webSocketTransport(url);
    const orch = new Orchestrator({ client: new BridgeClient(transport), provider: new FakeProvider((_r, i) => (i === 0 ? [toolUse("ban_user", { user: "u" })] : [say("ok")])), timers: false });
    await orch.refreshTools(); orch.register(DEFAULT_AGENTS.find((d) => d.id === "moderator")!); orch.start();
    const unlink = linkBridge(orch, transport);
    await orch.bus.emit("chat.batch", { messages: Array.from({ length: 9 }, (_, i) => ({ id: i, user: "x", text: "m" + i })) });
    await wait(() => page.notes.some((n) => n.method === "approval.requested"));
    const id = page.notes.find((n) => n.method === "approval.requested")!.params.id;
    page.ws.send(JSON.stringify({ method: "approval.decide", params: { id, approve: false } }));
    await wait(() => orch.approvals.get(id)?.status === "denied");
    expect(page.calls.filter((c) => c.name === "ban_user")).toEqual([]);
    unlink(); orch.dispose(); transport.close?.();
  });
});
void (null as unknown as BridgeTransport);
