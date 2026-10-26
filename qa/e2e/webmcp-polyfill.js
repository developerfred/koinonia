// WebMCP test polyfill, injected with page.addInitScript BEFORE the studio boots, so the studio registers its tools
// against *our* navigator.modelContext (as a real WebMCP-capable browser/agent would) and tests can enumerate and call them.
// API surface mirrors the WebMCP proposal: modelContext.registerTool({name, description, inputSchema, execute}) / unregisterTool(name).
(() => {
  if (window.__qaMcp) return;
  const tools = new Map();
  const log = [];
  const mc = {
    registerTool(t) {
      if (!t || typeof t.name !== "string" || typeof t.execute !== "function") throw new TypeError("invalid tool");
      if (tools.has(t.name)) throw new Error("duplicate tool " + t.name);
      tools.set(t.name, t); log.push(["register", t.name]);
      return { unregister: () => { tools.delete(t.name); log.push(["unregister", t.name]); } };
    },
    unregisterTool(n) { tools.delete(n); log.push(["unregister", n]); },
  };
  Object.defineProperty(navigator, "modelContext", { value: mc, configurable: true });
  window.__qaMcp = {
    log,
    list: () => [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    // An agent calls a tool and gets ONE promise (PLANO.md): parse the text content for convenience.
    async call(name, args = {}) {
      const t = tools.get(name);
      if (!t) throw new Error("no such tool " + name);
      const r = await t.execute(args);
      const text = r.content.map((c) => c.text).join("");
      let json; try { json = JSON.parse(text); } catch { json = undefined; }
      return { isError: !!r.isError, text, json };
    },
  };
})();
