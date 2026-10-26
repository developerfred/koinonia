// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBuffer } from "../src/chat/ring";
import { MetricsStore } from "../src/metrics";
import { SceneState } from "../src/scene";
import { LIVE_UNDO_MS, STOP_UNDO_MS, mountApp } from "../src/ui/app";
import type { AppController, UiHost } from "../src/ui/app";
import { STORAGE_KEY } from "../src/ui/prefs";

type FakeHost = UiHost & { state: string; calls: string[] };
function fakeHost(over: Partial<UiHost> = {}): FakeHost {
  const h: any = {
    state: "idle", calls: [] as string[],
    chat: new ChatBuffer(50), metrics: new MetricsStore(100), scenes: new SceneState(),
    support: { ok: true, missing: [] }, supportMessage: "",
    setAudio: () => true,
    async startStream() { h.calls.push("start"); h.state = "live"; return { state: "live" }; },
    async stopStream() { h.calls.push("stop"); h.state = "idle"; return { state: "idle" }; },
    streamState: () => h.state,
    captureFrame: async () => null,
    createPoll: (q: string) => { h.calls.push("poll:" + q); return { id: 1 }; },
    pinMessage: () => true,
    markHighlight: () => ({ id: 1, t: 0 }),
    exportClip: async () => ({ id: "c", state: "requested" }),
    now: () => Date.now(),
    enableCamera: async () => ({ getAudioTracks: () => [{}], getVideoTracks: () => [{}] }) as unknown as MediaStream,
    enableScreen: async () => ({}) as MediaStream,
    ...over,
  };
  return h as FakeHost;
}
const memStore = (init?: string | null) => {
  const m = new Map<string, string>(init ? [[STORAGE_KEY, init]] : []);
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const q = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const press = (code: string, alt = true) => document.dispatchEvent(new KeyboardEvent("keydown", { code, altKey: alt, bubbles: true, cancelable: true }));
const onboarded = JSON.stringify({ onboarded: true });

let root: HTMLElement, app: AppController, host: FakeHost, store: ReturnType<typeof memStore>, clock: number;
function mount(initial: string | null = onboarded, h = fakeHost()) {
  host = h; store = memStore(initial); clock = 1_000_000;
  root = document.createElement("div"); document.body.append(root);
  app = mountApp(root, host, { storage: store, now: () => clock });
}
async function ready() { // câmera + plataformas => passo "ready"
  await app.primary(); await flush();
}
beforeEach(() => { document.body.innerHTML = ""; document.documentElement.removeAttribute("data-view"); });
afterEach(() => { app?.destroy(); vi.useRealTimers(); });

describe("onboarding", () => {
  it("opens on first run and finishing marks it done", () => {
    mount(null);
    expect(q<HTMLDialogElement>("dlg-onb").open).toBe(true);
    expect(q("onb-step").textContent).toBe("Passo 1 de 3");
    q("onb-next").click(); q("onb-next").click();
    expect(q("onb-step").textContent).toBe("Passo 3 de 3");
    q("onb-next").click();
    expect(q<HTMLDialogElement>("dlg-onb").open).toBe(false);
    expect(JSON.parse(store.m.get(STORAGE_KEY)!).onboarded).toBe(true);
  });
  it("requires at least one platform", () => {
    mount(null);
    q("onb-next").click();
    root.querySelectorAll<HTMLInputElement>("#onb-body input").forEach((c) => { c.checked = false; c.dispatchEvent(new Event("change")); });
    q("onb-next").click();
    expect(q("onb-err").hidden).toBe(false);
    expect(q("onb-step").textContent).toBe("Passo 2 de 3");
  });
  it("does not open again once done", () => { mount(); expect(q<HTMLDialogElement>("dlg-onb").open).toBe(false); });
});

describe("two views", () => {
  it("defaults to Foco, toggles with button and Alt+V, persists", () => {
    mount();
    expect(app.view()).toBe("foco");
    expect(document.documentElement.dataset.view).toBe("foco");
    expect(q("v-foco").getAttribute("aria-pressed")).toBe("true");
    press("KeyV");
    expect(app.view()).toBe("painel");
    expect(q("v-painel").getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(store.m.get(STORAGE_KEY)!).view).toBe("painel");
    q("v-foco").click();
    expect(app.view()).toBe("foco");
  });
  it("keeps the same DOM nodes and all state across switches", async () => {
    mount();
    const video = q("preview");
    await ready(); // conecta câmera
    (q<HTMLInputElement>("poll-q")).value = "rascunho";
    q<HTMLInputElement>("clip-label").value = "meu rótulo";
    press("KeyV"); press("KeyV"); press("KeyV");
    expect(q("preview")).toBe(video);
    expect(q<HTMLInputElement>("poll-q").value).toBe("rascunho");
    expect(q<HTMLInputElement>("clip-label").value).toBe("meu rótulo");
    expect(app.step()).toBe("ready");
  });
  it("Foco collapses panels, Painel opens them all; each remembers its own choice", () => {
    mount();
    const d = (id: string) => root.querySelector<HTMLDetailsElement>(`[data-panel="${id}"]`)!;
    expect(d("chat").open).toBe(false);
    expect(d("checklist").open).toBe(true); // guia o próximo passo antes da live
    app.setView("painel");
    expect(d("chat").open).toBe(true);
    d("chat").open = false; d("chat").dispatchEvent(new Event("toggle"));
    app.setView("foco"); expect(d("chat").open).toBe(false);
    app.setView("painel"); expect(d("chat").open).toBe(false);
    expect(d("mixer").open).toBe(true);
  });
  it("shows exactly one primary action label per step", async () => {
    mount();
    expect(q("primary-main").textContent).toBe("Conectar câmera");
    await ready();
    expect(q("primary-main").textContent).toBe("Entrar ao vivo");
  });
});

describe("go live / stop with confirmation and undo", () => {
  it("asks for confirmation before going live and cancel does nothing", async () => {
    mount(); await ready();
    const p = app.primary(); await flush();
    expect(q<HTMLDialogElement>("dlg-confirm").open).toBe(true);
    q("cf-cancel").click(); await p;
    expect(host.calls).toEqual([]);
    expect(app.step()).toBe("ready");
  });
  it("goes live, offers undo that stops the stream", async () => {
    mount(); await ready();
    const p = app.primary(); await flush(); q("cf-ok").click(); await p; await flush();
    expect(host.calls).toEqual(["start"]);
    expect(app.step()).toBe("live");
    expect(q("undo-live").hidden).toBe(false);
    q("undo-live-btn").click(); await flush();
    expect(host.calls).toEqual(["start", "stop"]);
    clock += LIVE_UNDO_MS + 1; app.tick();
    expect(q("undo-live").hidden).toBe(true);
  });
  it("reports start failure inline without going live", async () => {
    mount(null, fakeHost({ startStream: async () => ({ state: "error", detail: "daemon fora do ar" }) }));
    app.prefs().onboarded = true; q<HTMLDialogElement>("dlg-onb").close();
    await ready();
    const p = app.primary(); await flush(); q("cf-ok").click(); await p; await flush();
    expect(q("step-error").hidden).toBe(false);
    expect(q("step-error").textContent).toContain("daemon fora do ar");
    expect(app.step()).toBe("ready");
  });
  it("stop needs confirmation, waits the undo window, and can be undone", async () => {
    vi.useFakeTimers();
    mount(); host.state = "live"; app.tick();
    expect(app.step()).toBe("live");
    let p = app.primary(); await vi.advanceTimersByTimeAsync(0);
    q("cf-ok").click(); await p;
    expect(q("stop-banner").hidden).toBe(false);
    expect(host.calls).toEqual([]);
    q("stop-undo").click();
    clock += STOP_UNDO_MS + 100; await vi.advanceTimersByTimeAsync(STOP_UNDO_MS + 100); app.tick();
    expect(host.calls).toEqual([]);
    expect(app.step()).toBe("live");
    // agora deixa confirmar de verdade
    p = app.primary(); await vi.advanceTimersByTimeAsync(0); q("cf-ok").click(); await p;
    clock += STOP_UNDO_MS + 100; await vi.advanceTimersByTimeAsync(STOP_UNDO_MS + 100);
    expect(host.calls).toEqual(["stop"]);
    expect(app.step()).not.toBe("live");
  });
  it("tick follows agents that start or stop the stream", () => {
    mount();
    host.state = "live"; app.tick();
    expect(app.step()).toBe("live");
    expect(q("live-pill").dataset.live).toBe("true");
    host.state = "idle"; app.tick();
    expect(q("live-pill").dataset.live).toBe("false");
  });
});

describe("notifications", () => {
  it("groups by topic, counts unread and can silence a group", () => {
    mount();
    app.notify("saude", "warn", "a"); app.notify("saude", "warn", "b"); app.notify("sistema", "info", "c");
    expect(q("notif-badge").textContent).toBe("3");
    expect(root.querySelectorAll("#toasts .toast")).toHaveLength(2); // um aviso por grupo, não uma pilha
    q("btn-notif").click();
    expect(q("drawer").hidden).toBe(false);
    expect(root.querySelectorAll("#drawer-groups .group")).toHaveLength(2);
    const cb = root.querySelector<HTMLInputElement>("#drawer-groups .group input")!;
    cb.checked = true; cb.dispatchEvent(new Event("change"));
    const before = root.querySelectorAll("#toasts .toast").length;
    root.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
    const silencedGroup = app.notifs.grouped().find((g) => g.silenced)!.group;
    app.notify(silencedGroup, "info", "quieto");
    expect(root.querySelectorAll("#toasts .toast")).toHaveLength(0);
    app.notify(silencedGroup, "critical", "urgente");
    expect(root.querySelectorAll("#toasts .toast")).toHaveLength(1);
    expect(before).toBeGreaterThan(0);
    q("notif-close").click();
    expect(q("notif-badge").hidden).toBe(true);
  });
});

describe("preferences", () => {
  it("applies theme, contrast, density and font size to the document and persists", () => {
    mount();
    root.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]')!.click();
    root.querySelector<HTMLInputElement>('input[name="contrast"][value="high"]')!.click();
    root.querySelector<HTMLInputElement>('input[name="density"][value="compacta"]')!.click();
    q("font-inc").click(); q("font-inc").click();
    const h = document.documentElement;
    expect(h.dataset.theme).toBe("dark"); expect(h.dataset.contrast).toBe("high"); expect(h.dataset.density).toBe("compacta");
    expect(h.style.getPropertyValue("--fs")).toBe("1.1");
    const saved = JSON.parse(store.m.get(STORAGE_KEY)!);
    expect(saved).toMatchObject({ theme: "dark", contrast: "high", density: "compacta", fontScale: 1.1 });
  });
  it("still works when localStorage is blocked", () => {
    host = fakeHost(); clock = 0;
    root = document.createElement("div"); document.body.append(root);
    const bad = { getItem() { throw new Error("x"); }, setItem() { throw new Error("y"); } };
    app = mountApp(root, host, { storage: bad, now: () => clock });
    app.toggleView();
    expect(app.view()).toBe("painel");
    expect(q("set-note").textContent).toContain("Não foi possível salvar");
  });
});

