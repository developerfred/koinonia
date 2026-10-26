import type { ApprovalItem, ApprovalQueue } from "./approvals";
import type { UsageEvent } from "./usage";
import type { ToolDef, ToolResult } from "./tools/types";

/**
 * Page side of the agents bridge (agents/src/bridge-server.ts). JSON over WebSocket:
 *   server -> page   {id, method: "tools/list"|"tools/call", params}   page answers {id, result|error}
 *   agents -> page   {method: "approval.requested"|"approval.result"|"approval.closed"|"tokens.usage", params}   (no id)
 *   page -> agents   {method: "approval.decide", params: {id, approve}}                                          (no id)
 * The page only ever executes tools it registered itself; the bridge cannot add new capabilities.
 */
export interface BridgeSink {
  approvals: ApprovalQueue;
  recordTokens(u: UsageEvent): void;
}

export class PageBridge {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  state: "idle" | "connecting" | "open" | "closed" = "idle";
  onState: (s: PageBridge["state"]) => void = () => {};
  constructor(private url: string, private tools: () => ToolDef[], private sink: BridgeSink, private factory: (u: string) => WebSocket = (u) => new WebSocket(u)) {
    sink.approvals.sink = { decide: (id, approve) => this.send({ method: "approval.decide", params: { id, approve } }) };
  }

  start(): void { this.stopped = false; this.open(); }
  stop(): void { this.stopped = true; this.ws?.close(); }

  private set(s: PageBridge["state"]) { this.state = s; this.onState(s); }
  private send(o: unknown) { try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); } catch { /* drop */ } }

  private open() {
    this.set("connecting");
    const ws = (this.ws = this.factory(this.url));
    ws.onopen = () => { this.retry = 0; this.set("open"); };
    ws.onclose = () => {
      this.set("closed");
      if (!this.stopped) setTimeout(() => this.open(), Math.min(10_000, 500 * 2 ** Math.min(this.retry++, 5)));
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = (e) => { void this.handle(String(e.data)); };
  }

  async handle(raw: string): Promise<void> {
    let m: { id?: number; method?: string; params?: Record<string, unknown> };
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.method !== "string") return;
    if (m.id !== undefined) return void this.send(await this.request(m.id, m.method, m.params ?? {}));
    const p = m.params ?? {};
    const q = this.sink.approvals;
    switch (m.method) {
      case "approval.requested":
        if (typeof p.id === "string" && typeof p.tool === "string") {
          q.mirror({ id: p.id, agent: str(p.agent), tool: p.tool, args: (p.args as Record<string, unknown>) ?? {}, reason: str(p.reason), expiresAt: num(p.expiresAt) });
        }
        break;
      case "approval.result":
        if (typeof p.id === "string") q.settle(p.id, p.ok === true, String(p.detail ?? ""));
        break;
      case "approval.closed":
        if (typeof p.id === "string") q.closeExternal(p.id, p.status === "expired" ? "expired" : "denied");
        break;
      case "tokens.usage":
        if (typeof p.model === "string") {
          this.sink.recordTokens({ agent: str(p.agent) ?? "agent", model: p.model, task: str(p.task),
            inputTokens: num(p.inputTokens) ?? 0, outputTokens: num(p.outputTokens) ?? 0, cacheReadTokens: num(p.cacheReadTokens), cacheWriteTokens: num(p.cacheWriteTokens) });
        }
        break;
    }
  }

  private async request(id: number, method: string, params: Record<string, unknown>) {
    try {
      if (method === "tools/list") return { id, result: { tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
      if (method === "tools/call") {
        const t = this.tools().find((x) => x.name === params.name);
        if (!t) return { id, error: { message: `unknown tool ${String(params.name)}` } };
        const r: ToolResult = await t.execute((params.arguments as Record<string, unknown>) ?? {});
        return { id, result: r };
      }
      return { id, error: { message: `unknown method ${method}` } };
    } catch (e) { return { id, error: { message: String((e as Error).message ?? e) } }; }
  }
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export type { ApprovalItem };
