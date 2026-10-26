import { t } from "./i18n";
import type { Key } from "./i18n";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const T = (k: Key, v?: Record<string, string | number>) => esc(t(k, v));

const panel = (id: string, title: Key, body: string, extra = "") =>
  `<details class="panel" data-panel="${id}" ${extra}><summary><span>${T(title)}</span><span class="sum-meta" id="sum-${id}"></span></summary><div class="panel-body">${body}</div></details>`;

/** Esqueleto estático. Todas as visualizações compartilham os mesmos nós (a prévia de vídeo nunca é recriada). */
export function shellHtml(): string {
  return `
<a class="skip" href="#main">${T("app.skip")}</a>
<header class="topbar">
  <div class="brand">
    <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/></svg>
    <span>${T("app.name")}</span>
  </div>
  <div class="topbar-tools">
    <span class="pill" id="live-pill" data-live="false"><span class="dot" aria-hidden="true"></span><span id="live-pill-text">${T("status.idle")}</span><span id="live-time" class="mono" hidden></span></span>
    <span class="pill" id="health-pill" data-level="idle"><span class="dot" aria-hidden="true"></span><span><span class="vh">${T("health.label")}: </span><span id="health-pill-text">${T("health.idle")}</span></span></span>
    <button type="button" class="btn btn-primary only-painel" id="primary-bar"></button>
    <div class="seg" role="group" aria-label="${T("view.label")}">
      <button type="button" class="btn" id="v-foco" aria-pressed="true" title="${T("view.hint.foco")}">${T("view.foco")}</button>
      <button type="button" class="btn" id="v-painel" aria-pressed="false" title="${T("view.hint.painel")}">${T("view.painel")}</button>
    </div>
    <button type="button" class="btn" id="btn-notif" aria-expanded="false" aria-controls="drawer"><span aria-hidden="true">&#128276;</span><span class="vh">${T("notif.title")}</span><span class="badge" id="notif-badge" hidden></span></button>
    <button type="button" class="btn" id="btn-settings" aria-haspopup="dialog"><span aria-hidden="true">&#9881;</span><span class="vh">${T("settings.open")}</span></button>
    <button type="button" class="btn" id="btn-help" aria-haspopup="dialog"><span aria-hidden="true">?</span><span class="vh">${T("help.open")}</span></button>
  </div>
</header>

<aside class="drawer" id="drawer" aria-label="${T("notif.title")}" hidden>
  <h2 class="label">${T("notif.title")}</h2>
  <div id="drawer-groups" class="list"></div>
  <div class="row">
    <button type="button" class="btn btn-sm" id="notif-read">${T("notif.markread")}</button>
    <button type="button" class="btn btn-sm" id="notif-clear">${T("notif.clear")}</button>
    <button type="button" class="btn btn-sm btn-ghost" id="notif-close">${T("common.close")}</button>
  </div>
</aside>

<main id="main" tabindex="-1">
  <h1 class="vh">${T("app.name")}</h1>
  <div class="top-grid">
    <div class="stage">
      <video id="preview" muted autoplay playsinline aria-label="${T("app.name")}"></video>
      <p class="stage-empty" id="stage-empty">${T("step.camera.body")}</p>
    </div>
    <section class="focus-card" aria-labelledby="step-title">
      <p class="eyebrow" id="step-eyebrow">${T("step.next")}</p>
      <h2 id="step-title"></h2>
      <p class="lead" id="step-body"></p>
      <p class="err" id="step-error" role="alert" hidden></p>
      <p class="err" id="health-hint" hidden></p>
      <button type="button" class="btn btn-primary btn-xl only-foco" id="primary-main"></button>
      <div class="banner" id="undo-live" hidden><div><strong>${T("live.started")}</strong><span class="muted">${T("live.undo.hint")}</span></div><div class="actions"><button type="button" class="btn btn-sm" id="undo-live-btn">${T("common.undo")}</button></div></div>
      <div class="banner" id="stop-banner" hidden><div><strong id="stop-text"></strong></div><div class="actions"><button type="button" class="btn btn-sm" id="stop-undo">${T("common.undo")}</button></div></div>
      <div class="banner" id="reminder" hidden><div><strong>${T("reminder.break.title")}</strong><span class="muted">${T("reminder.break.body")}</span></div><div class="actions"><button type="button" class="btn btn-sm" id="rem-ok">${T("reminder.ok")}</button><button type="button" class="btn btn-sm" id="rem-snooze">${T("reminder.snooze", { m: 10 })}</button><button type="button" class="btn btn-sm btn-ghost" id="rem-off">${T("reminder.off")}</button></div></div>
      <div class="timer" id="live-timer" hidden>
        <div class="row"><span class="muted">${T("live.elapsed")}</span><span class="big-time mono" id="timer-elapsed">00:00</span></div>
        <div id="break-wrap" hidden><progress id="break-progress" max="100" value="0" aria-label="${T("reminder.next", { t: "" })}"></progress><span class="muted" id="break-text"></span></div>
      </div>
    </section>
  </div>
  <div class="panels" id="panels">
    ${panel("checklist", "panel.checklist", `<div id="checklist" class="list"></div>`)}
    ${panel("scenes", "panel.scenes", `<div class="row" id="scene-btns" role="group" aria-label="${T("scenes.current")}"></div><div class="row"><button type="button" class="btn" id="share-screen">${T("scenes.share")}</button></div>`)}
    ${panel("mixer", "panel.mixer", `<div id="mixer" class="list"></div><p class="muted">${T("mixer.volume.soon")}</p><p class="err" id="mixer-err" hidden></p>`)}
    ${panel("chat", "panel.chat", `<div id="chat-log" class="chat-log" role="log" aria-live="off" tabindex="0" aria-label="${T("panel.chat")}"><p class="muted" id="chat-empty">${T("chat.empty")}</p></div>`)}
    ${panel("polls", "panel.polls", `<form id="poll-form" class="list" novalidate>
        <div class="field"><label for="poll-q">${T("polls.question")}</label><input type="text" id="poll-q" maxlength="100" autocomplete="off" /></div>
        <div id="poll-opts" class="list"></div>
        <div class="row"><button type="button" class="btn btn-sm" id="poll-add">${T("polls.add")}</button></div>
        <div class="field"><label for="poll-dur">${T("polls.duration")}</label><select id="poll-dur"><option value="30">30 s</option><option value="60" selected>1 min</option><option value="120">2 min</option><option value="300">5 min</option></select></div>
        <p class="err" id="poll-err" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary">${T("polls.create")}</button></form>`)}
    ${panel("clips", "panel.clips", `<div class="field"><label for="clip-label">${T("clips.label")}</label><input type="text" id="clip-label" maxlength="80" autocomplete="off" /></div>
        <div class="row"><button type="button" class="btn btn-primary" id="clip-mark">${T("clips.mark")}</button></div>
        <div class="field"><label for="clip-sec">${T("clips.back")}</label><select id="clip-sec"><option value="15">15 s</option><option value="30" selected>30 s</option><option value="60">60 s</option><option value="120">2 min</option></select></div>
        <div class="row"><button type="button" class="btn" id="clip-export">${T("clips.export")}</button></div>
        <ul class="list" id="clip-list"></ul>`)}
    ${panel("health", "panel.health", `<div class="metrics" id="health-metrics"></div><ul class="list" id="health-reasons"></ul>`)}
    ${panel("tokens", "panel.tokens", `<div class="meter" id="tok-meter" data-level="ok" role="img" aria-label=""><i style="width:0%"></i></div><p id="tok-text"></p><p class="muted" id="tok-level"></p>`)}
    ${panel("tech", "debug.status", `<p class="err" id="support-msg" hidden></p><pre class="mono" id="status" style="white-space:pre-wrap;margin:0;font-size:.85rem"></pre>`)}
  </div>
</main>

<div class="toasts" id="toasts" role="region" aria-label="${T("polite.region")}" aria-live="polite"></div>
<div class="vh" id="sr-live" role="status" aria-live="polite"></div>

<dialog id="dlg-confirm" aria-labelledby="cf-title"><form method="dialog" class="dlg" id="cf-form">
  <h2 id="cf-title"></h2><p id="cf-body"></p><p class="err" id="cf-warn" hidden></p>
  <div class="actions"><button type="button" class="btn" id="cf-cancel">${T("common.cancel")}</button><button type="button" class="btn btn-primary" id="cf-ok"></button></div>
</form></dialog>

<dialog id="dlg-settings" aria-labelledby="st-title"><div class="dlg">
  <h2 id="st-title">${T("settings.title")}</h2>
  <fieldset><legend>${T("settings.theme")}</legend>
    <label class="check"><input type="radio" name="theme" value="auto" />${T("settings.theme.auto")}</label>
    <label class="check"><input type="radio" name="theme" value="light" />${T("settings.theme.light")}</label>
    <label class="check"><input type="radio" name="theme" value="dark" />${T("settings.theme.dark")}</label></fieldset>
  <fieldset><legend>${T("settings.contrast")}</legend>
    <label class="check"><input type="radio" name="contrast" value="normal" />${T("settings.contrast.normal")}</label>
    <label class="check"><input type="radio" name="contrast" value="high" />${T("settings.contrast.high")}</label></fieldset>
  <fieldset><legend>${T("settings.density")}</legend>
    <label class="check"><input type="radio" name="density" value="calma" />${T("settings.density.calma")}</label>
    <label class="check"><input type="radio" name="density" value="normal" />${T("settings.density.normal")}</label>
    <label class="check"><input type="radio" name="density" value="compacta" />${T("settings.density.compacta")}</label></fieldset>
  <div class="field"><span class="label" id="font-label">${T("settings.font")}</span>
    <div class="stepper" role="group" aria-labelledby="font-label"><button type="button" class="btn" id="font-dec" aria-label="${T("settings.font.dec")}">A&minus;</button><output id="font-out" for="font-dec font-inc" aria-live="polite"></output><button type="button" class="btn" id="font-inc" aria-label="${T("settings.font.inc")}">A+</button></div></div>
  <fieldset><legend>${T("settings.reminders")}</legend>
    <label class="check"><input type="checkbox" id="set-rem" />${T("settings.reminders")}</label>
    <div class="field"><label for="set-rem-min">${T("settings.reminders.every")}</label><input type="number" id="set-rem-min" min="5" max="180" step="5" /></div></fieldset>
  <div class="field"><label for="set-budget">${T("settings.tokenbudget")}</label><input type="number" id="set-budget" min="0" step="10000" /></div>
  <p class="muted" id="set-note" role="status"></p>
  <div class="actions"><button type="button" class="btn btn-sm" id="set-replay">${T("settings.replay")}</button><button type="button" class="btn btn-sm" id="set-reset">${T("settings.reset")}</button><button type="button" class="btn btn-primary" id="set-close">${T("common.close")}</button></div>
</div></dialog>

<dialog id="dlg-help" aria-labelledby="hp-title"><div class="dlg">
  <h2 id="hp-title">${T("help.title")}</h2>
  <ul class="list">
    <li><span class="kbd">Alt</span> + <span class="kbd">V</span> &mdash; ${T("help.view")}</li>
    <li><span class="kbd">Alt</span> + <span class="kbd">G</span> &mdash; ${T("help.primary")}</li>
    <li><span class="kbd">Alt</span> + <span class="kbd">N</span> &mdash; ${T("help.notif")}</li>
    <li><span class="kbd">Alt</span> + <span class="kbd">,</span> &mdash; ${T("help.settings")}</li>
    <li><span class="kbd">?</span> &mdash; ${T("help.help")}</li>
  </ul>
  <p class="muted">${T("help.note")}</p>
  <div class="actions"><button type="button" class="btn btn-primary" id="hp-close">${T("common.close")}</button></div>
</div></dialog>

<dialog id="dlg-onb" aria-labelledby="onb-title"><div class="dlg">
  <div class="steps" id="onb-steps" aria-hidden="true"><i></i><i></i><i></i></div>
  <p class="muted" id="onb-step"></p>
  <h2 id="onb-title"></h2>
  <div id="onb-body" class="list"></div>
  <p class="err" id="onb-err" role="alert" hidden></p>
  <div class="actions"><button type="button" class="btn btn-ghost" id="onb-skip">${T("common.skip")}</button><button type="button" class="btn" id="onb-back">${T("common.back")}</button><button type="button" class="btn btn-primary" id="onb-next"></button></div>
</div></dialog>`;
}
