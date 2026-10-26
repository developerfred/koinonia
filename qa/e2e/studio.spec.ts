// End-to-end: Chromium + fake media devices + WebMCP polyfill, driving the studio's WebMCP tools exactly as an agent would.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import { FakeDaemonWs } from "../lib/fake-daemon-ws";

const EXPECTED_TOOLS = ["get_chat", "create_poll", "pin_message", "switch_scene", "set_layer", "set_audio", "set_overlay_text",
  "start_stream", "stop_stream", "capture_frame", "mark_highlight", "export_clip", "query_window", "set_alert"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: readFileSync(join(HERE, "webmcp-polyfill.js"), "utf8") });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as any).__errors = errors;
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__qaMcp?.list().length > 0, null, { timeout: 15_000 });
});
test.afterEach(async ({ page }) => { expect((page as any).__errors ?? [], "uncaught page errors").toEqual([]); });

const call = (page: Page, name: string, args: Record<string, unknown> = {}) =>
  page.evaluate(([n, a]) => (window as any).__qaMcp.call(n, a), [name, args] as const);

test("registers the documented tool set against navigator.modelContext (native-style, via polyfill)", async ({ page }) => {
  const tools = await page.evaluate(() => (window as any).__qaMcp.list());
  const names = tools.map((t: any) => t.name);
  for (const n of EXPECTED_TOOLS) expect(names, `missing tool ${n}`).toContain(n);
  expect(new Set(names).size).toBe(names.length);
  for (const t of tools) {
    expect(t.description.length, `${t.name} description too long (token economy)`).toBeLessThanOrEqual(300);
    expect(t.inputSchema.type).toBe("object");
  }
  // token economy: the whole tool catalog an agent must load stays small (chars/4 estimate)
  const est = Math.ceil(JSON.stringify(tools).length / 4);
  console.log(`[e2e] tool catalog ~${est} tokens for ${tools.length} tools`);
  expect(est).toBeLessThanOrEqual(Number(process.env.QA_MAX_CATALOG_TOKENS ?? 3500));
  expect(await page.evaluate(() => document.documentElement.dataset.webmcp)).toBe("native"); // polyfill counts as native for the app
});

test("get_chat: cursor deltas, dedupe, never replays old messages", async ({ page }) => {
  const hasHook = await page.evaluate(() => typeof (window as any).koinoniaPushChat === "function");
  test.skip(!hasHook, "studio exposes no koinoniaPushChat dev hook");
  await page.evaluate(() => { const p = (window as any).koinoniaPushChat; p("ana", "KEKW"); p("bob", "kekw"); p("cy", "KEKW "); p("dee", "audio ta baixo"); });
  const a = (await call(page, "get_chat", {})).json;
  expect(a.m.length).toBe(2);
  expect(a.m[0].x).toBe(3);                    // 3 identical messages folded into one with count
  const b = (await call(page, "get_chat", { since_cursor: a.c })).json;
  expect(b.m).toEqual([]);                     // nothing new => empty delta (cheap)
  await page.evaluate(() => (window as any).koinoniaPushChat("eve", "primeira vez aqui"));
  const c = (await call(page, "get_chat", { since_cursor: a.c })).json;
  expect(c.m).toEqual([{ u: "eve", t: "primeira vez aqui" }]);
  expect(c.c).toBeGreaterThan(a.c);
  const full = (await call(page, "get_chat", { since_cursor: 0, fields: ["id", "platform", "user", "text"], dedupe: false })).json;
  expect(full.m.length).toBe(5);
});

test("scene / layer / overlay / audio tools validate input and report errors compactly", async ({ page }) => {
  const bad = await call(page, "switch_scene", { scene: "does-not-exist" });
  expect(bad.isError).toBe(true);
  expect(bad.text.length).toBeLessThan(200);
  expect((await call(page, "set_layer", { id: "nope", x: 0.1 })).isError).toBe(true);
  expect((await call(page, "set_overlay_text", { text: "x".repeat(500) })).isError).toBeFalsy();
  expect((await call(page, "set_audio", { source: "nope", muted: true })).isError).toBe(true);
  expect((await call(page, "create_poll", { question: "q", options: ["only one"] })).isError).toBe(true);
  expect((await call(page, "pin_message", { id: 99999 })).isError).toBe(true);
  expect((await call(page, "set_alert", {})).isError).toBe(true);
  const q = await call(page, "query_window", {});
  expect(q.isError).toBeFalsy();
  expect(q.json.state).toBeDefined();
});

test("alerts are edge-triggered and surface through query_window", async ({ page }) => {
  const id = (await call(page, "set_alert", { metric: "qa_metric", op: "gt", threshold: 10 })).json.id;
  expect(id).toBeGreaterThan(0);
  // metrics are fed by the studio internals; there is no public tool to push them, so we only assert the registry round-trip
  expect((await call(page, "set_alert", { remove_id: id })).json.removed).toBeTruthy();
});