describe("panels", () => {
  it("validates and creates a poll", () => {
    mount();
    q("poll-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(q("poll-err").hidden).toBe(false);
    q<HTMLInputElement>("poll-q").value = "Qual jogo?";
    const [a, b] = root.querySelectorAll<HTMLInputElement>("#poll-opts input");
    a!.value = "A"; a!.dispatchEvent(new Event("input")); b!.value = "B"; b!.dispatchEvent(new Event("input"));
    q("poll-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(host.calls).toContain("poll:Qual jogo?");
  });
  it("renders chat from the shared buffer", () => {
    mount();
    host.chat.push({ ts: 1, platform: "twitch", user: "ana", text: "oi" });
    app.tick();
    expect(root.querySelectorAll("#chat-log .msg")).toHaveLength(1);
    expect(q("chat-log").textContent).toContain("ana");
  });
  it("shows token budget from metrics", () => {
    mount();
    host.metrics.push("tokens", 100_000);
    host.metrics.push("tokens", 90_000);
    app.tick();
    expect(q("tok-meter").dataset.level).toBe("warn");
  });
  it("mixer reports a missing source instead of failing silently", () => {
    mount(null, fakeHost({ setAudio: () => false }));
    q<HTMLDialogElement>("dlg-onb").close();
    root.querySelector<HTMLButtonElement>("#mixer button")!.click();
    expect(q("mixer-err").hidden).toBe(false);
  });
});
