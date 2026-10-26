import type { ToolDef, ToolResult } from "./types";

interface ModelContext {
  registerTool(t: ToolDef): unknown;
  unregisterTool?(name: string): void;
}

export interface Registration { native: boolean; names: string[]; unregister(): void }

/**
 * Registers tools via navigator.modelContext.registerTool. If absent, installs a
 * minimal polyfill (also exposes window.__koinoniaTools for manual/agent testing).
 */
export function registerAll(tools: ToolDef[], nav: { modelContext?: ModelContext } = navigator as never,
  win: Record<string, unknown> = globalThis as never): Registration {
  let native = true;
  if (!nav.modelContext || typeof nav.modelContext.registerTool !== "function") {
    native = false;
    const reg = new Map<string, ToolDef>();
    const poly: ModelContext & { listTools(): { name: string; description: string; inputSchema: unknown }[];
      callTool(n: string, a?: Record<string, unknown>): Promise<ToolResult> } = {
      registerTool(t) { reg.set(t.name, t); return { unregister: () => reg.delete(t.name) }; },
      unregisterTool(n) { reg.delete(n); },
      listTools: () => [...reg.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      async callTool(n, a = {}) {
        const t = reg.get(n);
        if (!t) return { content: [{ type: "text", text: `{"error":"unknown tool"}` }], isError: true };
        return t.execute(a);
      },
    };
    try { Object.defineProperty(nav, "modelContext", { value: poly, configurable: true }); }
    catch { (nav as { modelContext?: unknown }).modelContext = poly; }
    win.__koinoniaTools = poly;
  }
  const mc = nav.modelContext!;
  const handles: unknown[] = [];
  for (const t of tools) handles.push(mc.registerTool(t));
  return {
    native, names: tools.map((t) => t.name),
    unregister() {
      tools.forEach((t, i) => {
        const h = handles[i] as { unregister?: () => void } | undefined;
        if (h?.unregister) h.unregister(); else mc.unregisterTool?.(t.name);
      });
    },
  };
}
