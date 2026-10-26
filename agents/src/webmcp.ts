import type { JsonObject, ToolResult, ToolSpec } from "./types.ts";
import { textResult } from "./types.ts";

/** What agents see of the studio page. Implementations: navigator.modelContext, a WebSocket bridge, or a mock. */
export interface WebMcpClient {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, args: JsonObject): Promise<ToolResult>;
  close?(): void;
}

/** Shape of the (proposed) WebMCP surface plus the studio polyfill's listTools(). */
interface ModelContextLike {
  listTools?: () => { name: string; description: string; inputSchema: unknown }[] | Promise<{ name: string; description: string; inputSchema: unknown }[]>;
  callTool?: (name: string, args: JsonObject) => Promise<unknown>;
  executeTool?: (name: string, args: JsonObject) => Promise<unknown>;
}

function normalizeResult(r: unknown): ToolResult {
  if (r && typeof r === "object" && Array.isArray((r as ToolResult).content)) return r as ToolResult;
  return textResult(r === undefined ? "" : r);
}

/** In-page use (agents running in the studio tab itself). */
export class NavigatorModelContextClient implements WebMcpClient {
  constructor(private mc: ModelContextLike = (globalThis as { navigator?: { modelContext?: ModelContextLike } }).navigator?.modelContext as ModelContextLike) {
    if (!this.mc) throw new Error("navigator.modelContext is not available");
  }
  async listTools(): Promise<ToolSpec[]> {
    if (!this.mc.listTools) throw new Error("modelContext.listTools not supported");
    const ts = await this.mc.listTools();
    return ts.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? { type: "object" }) as JsonObject }));
  }
  async callTool(name: string, args: JsonObject): Promise<ToolResult> {
    const fn = this.mc.callTool ?? this.mc.executeTool;
    if (!fn) throw new Error("modelContext has no callTool/executeTool");
    try {
      return normalizeResult(await fn.call(this.mc, name, args));
    } catch (e) {
      return textResult({ error: String(e) }, true);
    }
  }
}

/** Minimal request/response transport (e.g. WebSocket to the studio page). */
export interface BridgeTransport {
  request(method: "tools/list" | "tools/call", params: JsonObject): Promise<unknown>;
  /** id-less message to the page (approvals, token usage); optional so simple transports/mocks need not implement it */
  notify?(method: string, params: JsonObject): void;
  /** id-less messages from the page (e.g. approval.decide) */
  onNotification?: ((method: string, params: JsonObject) => void) | null;
  close?(): void;
}

/** Out-of-page use: Node process talking to the studio over a bridge. */
export class BridgeClient implements WebMcpClient {
  constructor(private t: BridgeTransport) {}
  async listTools(): Promise<ToolSpec[]> {
    const r = (await this.t.request("tools/list", {})) as { tools?: ToolSpec[] } | ToolSpec[];
    return Array.isArray(r) ? r : (r.tools ?? []);
  }
  async callTool(name: string, args: JsonObject): Promise<ToolResult> {
    try {
      return normalizeResult(await this.t.request("tools/call", { name, arguments: args }));
    } catch (e) {
      return textResult({ error: String(e) }, true);
    }
  }
  close(): void {
    this.t.close?.();
  }
}

/** JSON-RPC-ish WebSocket transport using the global WebSocket (Node >= 22, browsers). Assumed protocol; see ARCHITECTURE.md. */
export function webSocketTransport(url: string, timeoutMs = 15000): Promise<BridgeTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let n = 0;
    let transport: BridgeTransport | null = null;
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    ws.onopen = () => {
      const t: BridgeTransport = {
        notify: (method, params) => ws.send(JSON.stringify({ method, params })),
        onNotification: null,
        request: (method, params) =>
          new Promise((res, rej) => {
            const id = ++n;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error(`bridge timeout: ${method}`)); }, timeoutMs);
            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      };
      transport = t;
      resolve(t);
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onmessage = (ev: { data: unknown }) => {
      let m: { id?: number; method?: string; params?: JsonObject; result?: unknown; error?: { message?: string } | string };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id === undefined && typeof m.method === "string") { try { transport?.onNotification?.(m.method, m.params ?? {}); } catch { /* handler bug must not kill the socket */ } return; }
      const p = m.id !== undefined ? pending.get(m.id) : undefined;
      if (!p) return;
      pending.delete(m.id!);
      clearTimeout(p.timer);
      if (m.error) p.rej(new Error(typeof m.error === "string" ? m.error : (m.error.message ?? "error")));
      else p.res(m.result);
    };
  });
}

export type MockHandler = (args: JsonObject) => unknown | Promise<unknown>;

/** Test double: register handlers, inspect calls. */
export class MockWebMcp implements WebMcpClient {
  readonly calls: { name: string; args: JsonObject }[] = [];
  private tools = new Map<string, { spec: ToolSpec; h: MockHandler }>();

  register(name: string, h: MockHandler = () => ({ ok: 1 }), description = name, inputSchema: JsonObject = { type: "object" }): this {
    this.tools.set(name, { spec: { name, description, inputSchema }, h });
    return this;
  }
  callsTo(name: string): JsonObject[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }
  async listTools(): Promise<ToolSpec[]> {
    return [...this.tools.values()].map((t) => t.spec);
  }
  async callTool(name: string, args: JsonObject): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) return textResult({ error: `unknown tool ${name}` }, true);
    this.calls.push({ name, args });
    try {
      return normalizeResult(await t.h(args));
    } catch (e) {
      return textResult({ error: String(e) }, true);
    }
  }
}

/** Mock pre-loaded with the studio's real tool names (see studio/src/tools/tools.ts) plus moderation tools the page may add. */
export function studioLikeMock(): MockWebMcp {
  const m = new MockWebMcp();
  for (const n of ["get_chat", "create_poll", "pin_message", "switch_scene", "set_layer", "set_audio", "set_overlay_text",
    "start_stream", "stop_stream", "capture_frame", "mark_highlight", "export_clip", "query_window", "set_alert",
    "ban_user", "timeout_user", "delete_message"]) m.register(n);
  return m;
}
