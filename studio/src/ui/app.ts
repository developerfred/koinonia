import type { StudioApi } from "../tools/types";
import { t } from "./i18n";
import type { Key } from "./i18n";
import {
  FONT_STEP, NOTIF_GROUPS, PLATFORMS, clampFont, defaultPrefs, loadPrefs, safeStorage, savePrefs,
} from "./prefs";
import type { NotifGroup, Platform, Prefs, StorageLike, View } from "./prefs";
import { shellHtml } from "./shell";
import {
  DeferredAction, NotifCenter, budgetState, checklist, checklistSummary, formatDuration, healthReport, intervalProgress,
  nextStep, otherView, reminderDue,
} from "./viewstate";
import type { FlowCtx, HealthLevel, NotifLevel, StepId } from "./viewstate";

export interface UiHost extends StudioApi {
  support: { ok: boolean; missing: string[] };
  supportMessage: string;
  enableCamera(): Promise<MediaStream>;
  enableScreen(): Promise<MediaStream>;
}

export interface AppDeps {
  doc?: Document;
  storage?: StorageLike | null;
  now?: () => number;
}

export const STOP_UNDO_MS = 6000;
export const LIVE_UNDO_MS = 10_000;
const SNOOZE_MS = 10 * 60_000;
const MONTH_SEC = 30 * 86400;

const HEALTH_KEY: Record<HealthLevel, Key> = { idle: "health.idle", good: "health.good", warn: "health.warn", bad: "health.bad" };

export interface AppController {
  prefs(): Prefs;
  view(): View;
  setView(v: View): void;
  toggleView(): void;
  step(): StepId;
  primary(): Promise<void>;
  notify(group: NotifGroup, level: NotifLevel, text: string, action?: { label: string; run: () => void }): void;
  tick(): void;
  notifs: NotifCenter;
  destroy(): void;
}

