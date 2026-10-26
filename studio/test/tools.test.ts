import { describe, expect, it, vi } from "vitest";
import { ChatBuffer } from "../src/chat/ring";
import { MetricsStore } from "../src/metrics";
import { SceneState } from "../src/scene";
import { buildTools } from "../src/tools/tools";
import { registerAll } from "../src/tools/webmcp";
import type { StudioApi } from "../src/tools/types";

function fake(): StudioApi {
  return {
    chat: new ChatBuffer(50), metrics: new MetricsStore(100, () => 1000), scenes: new SceneState(),
    setAudio: (s) => s === "mic", startStream: async () => ({ state: "live" }), stopStream: async () => ({ state: "idle" }),
    streamState: () => "idle", captureFrame: async () => null, createPoll: () => ({ id: 1 }),
    pinMessage: (id) => id === 1, markHighlight: () => ({ id: 1, t: 5 }),
    exportClip: async () => ({ id: "c", state: "requested" }), now: () => 1000,
  };
}
const run = async (api: StudioApi, name: string, args: Record<string, unknown> = {}) => {
  const t = buildTools(api).find((x) => x.name === name)!;
  const r = await t.execute(args);
  return { r, j: JSON.parse(r.content[0]!.text) };
};

describe("tools", () => {
  it("registers all 14 required tools with schemas", () => {
    const names = buildTools(fake()).map((t) => t.name).sort();
    expect(names).toEqual(["capture_frame", "create_poll", "export_clip", "get_chat", "mark_highlight", "pin_message",
      "query_window", "set_alert", "set_audio", "set_layer", "set_overlay_text", "start_stream", "stop_stream", "switch_scene"]);
    for (const t of buildTools(fake())) expect(t.inputSchema.type).toBe("object");
  });
  it("get_chat is cursor/delta based and compact", async () => {
    const api = fake();
    api.chat.push({ ts: 1, platform: "twitch", user: "a", text: "hi" });
    const a = await run(api, "get_chat");
    expect(a.j).toEqual({ c: 1, m: [{ u: "a", t: "hi" }] });
    const b = await run(api, "get_chat", { since_cursor: a.j.c });
    expect(b.j).toEqual({ c: 1, m: [] });
    const c = await run(api, "get_chat", { fields: ["id", "bogus"] });
    expect(c.j.m).toEqual([{ i: 1 }]);
  });
  it("validates and errors compactly", async () => {
    const api = fake();
    expect((await run(api, "create_poll", { question: "q", options: ["a"] })).r.isError).toBe(true);
    expect((await run(api, "create_poll", { question: "q", options: ["a", "b"] })).j).toEqual({ id: 1 });
    expect((await run(api, "pin_message", { id: 9 })).r.isError).toBe(true);
    expect((await run(api, "switch_scene", { scene: "nope" })).r.isError).toBe(true);
    expect((await run(api, "switch_scene", { scene: "screen" })).j).toEqual({ scene: "screen" });
    expect((await run(api, "set_audio", { source: "x" })).r.isError).toBe(true);
    expect((await run(api, "capture_frame")).r.isError).toBe(true);
  });
  it("set_layer clamps; overlay text toggles visibility", async () => {
    const api = fake();
    const l = await run(api, "set_layer", { id: "cam", x: 5, opacity: -1, bogus: 1 });
    expect(l.j).toMatchObject({ id: "cam", x: 1, o: 0 });
    await run(api, "set_overlay_text", { text: "hello" });
    expect(api.scenes.snapshot().layers.find((x) => x.id === "overlay")).toMatchObject({ visible: true, text: "hello" });
    await run(api, "set_overlay_text", { text: "" });
    expect(api.scenes.snapshot().layers.find((x) => x.id === "overlay")!.visible).toBe(false);
  });
  it("set_alert + query_window deliver alerts as a delta", async () => {
    const api = fake();
    expect((await run(api, "set_alert", { metric: "kbps", op: "lt", threshold: 2000 })).j).toEqual({ id: 1 });
    api.metrics.push("kbps", 1000, 1000);
    const q = await run(api, "query_window", { metric: "kbps", last_sec: 10 });
    expect(q.j).toMatchObject({ n: 1, v: 1000, state: "idle", alerts: [{ alert: 1 }] });
    expect((await run(api, "query_window", { metric: "kbps" })).j.alerts).toBeUndefined();
    expect((await run(api, "set_alert", { remove_id: 1 })).j).toEqual({ removed: true });
  });
});

describe("webmcp registration", () => {
  it("uses native modelContext when present", () => {
    const registerTool = vi.fn();
    const reg = registerAll(buildTools(fake()), { modelContext: { registerTool } } as never, {});
    expect(reg.native).toBe(true);
    expect(registerTool).toHaveBeenCalledTimes(14);
  });
  it("installs polyfill otherwise", async () => {
    const nav: Record<string, unknown> = {}; const win: Record<string, unknown> = {};
    const reg = registerAll(buildTools(fake()), nav as never, win);
    expect(reg.native).toBe(false);
    const mc = nav.modelContext as { listTools(): unknown[]; callTool(n: string, a?: object): Promise<{ content: { text: string }[] }> };
    expect(mc.listTools()).toHaveLength(14);
    expect(JSON.parse((await mc.callTool("get_chat")).content[0]!.text)).toEqual({ c: 0, m: [] });
    expect(win.__koinoniaTools).toBe(mc);
  });
});