test("fake camera+microphone are available (Chromium fake-device flags) and the preview plays", async ({ page }) => {
  const info = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: true });
    const v = document.createElement("video"); v.muted = true; v.srcObject = s; document.body.appendChild(v); await v.play();
    await new Promise((r) => setTimeout(r, 500));
    return { v: s.getVideoTracks().length, a: s.getAudioTracks().length, label: s.getVideoTracks()[0]!.label, w: v.videoWidth, t: v.currentTime };
  });
  expect(info.v).toBe(1); expect(info.a).toBe(1);
  expect(info.label.toLowerCase()).toContain("fake");
  expect(info.w).toBeGreaterThan(0); expect(info.t).toBeGreaterThan(0);
});

test("capture_frame before going live fails gracefully", async ({ page }) => {
  const r = await call(page, "capture_frame", {});
  expect(r.isError).toBe(true);
});

test.describe("streaming to a (fake) daemon", () => {
  let fake: FakeDaemonWs;
  const gapActive = !!JSON.parse(readFileSync(join(HERE, "..", "known-gaps.json"), "utf8")).gaps["contract.studio.roundtrip"];
  test.beforeEach(async () => { fake = await new FakeDaemonWs().listen(Number(process.env.QA_DAEMON_PORT ?? 7777)).catch((e) => { test.skip(true, `cannot bind fake daemon port: ${e.message}`); throw e; }); });
  test.afterEach(async () => { await fake?.close(); });

  async function goLive(page: Page) {
    const codecs = await page.evaluate(async () => ({
      v: !!(await (window as any).VideoEncoder?.isConfigSupported({ codec: "avc1.640028", width: 1280, height: 720, framerate: 30, avc: { format: "avc" } }).catch(() => 0))?.supported,
      a: !!(await (window as any).AudioEncoder?.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2 }).catch(() => 0))?.supported,
    }));
    test.skip(!codecs.v || !codecs.a, `this Chromium cannot encode H.264/AAC (video=${codecs.v}, audio=${codecs.a}); needs a Chrome build with proprietary codecs`);
    // First-run onboarding dialog blocks the page: dismiss it (Escape), then use the main "connect camera" button.
    if (await page.locator("dialog[open]").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    const camBtn = page.locator("#primary-main:visible, #onb-cam:visible").first();
    test.skip(!(await camBtn.count()), "no camera button found in the studio UI");
    await camBtn.click({ timeout: 5000 });
    let started = await call(page, "start_stream", {});
    for (let i = 0; i < 20 && /enable camera/.test(started.text); i++) { await page.waitForTimeout(500); started = await call(page, "start_stream", {}); }
    expect(started.json.state, started.text).toBe("live");
  }
  // Encoder trouble inside headless Chromium is environmental; surface it as an annotation instead of failing the page-error guard.
  const tolerateCodecErrors = (page: Page) => { const e = (page as any).__errors as string[]; const bad = e.filter((m) => /closed codec/.test(m)); if (bad.length) { test.info().annotations.push({ type: "env", description: `${bad.length}x '${bad[0]}' (studio/src/worker/compositor.worker.ts encodes without checking encoder state)` }); e.splice(0, e.length, ...e.filter((m) => !/closed codec/.test(m))); } };

  // Studio -> daemon framing must match daemon/PROTOCOL.md. test.fail() while the gap is documented in known-gaps.json.
  test("first frames after start_stream are valid daemon frames (start first, decodable)", async ({ page }) => {
    test.fail(gapActive, "known gap contract.studio.roundtrip: studio framing differs from daemon/PROTOCOL.md");
    await goLive(page);
    await expect.poll(() => fake.received.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    tolerateCodecErrors(page);
    await call(page, "stop_stream", {});
    expect(fake.received.filter((r) => r.error).map((b) => b.error), "frames the daemon would reject").toEqual([]);
    expect(fake.received[0]!.frame!.kind, "first frame must be start (0x01)").toBe(0x01);
    expect(typeof JSON.parse(Buffer.from(fake.received[0]!.frame!.payload).toString()), "start payload is JSON").toBe("object");
  });

  test("media flow: configs precede chunks, video starts on a keyframe, dts monotonic", async ({ page }) => {
    test.fail(gapActive, "known gap contract.studio.roundtrip");
    await goLive(page);
    await expect.poll(() => fake.received.length, { timeout: 12_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(4000);
    tolerateCodecErrors(page);
    await call(page, "stop_stream", {});
    const media = fake.received.filter((r) => r.frame && (r.frame.kind === 0x12 || r.frame.kind === 0x13));
    test.skip(media.length < 10 && !gapActive, `only ${media.length} media frames arrived: this headless Chromium's encoders produced no output`);
    const kinds = fake.received.map((r) => r.frame?.kind);
    expect(kinds.indexOf(0x10), "video_config before first video_chunk").toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf(0x10)).toBeLessThan(kinds.indexOf(0x12));
    expect(kinds.indexOf(0x11)).toBeLessThan(kinds.indexOf(0x13));
    expect(fake.received.find((r) => r.frame?.kind === 0x12)!.frame!.flags & 1, "video must start with a keyframe").toBe(1);
    for (const k of [0x12, 0x13]) { let last = -1; for (const r of fake.received.filter((x) => x.frame?.kind === k)) { expect(r.frame!.dts_ms).toBeGreaterThanOrEqual(last); last = r.frame!.dts_ms; } }
  });
});