export function mountApp(root: HTMLElement, host: UiHost, deps: AppDeps = {}): AppController {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const now = deps.now ?? (() => Date.now());
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;

  root.innerHTML = shellHtml();
  const $ = <E extends HTMLElement>(id: string) => root.querySelector<E>("#" + id)!;
  const html = doc.documentElement;

  let prefs: Prefs = loadPrefs(storage);
  let storageOk = true;
  const persist = () => { storageOk = savePrefs(prefs, storage); $("set-note").textContent = storageOk ? t("settings.saved") : t("settings.nostorage"); };

  // ---- estado de runtime (nunca perdido ao trocar de visualização: os nós são os mesmos) ----
  const notifs = new NotifCenter(100, now);
  for (const g of NOTIF_GROUPS) notifs.setSilenced(g, prefs.silenced[g]);
  let cameraOn = false, micConnected = false, screenOn = false;
  const muted: Record<string, boolean> = { mic: false, screen: false };
  let starting = false, liveSince = 0, undoLiveUntil = 0;
  let breakSince = 0, reminderShown = false;
  let lastHealth: HealthLevel = "idle", lastBudget = "ok";
  let chatCursor = 0, chatCount = 0;
  const marks: string[] = [];
  const stopAction = new DeferredAction(now);
  const toastTimers = new Map<NotifGroup, number>();
  let drawerOpen = false;

  const focusPrimary = () => $<HTMLElement>(prefs.view === "foco" ? "primary-main" : "primary-bar").focus();
  const live = () => host.streamState() === "live";
  const say = (s: string) => { $("sr-live").textContent = ""; $("sr-live").textContent = s; };
  const tr = (el: HTMLElement, s: string) => { if (el.textContent !== s) el.textContent = s; };

  // ================= aplicação de preferências =================
  function applyPrefs() {
    html.dataset.view = prefs.view;
    if (prefs.theme === "auto") html.removeAttribute("data-theme"); else html.dataset.theme = prefs.theme;
    if (prefs.contrast === "high") html.dataset.contrast = "high"; else html.removeAttribute("data-contrast");
    html.dataset.density = prefs.density;
    html.style.setProperty("--fs", String(prefs.fontScale));
    $("v-foco").setAttribute("aria-pressed", String(prefs.view === "foco"));
    $("v-painel").setAttribute("aria-pressed", String(prefs.view === "painel"));
    applyPanels();
    renderSettings();
  }

  function panelOpen(id: string): boolean {
    const c = prefs.collapsed[prefs.view];
    if (prefs.view === "painel") return c[id] !== true;
    return c[id] === false || (id === "checklist" && !live() && c[id] === undefined);
  }
  function applyPanels() {
    root.querySelectorAll<HTMLDetailsElement>("details.panel").forEach((d) => {
      const id = d.dataset.panel!;
      d.open = panelOpen(id);
      d.dataset.stepFocus = String(id === "checklist" && !live());
    });
  }
  root.querySelectorAll<HTMLDetailsElement>("details.panel").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open === panelOpen(d.dataset.panel!)) return; // mudança programática, não do usuário
      prefs.collapsed[prefs.view][d.dataset.panel!] = !d.open;
      persist();
    });
  });

  function setView(v: View, announce = true) {
    if (v === prefs.view && html.dataset.view === v) return;
    const hadFocus = root.contains(doc.activeElement) && doc.activeElement !== doc.body;
    prefs.view = v; persist(); applyPrefs(); render();
    if (announce) say(t(v === "foco" ? "view.changed.foco" : "view.changed.painel"));
    const ae = doc.activeElement as HTMLElement | null;
    if (hadFocus && (!ae || ae === doc.body || !(ae as HTMLElement).offsetParent && ae.tagName !== "BODY" && ae !== $("main"))) $("main").focus();
  }
  const toggleView = () => setView(otherView(prefs.view));

  // ================= fluxo / próximo passo =================
  const ctx = (): FlowCtx => ({
    supported: host.support.ok, cameraOn, micOn: micConnected && !muted.mic,
    platforms: prefs.platforms, live: live(), manual: prefs.manual,
  });
  const step = () => nextStep(ctx());

  function render() {
    const c = ctx();
    const st = nextStep(c);
    const isLive = c.live;
    const stopping = stopAction.state === "pending";

    // cartão de passo
    tr($("step-title"), t(`step.${st}.title` as Key));
    tr($("step-body"), t(`step.${st}.body` as Key));
    $("step-eyebrow").hidden = isLive;
    const label = starting ? t("status.starting") : stopping ? t("status.stopping") : t(`step.${st}.action` as Key);
    for (const id of ["primary-main", "primary-bar"]) {
      const b = $<HTMLButtonElement>(id);
      tr(b, label);
      b.disabled = starting || stopping;
      b.classList.toggle("btn-live", isLive);
      b.classList.toggle("btn-primary", !isLive);
    }
    // pílula de transmissão
    const pill = $("live-pill");
    pill.dataset.live = String(isLive);
    tr($("live-pill-text"), starting ? t("status.starting") : stopping ? t("status.stopping") : t(isLive ? "status.live" : "status.idle"));
    $("live-time").hidden = !isLive;
    $("live-timer").hidden = !isLive;
    $("stage-empty").hidden = cameraOn;
    // checklist
    renderChecklist(c);
    const sum = checklistSummary(checklist(c));
    tr($("sum-checklist"), t("checklist.progress", { done: sum.done, total: sum.total }));
    // faixas
    $("undo-live").hidden = !(isLive && now() < undoLiveUntil);
    $("stop-banner").hidden = !stopping;
    if (stopping) tr($("stop-text"), t("live.stopping", { s: Math.ceil(stopAction.remainingMs() / 1000) }));
    renderScenes(); renderMixer(); renderHealth(); renderTokens();
    tr($("sum-scenes"), host.scenes.current);
    tr($("sum-chat"), t("chat.count", { n: chatCount }));
    const tech = { state: host.streamState(), view: prefs.view, scene: host.scenes.current, chatCursor: host.chat.cursor, support: host.support.ok };
    tr($("status"), JSON.stringify(tech, null, 1));
    const sm = $("support-msg"); sm.hidden = !host.supportMessage; tr(sm, host.supportMessage);
    tr($("sum-health"), t(HEALTH_KEY[lastHealth]));
  }

  function renderChecklist(c: FlowCtx) {
    const box = $("checklist");
    const items = checklist(c);
    const sig = JSON.stringify(items.map((i) => [i.id, i.ok]));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = "";
    for (const it of items) {
      const row = doc.createElement("div");
      row.className = "check"; row.dataset.ok = String(it.ok);
      if (it.manual) {
        const cb = doc.createElement("input"); cb.type = "checkbox"; cb.id = "ck-" + it.id; cb.checked = it.ok;
        cb.addEventListener("change", () => { prefs.manual[it.id] = cb.checked; persist(); render(); });
        const lb = doc.createElement("label"); lb.htmlFor = cb.id; lb.textContent = t(it.label);
        row.append(cb, lb);
      } else {
        const mark = doc.createElement("span"); mark.className = "mark"; mark.setAttribute("aria-hidden", "true");
        const txt = doc.createElement("span"); txt.textContent = t(it.label);
        const sr = doc.createElement("span"); sr.className = "vh"; sr.textContent = it.ok ? ` (${t("common.on")})` : ` (${t("common.off")})`;
        row.append(mark, txt, sr);
      }
      const tag = doc.createElement("span"); tag.className = "tag"; tag.textContent = t(it.required ? "checklist.required" : "checklist.recommended");
      row.append(tag); box.append(row);
    }
  }

  function renderScenes() {
    const box = $("scene-btns");
    const names = host.scenes.names(); const cur = host.scenes.current;
    const sig = names.join(",") + "|" + cur;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig; box.textContent = "";
    for (const n of names) {
      const b = doc.createElement("button"); b.type = "button"; b.className = "btn";
      b.setAttribute("aria-pressed", String(n === cur));
      const key = ("scenes." + n) as Key;
      b.textContent = t(key) === key ? n : t(key);
      b.addEventListener("click", () => { if (host.scenes.switchScene(n)) { say(t("scenes.switched", { name: b.textContent ?? n })); render(); } });
      box.append(b);
    }
  }

  function renderMixer() {
    const box = $("mixer");
    const sig = JSON.stringify(muted) + cameraOn + screenOn;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig; box.textContent = "";
    for (const src of ["mic", "screen"] as const) {
      const row = doc.createElement("div"); row.className = "row";
      const name = doc.createElement("span"); name.className = "label"; name.style.flex = "1"; name.textContent = t(src === "mic" ? "mixer.mic" : "mixer.screen");
      const b = doc.createElement("button"); b.type = "button"; b.className = "btn btn-sm";
      b.setAttribute("aria-pressed", String(muted[src]));
      b.textContent = muted[src] ? t("mixer.muted") : t("mixer.mute");
      b.addEventListener("click", () => {
        const next = !muted[src];
        const ok = host.setAudio(src, { muted: next });
        const err = $("mixer-err");
        if (!ok) { err.hidden = false; err.textContent = t("mixer.missing"); return; }
        err.hidden = true; muted[src] = next; box.dataset.sig = ""; render();
      });
      row.append(name, b); box.append(row);
    }
  }

  function renderHealth() {
    const rep = healthReport(host.metrics, live());
    const pill = $("health-pill");
    pill.dataset.level = rep.level;
    tr($("health-pill-text"), t(HEALTH_KEY[rep.level]));
    lastHealth = rep.level;
    const m = $("health-metrics");
    const defs: [string, Key, number | undefined][] = [
      ["kbps", "health.metric.kbps", rep.values.kbps], ["fps", "health.metric.fps", rep.values.fps],
      ["dropped", "health.metric.dropped", rep.values.dropped], ["errors", "health.metric.errors", rep.values.errors],
    ];
    const sig = JSON.stringify(defs.map((d) => d[2])) + rep.level;
    if (m.dataset.sig !== sig) {
      m.dataset.sig = sig; m.textContent = "";
      for (const [, lbl, v] of defs) {
        const d = doc.createElement("div"); d.className = "metric";
        const l = doc.createElement("div"); l.className = "muted"; l.textContent = t(lbl);
        const x = doc.createElement("div"); x.className = "v"; x.textContent = v === undefined ? "–" : String(Math.round(v));
        if (v === undefined) x.setAttribute("aria-label", t("health.nodata"));
        d.append(l, x); m.append(d);
      }
      const ul = $("health-reasons"); ul.textContent = "";
      for (const r of rep.reasons) { const li = doc.createElement("li"); li.className = r.level === "bad" ? "lv-bad" : "lv-warn"; li.textContent = t(r.key, { v: Math.round(r.v) }); ul.append(li); }
    }
    const hint = $("health-hint"); const worst = rep.reasons[0];
    hint.hidden = !worst; if (worst) tr(hint, t(worst.key, { v: Math.round(worst.v) }));
  }

  function tokensSpent(): number {
    const q = host.metrics.query("tokens", MONTH_SEC, "avg");
    const n = host.metrics.query("tokens", MONTH_SEC, "count");
    return q.v !== undefined && n.v !== undefined ? Math.round(q.v * n.v) : 0;
  }
  function renderTokens() {
    const spent = tokensSpent(); const b = budgetState(spent, prefs.tokenBudget);
    const meter = $("tok-meter"); meter.dataset.level = b.level;
    ($("tok-meter").firstElementChild as HTMLElement).style.width = Math.min(100, Math.round(b.ratio * 100)) + "%";
    const txt = t("tokens.spent", { spent: spent.toLocaleString("pt-BR"), budget: prefs.tokenBudget.toLocaleString("pt-BR") });
    meter.setAttribute("aria-label", txt);
    tr($("tok-text"), txt);
    tr($("tok-level"), t(b.level === "ok" ? "tokens.ok" : b.level === "warn" ? "tokens.warn" : "tokens.over"));
    tr($("sum-tokens"), Math.round(b.ratio * 100) + "%");
    if (b.level !== lastBudget) {
      if (b.level !== "ok") notify("tokens", b.level === "over" ? "critical" : "warn", t(b.level === "warn" ? "tokens.warn" : "tokens.over"));
      lastBudget = b.level;
    }
  }

  // ================= notificações =================
  function notify(group: NotifGroup, level: NotifLevel, text: string, action?: { label: string; run: () => void }) {
    const { interrupt } = notifs.add(group, level, text);
    renderBadge();
    if (drawerOpen) renderDrawer();
    if (!interrupt) return;
    const box = $("toasts");
    box.querySelector(`[data-group="${group}"]`)?.remove();
    const prev = toastTimers.get(group); if (prev !== undefined) clearTimeout(prev);
    const el = doc.createElement("div"); el.className = "toast"; el.dataset.group = group; el.dataset.level = level;
    if (level === "critical") el.setAttribute("role", "alert");
    const gcount = notifs.grouped().find((g) => g.group === group)?.count ?? 1;
    const tx = doc.createElement("span"); tx.className = "t-text";
    tx.textContent = gcount > 1 ? `${text} (${t("notif.n", { n: gcount })})` : text;
    el.append(tx);
    const close = () => { el.remove(); const h = toastTimers.get(group); if (h !== undefined) clearTimeout(h); toastTimers.delete(group); };
    if (action) {
      const a = doc.createElement("button"); a.type = "button"; a.className = "btn btn-sm"; a.textContent = action.label;
      a.addEventListener("click", () => { close(); action.run(); }); el.append(a);
    }
    const x = doc.createElement("button"); x.type = "button"; x.className = "btn btn-sm btn-ghost"; x.textContent = "×";
    x.setAttribute("aria-label", t("common.dismiss")); x.addEventListener("click", close); el.append(x);
    box.append(el);
    while (box.children.length > 3) box.firstElementChild?.remove();
    if (level !== "critical") toastTimers.set(group, win.setTimeout(close, action ? 10_000 : 7000));
  }
  function renderBadge() {
    const n = notifs.unread(); const b = $("notif-badge");
    b.hidden = n === 0; b.textContent = String(n);
    $("btn-notif").setAttribute("aria-label", n ? `${t("notif.title")}: ${t("notif.count", { n })}` : t("notif.title"));
  }
  function renderDrawer() {
    const box = $("drawer-groups"); box.textContent = "";
    const groups = notifs.grouped();
    if (!groups.length) { const p = doc.createElement("p"); p.className = "muted"; p.textContent = t("notif.empty"); box.append(p); }
    for (const g of groups) {
      const d = doc.createElement("div"); d.className = "group";
      const h = doc.createElement("h3"); h.textContent = t(`notif.group.${g.group}` as Key);
      if (g.unread) { const b = doc.createElement("span"); b.className = "badge"; b.textContent = String(g.unread); h.append(b); }
      const p = doc.createElement("p"); p.textContent = g.latest.text;
      const meta = doc.createElement("p"); meta.className = "muted"; meta.textContent = t("notif.n", { n: g.count });
      const lbl = doc.createElement("label"); lbl.className = "check";
      const cb = doc.createElement("input"); cb.type = "checkbox"; cb.checked = g.silenced;
      cb.addEventListener("change", () => { notifs.setSilenced(g.group, cb.checked); prefs.silenced[g.group] = cb.checked; persist(); });
      lbl.append(cb, doc.createTextNode(`${t("notif.silence")}: ${t(`notif.group.${g.group}` as Key)}`));
      d.append(h, p, meta, lbl); box.append(d);
    }
  }
  function setDrawer(open: boolean) {
    drawerOpen = open; $("drawer").hidden = !open;
    $("btn-notif").setAttribute("aria-expanded", String(open));
    if (open) { renderDrawer(); ($("drawer").querySelector("button,input") as HTMLElement | null)?.focus(); }
    else { notifs.markAllRead(); renderBadge(); }
  }

  // ================= diálogos =================
  const openDlg = (d: HTMLDialogElement) => { if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); };
  const closeDlg = (d: HTMLDialogElement) => { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); };

  function confirmDlg(o: { title: string; body: string; warn?: string; ok: string; focusCancel?: boolean }): Promise<boolean> {
    const d = $<HTMLDialogElement>("dlg-confirm");
    tr($("cf-title"), o.title); tr($("cf-body"), o.body);
    const w = $("cf-warn"); w.hidden = !o.warn; w.textContent = o.warn ?? "";
    tr($("cf-ok"), o.ok);
    return new Promise((res) => {
      let done = false;
      const fin = (v: boolean) => { if (done) return; done = true; $("cf-ok").onclick = null; $("cf-cancel").onclick = null; d.onclose = null; closeDlg(d); res(v); };
      $("cf-ok").onclick = () => fin(true); $("cf-cancel").onclick = () => fin(false); d.onclose = () => fin(false);
      d.oncancel = () => fin(false);
      openDlg(d);
      ($(o.focusCancel ? "cf-cancel" : "cf-ok") as HTMLElement).focus();
    });
  }

  // ---- onboarding ----
  let onbStep = 1; let onbCamMsg = "";
  function renderOnb() {
    const total = 3;
    tr($("onb-step"), t("onb.step", { n: onbStep, total }));
    root.querySelectorAll<HTMLElement>("#onb-steps i").forEach((i, k) => { i.dataset.on = String(k < onbStep); });
    const body = $("onb-body"); body.textContent = ""; $("onb-err").hidden = true;
    const title = $("onb-title");
    if (onbStep === 1) {
      tr(title, t("onb.camera.title"));
      const p = doc.createElement("p"); p.textContent = t("onb.camera.body");
      const b = doc.createElement("button"); b.type = "button"; b.className = "btn btn-primary"; b.id = "onb-cam"; b.textContent = t("step.camera.action");
      b.disabled = cameraOn;
      b.addEventListener("click", async () => { onbCamMsg = ""; await connectCamera(true); renderOnb(); ($("onb-next")).focus(); });
      const msg = doc.createElement("p"); msg.setAttribute("role", "status");
      msg.className = cameraOn ? "lv-good" : "err"; msg.textContent = cameraOn ? t("onb.camera.ok") : onbCamMsg;
      if (!cameraOn && !onbCamMsg) msg.hidden = true;
      body.append(p, b, msg);
    } else if (onbStep === 2) {
      tr(title, t("onb.platforms.title"));
      const p = doc.createElement("p"); p.textContent = t("onb.platforms.body"); body.append(p);
      for (const pf of PLATFORMS) {
        const l = doc.createElement("label"); l.className = "check";
        const cb = doc.createElement("input"); cb.type = "checkbox"; cb.checked = prefs.platforms.includes(pf);
        cb.addEventListener("change", () => setPlatform(pf, cb.checked));
        l.append(cb, doc.createTextNode(t(`platform.${pf}` as Key))); body.append(l);
      }
    } else {
      tr(title, t("onb.view.title"));
      const p = doc.createElement("p"); p.textContent = t("onb.view.body"); body.append(p);
      for (const v of ["foco", "painel"] as const) {
        const l = doc.createElement("label"); l.className = "check";
        const r = doc.createElement("input"); r.type = "radio"; r.name = "onb-view"; r.value = v; r.checked = prefs.view === v;
        r.addEventListener("change", () => { if (r.checked) setView(v, false); });
        l.append(r, doc.createTextNode(t(v === "foco" ? "onb.view.foco" : "onb.view.painel"))); body.append(l);
      }
      const l = doc.createElement("label"); l.className = "check";
      const cb = doc.createElement("input"); cb.type = "checkbox"; cb.checked = prefs.reminders;
      cb.addEventListener("change", () => { prefs.reminders = cb.checked; persist(); renderSettings(); });
      l.append(cb, doc.createTextNode(`${t("settings.reminders")} (${prefs.reminderMin} min)`)); body.append(l);
    }
    ($("onb-back") as HTMLButtonElement).hidden = onbStep === 1;
    tr($("onb-next"), onbStep === total ? t("common.done") : t("common.next"));
  }
  function openOnboarding(from = 1) {
    onbStep = from; onbCamMsg = ""; renderOnb(); openDlg($<HTMLDialogElement>("dlg-onb"));
  }
  function finishOnboarding() {
    prefs.onboarded = true; persist(); closeDlg($<HTMLDialogElement>("dlg-onb")); render();
    focusPrimary();
  }
  $("onb-next").addEventListener("click", () => {
    if (onbStep === 2 && prefs.platforms.length === 0) { const e = $("onb-err"); e.hidden = false; e.textContent = t("onb.platforms.none"); return; }
    if (onbStep >= 3) return finishOnboarding();
    onbStep++; renderOnb(); ($("onb-body").querySelector("button,input") as HTMLElement | null)?.focus();
  });
  $("onb-back").addEventListener("click", () => { onbStep = Math.max(1, onbStep - 1); renderOnb(); });
  $("onb-skip").addEventListener("click", finishOnboarding);
  $<HTMLDialogElement>("dlg-onb").addEventListener("close", () => { if (!prefs.onboarded) { prefs.onboarded = true; persist(); } });

  function setPlatform(p: Platform, on: boolean) {
    prefs.platforms = PLATFORMS.filter((x) => (x === p ? on : prefs.platforms.includes(x)));
    persist(); render();
  }

  // ---- preferências ----
  function renderSettings() {
    const setRadio = (name: string, v: string) => root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((i) => { i.checked = i.value === v; });
    setRadio("theme", prefs.theme); setRadio("contrast", prefs.contrast); setRadio("density", prefs.density);
    tr($("font-out"), Math.round(prefs.fontScale * 100) + "%");
    $<HTMLInputElement>("set-rem").checked = prefs.reminders;
    $<HTMLInputElement>("set-rem-min").value = String(prefs.reminderMin);
    $<HTMLInputElement>("set-budget").value = String(prefs.tokenBudget);
  }
  root.querySelectorAll<HTMLInputElement>('input[name="theme"],input[name="contrast"],input[name="density"]').forEach((i) =>
    i.addEventListener("change", () => {
      if (!i.checked) return;
      (prefs as unknown as Record<string, string>)[i.name] = i.value; persist(); applyPrefs();
    }));
  const bumpFont = (d: number) => { prefs.fontScale = clampFont(prefs.fontScale + d); persist(); applyPrefs(); };
  $("font-dec").addEventListener("click", () => bumpFont(-FONT_STEP));
  $("font-inc").addEventListener("click", () => bumpFont(FONT_STEP));
  $("set-rem").addEventListener("change", (e) => { prefs.reminders = (e.target as HTMLInputElement).checked; breakSince = now(); persist(); });
  $("set-rem-min").addEventListener("change", (e) => { const v = Number((e.target as HTMLInputElement).value); if (v >= 5 && v <= 180) { prefs.reminderMin = Math.round(v); persist(); } });
  $("set-budget").addEventListener("change", (e) => { const v = Number((e.target as HTMLInputElement).value); if (v >= 0) { prefs.tokenBudget = Math.round(v); persist(); render(); } });
  $("set-replay").addEventListener("click", () => { closeDlg($<HTMLDialogElement>("dlg-settings")); openOnboarding(1); });
  $("set-reset").addEventListener("click", () => {
    const keep = prefs.view; prefs = { ...defaultPrefs(), view: keep, onboarded: true };
    for (const g of NOTIF_GROUPS) notifs.setSilenced(g, prefs.silenced[g]);
    persist(); applyPrefs(); render();
  });
  $("set-close").addEventListener("click", () => closeDlg($<HTMLDialogElement>("dlg-settings")));
  $("hp-close").addEventListener("click", () => closeDlg($<HTMLDialogElement>("dlg-help")));

  // ================= ações de mídia / transmissão =================
  async function connectCamera(fromOnboarding = false) {
    try {
      const s = await host.enableCamera();
      try { $<HTMLVideoElement>("preview").srcObject = s; } catch { /* prévia é opcional; a câmera já está ativa */ }
      cameraOn = true; micConnected = s.getAudioTracks().length > 0; $("step-error").hidden = true;
      say(t("onb.camera.ok"));
    } catch (e) {
      const msg = t("onb.camera.err", { detail: (e as Error)?.message ?? String(e) });
      onbCamMsg = msg;
      if (!fromOnboarding) { const er = $("step-error"); er.hidden = false; er.textContent = msg; }
      notify("sistema", "warn", msg);
    }
    render();
  }

  async function shareScreen() {
    try { await host.enableScreen(); screenOn = true; host.scenes.switchScene("screen"); say(t("scenes.switched", { name: t("scenes.screen") })); }
    catch (e) { notify("sistema", "warn", (e as Error)?.message ?? String(e)); }
    render();
  }

  async function goLive() {
    const c = ctx(); const sum = checklistSummary(checklist(c));
    const names = prefs.platforms.map((p) => t(`platform.${p}` as Key)).join(", ");
    const ok = await confirmDlg({
      title: t("golive.confirm.title"), body: t("golive.confirm.body", { platforms: names }),
      warn: sum.pending.length ? t("golive.confirm.warn", { items: sum.pending.map((i) => t(i.label)).join(", ") }) : undefined,
      ok: t("golive.confirm.ok"),
    });
    if (!ok) { focusPrimary(); return; }
    starting = true; $("step-error").hidden = true; render();
    const r = await host.startStream([...prefs.platforms]).catch((e: unknown) => ({ state: "error", detail: String((e as Error)?.message ?? e) }));
    starting = false;
    if (r.state === "live") {
      liveSince = now(); undoLiveUntil = now() + LIVE_UNDO_MS; breakSince = now(); reminderShown = false;
      notify("live", "info", t("live.started"), { label: t("common.undo"), run: () => void undoLive() });
      say(t("live.started"));
    } else {
      const msg = t("live.start.failed", { detail: r.detail ?? r.state });
      const er = $("step-error"); er.hidden = false; er.textContent = msg;
      notify("live", "critical", msg);
    }
    applyPanels(); render();
  }
  async function undoLive() {
    undoLiveUntil = 0;
    await host.stopStream(); liveSince = 0;
    notify("live", "info", t("live.stopped")); applyPanels(); render();
  }

  async function requestStop() {
    if (stopAction.state === "pending") return;
    const ok = await confirmDlg({
      title: t("stop.confirm.title"), body: t("stop.confirm.body", { s: STOP_UNDO_MS / 1000 }), ok: t("stop.confirm.ok"), focusCancel: true,
    });
    if (!ok) return;
    stopAction.start(() => {
      void host.stopStream().then(() => { liveSince = 0; undoLiveUntil = 0; notify("live", "info", t("live.stopped")); say(t("live.stopped")); applyPanels(); render(); });
    }, STOP_UNDO_MS);
    win.setTimeout(() => { stopAction.tick(); render(); }, STOP_UNDO_MS + 30);
    say(t("live.stopping", { s: STOP_UNDO_MS / 1000 })); render();
    $<HTMLElement>("stop-undo").focus();
  }
  function undoStop() {
    if (stopAction.undo()) { notify("live", "info", t("live.stop.cancelled")); say(t("live.stop.cancelled")); render(); focusPrimary(); }
  }

  async function primary() {
    if (stopAction.state === "pending") return undoStop();
    if (starting) return;
    switch (step()) {
      case "camera": return connectCamera();
      case "platforms": return openOnboarding(2);
      case "ready": return goLive();
      case "live": return requestStop();
      case "unsupported": { const d = root.querySelector<HTMLDetailsElement>('[data-panel="tech"]')!; d.open = true; d.scrollIntoView?.(); return; }
    }
  }

  // ================= painéis: chat, enquetes, clipes =================
  function pullChat() {
    const d = host.chat.since(chatCursor, { limit: 50, fields: ["id", "platform", "user", "text"], dedupe: false });
    chatCursor = d.c;
    if (!d.m.length) return;
    const log = $("chat-log"); $("chat-empty").hidden = true;
    for (const m of d.m) {
      const row = doc.createElement("div"); row.className = "msg";
      const p = doc.createElement("span"); p.className = "p"; p.textContent = String(m.p ?? "");
      const u = doc.createElement("span"); u.className = "u"; u.textContent = String(m.u ?? "");
      const x = doc.createElement("span"); x.textContent = String(m.t ?? "");
      const b = doc.createElement("button"); b.type = "button"; b.className = "btn btn-sm btn-ghost x"; b.textContent = t("chat.pin");
      const id = Number(m.i);
      b.addEventListener("click", () => { if (host.pinMessage(id)) say(t("chat.pinned")); });
      row.append(p, u, x, b); log.append(row); chatCount++;
    }
    while (log.querySelectorAll(".msg").length > 100) log.querySelector(".msg")?.remove();
    if (d.more) pullChat();
  }

  const pollOpts: string[] = ["", ""];
  function renderPollOpts() {
    const box = $("poll-opts");
    if (box.children.length === pollOpts.length) return;
    box.textContent = "";
    pollOpts.forEach((v, i) => {
      const f = doc.createElement("div"); f.className = "field";
      const l = doc.createElement("label"); l.htmlFor = "poll-o" + i; l.textContent = t("polls.option", { n: i + 1 });
      const inp = doc.createElement("input"); inp.type = "text"; inp.id = "poll-o" + i; inp.maxLength = 50; inp.value = v; inp.autocomplete = "off";
      inp.addEventListener("input", () => { pollOpts[i] = inp.value; });
      f.append(l, inp); box.append(f);
    });
    $<HTMLButtonElement>("poll-add").disabled = pollOpts.length >= 5;
  }
  $("poll-add").addEventListener("click", () => { if (pollOpts.length < 5) { pollOpts.push(""); renderPollOpts(); ($("poll-opts").lastElementChild?.querySelector("input") as HTMLElement | null)?.focus(); } });
  $("poll-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>("poll-q").value.trim(); const opts = pollOpts.map((o) => o.trim()).filter(Boolean);
    const err = $("poll-err");
    if (!q) { err.hidden = false; err.textContent = t("polls.err.question"); $("poll-q").focus(); return; }
    if (opts.length < 2) { err.hidden = false; err.textContent = t("polls.err.options"); return; }
    err.hidden = true;
    host.createPoll(q, opts, Number($<HTMLSelectElement>("poll-dur").value));
    notify("sistema", "info", t("polls.created"));
    $<HTMLInputElement>("poll-q").value = ""; pollOpts.splice(0, pollOpts.length, "", ""); $("poll-opts").textContent = ""; renderPollOpts();
  });
  function addClipLine(s: string) {
    marks.unshift(s); marks.length = Math.min(marks.length, 10);
    const ul = $("clip-list"); ul.textContent = "";
    for (const m of marks) { const li = doc.createElement("li"); li.textContent = m; ul.append(li); }
  }
  $("clip-mark").addEventListener("click", () => {
    const inp = $<HTMLInputElement>("clip-label"); const label = inp.value.trim() || undefined;
    const r = host.markHighlight(label); inp.value = "";
    addClipLine(`#${r.id} ${new Date(r.t).toLocaleTimeString("pt-BR")}${label ? " – " + label : ""}`);
    say(t("clips.marked"));
  });
  $("clip-export").addEventListener("click", async () => {
    const r = await host.exportClip(Number($<HTMLSelectElement>("clip-sec").value));
    addClipLine(`${r.id}: ${r.state}`); notify("sistema", "info", t("clips.exported", { state: r.state }));
  });

  // ================= tick (1 Hz) =================
  function tick() {
    const n = now();
    stopAction.tick();
    // sincroniza com mudanças feitas por agentes/ferramentas
    const isLive = live();
    if (isLive && !liveSince) { liveSince = n; breakSince = n; reminderShown = false; notify("live", "info", t("live.started")); applyPanels(); }
    if (!isLive && liveSince && stopAction.state !== "pending") { liveSince = 0; notify("live", "info", t("live.stopped")); applyPanels(); }
    pullChat();
    render();
    if (isLive) {
      tr($("live-time"), formatDuration(n - liveSince)); tr($("timer-elapsed"), formatDuration(n - liveSince));
      const iv = prefs.reminderMin * 60_000;
      const bw = $("break-wrap"); bw.hidden = !prefs.reminders;
      if (prefs.reminders) {
        const prog = intervalProgress(n, breakSince, iv);
        $<HTMLProgressElement>("break-progress").value = Math.round(prog * 100);
        const left = formatDuration(Math.max(0, iv - (n - breakSince)));
        $("break-progress").setAttribute("aria-label", t("reminder.next", { t: left }));
        tr($("break-text"), t("reminder.next", { t: left }));
      }
      if (reminderDue({ enabled: prefs.reminders, live: true, now: n, since: breakSince, intervalMs: iv, shown: reminderShown })) {
        reminderShown = true; $("reminder").hidden = false; say(t("reminder.break.title"));
      }
    } else { $("reminder").hidden = true; }
    // transições de saúde (só avisa quando piora ou se recupera de um problema)
    const rank: Record<HealthLevel, number> = { idle: 0, good: 1, warn: 2, bad: 3 };
    if (isLive) {
      const cur = lastHealth;
      const r0 = healthReport(host.metrics, true).reasons[0];
      if (rank[cur] > rank[prevHealth] && rank[cur] >= 2) notify("saude", cur === "bad" ? "critical" : "warn", t(HEALTH_KEY[cur]) + (r0 ? ": " + t(r0.key, { v: Math.round(r0.v) }) : ""));
      else if (prevHealth === "bad" && cur === "good") notify("saude", "info", t("health.good"));
    }
    prevHealth = lastHealth;
  }
  let prevHealth: HealthLevel = "idle";
  $("rem-ok").addEventListener("click", () => { breakSince = now(); reminderShown = false; $("reminder").hidden = true; });
  $("rem-snooze").addEventListener("click", () => { breakSince = now() - prefs.reminderMin * 60_000 + SNOOZE_MS; reminderShown = false; $("reminder").hidden = true; });
  $("rem-off").addEventListener("click", () => { prefs.reminders = false; persist(); $("reminder").hidden = true; renderSettings(); });

  // ================= eventos globais =================
  $("v-foco").addEventListener("click", () => setView("foco"));
  $("v-painel").addEventListener("click", () => setView("painel"));
  for (const id of ["primary-main", "primary-bar"]) $(id).addEventListener("click", () => void primary());
  $("stop-undo").addEventListener("click", undoStop);
  $("undo-live-btn").addEventListener("click", () => void undoLive());
  $("share-screen").addEventListener("click", () => void shareScreen());
  $("btn-notif").addEventListener("click", () => setDrawer(!drawerOpen));
  $("notif-close").addEventListener("click", () => { setDrawer(false); $("btn-notif").focus(); });
  $("notif-read").addEventListener("click", () => { notifs.markAllRead(); renderBadge(); renderDrawer(); });
  $("notif-clear").addEventListener("click", () => { notifs.clear(); renderBadge(); renderDrawer(); });
  $("btn-settings").addEventListener("click", () => { renderSettings(); openDlg($<HTMLDialogElement>("dlg-settings")); });
  $("btn-help").addEventListener("click", () => openDlg($<HTMLDialogElement>("dlg-help")));
  $("drawer").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") { setDrawer(false); $("btn-notif").focus(); } });

  const typing = (el: EventTarget | null) => {
    const e = el as HTMLElement | null;
    return !!e && (e.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    if (e.altKey && !e.shiftKey) {
      const map: Record<string, () => void> = {
        KeyV: toggleView, KeyG: () => void primary(), KeyN: () => setDrawer(!drawerOpen),
        Comma: () => { renderSettings(); openDlg($<HTMLDialogElement>("dlg-settings")); },
      };
      const f = map[e.code]; if (f) { e.preventDefault(); f(); }
      return;
    }
    if (e.key === "?" && !typing(e.target)) { e.preventDefault(); openDlg($<HTMLDialogElement>("dlg-help")); }
  };
  doc.addEventListener("keydown", onKey);

  // ================= inicialização =================
  renderPollOpts(); applyPrefs(); render(); renderBadge();
  if (!prefs.onboarded) openOnboarding(1);

  return {
    prefs: () => prefs, view: () => prefs.view, setView, toggleView, step, primary, notify, tick, notifs,
    destroy() { doc.removeEventListener("keydown", onKey); for (const h of toastTimers.values()) clearTimeout(h); },
  };
}
