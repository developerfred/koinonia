import type { Key } from "./i18n";
import type { MetricsStore } from "../metrics";
import type { NotifGroup, Platform, View } from "./prefs";

export const otherView = (v: View): View => (v === "foco" ? "painel" : "foco");

// ---------- próximo passo / checklist ----------
export type StepId = "unsupported" | "camera" | "platforms" | "ready" | "live";

export interface FlowCtx {
  supported: boolean;
  cameraOn: boolean;
  micOn: boolean;
  platforms: Platform[];
  live: boolean;
  manual: Record<string, boolean>;
}

export function nextStep(c: FlowCtx): StepId {
  if (c.live) return "live";
  if (!c.supported) return "unsupported";
  if (!c.cameraOn) return "camera";
  if (c.platforms.length === 0) return "platforms";
  return "ready";
}

export interface CheckItem { id: string; label: Key; ok: boolean; required: boolean; manual: boolean }

export function checklist(c: FlowCtx): CheckItem[] {
  return [
    { id: "support", label: "checklist.support", ok: c.supported, required: true, manual: false },
    { id: "camera", label: "checklist.camera", ok: c.cameraOn, required: true, manual: false },
    { id: "platforms", label: "checklist.platforms", ok: c.platforms.length > 0, required: true, manual: false },
    { id: "mic", label: "checklist.mic", ok: c.micOn, required: false, manual: false },
    { id: "title_set", label: "checklist.title_set", ok: !!c.manual.title_set, required: false, manual: true },
    { id: "sound", label: "checklist.sound", ok: !!c.manual.sound, required: false, manual: true },
  ];
}

export function checklistSummary(items: CheckItem[]) {
  const done = items.filter((i) => i.ok).length;
  const blocking = items.filter((i) => i.required && !i.ok);
  return { done, total: items.length, canGoLive: blocking.length === 0, pending: items.filter((i) => !i.required && !i.ok) };
}

// ---------- tempo e lembretes ----------
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

/** Fração 0..1 do intervalo já decorrido (para barra de progresso visual). */
export function intervalProgress(now: number, since: number, intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  return Math.min(1, Math.max(0, (now - since) / intervalMs));
}

/** Lembrete gentil: só quando ligado, ao vivo, e passou o intervalo desde o último aceno/adiamento. */
export function reminderDue(o: { enabled: boolean; live: boolean; now: number; since: number; intervalMs: number; shown: boolean }): boolean {
  return o.enabled && o.live && !o.shown && o.now - o.since >= o.intervalMs;
}

// ---------- saúde ----------
export type HealthLevel = "idle" | "good" | "warn" | "bad";
export interface HealthReport {
  level: HealthLevel;
  reasons: { key: Key; v: number; level: "warn" | "bad" }[];
  values: { kbps?: number; fps?: number; dropped?: number; errors?: number };
}

export const HEALTH_WINDOW_SEC = 10;

export function healthReport(m: MetricsStore, live: boolean): HealthReport {
  const q = (name: string, agg: "avg" | "max" | "count") => m.query(name, HEALTH_WINDOW_SEC, agg).v;
  const values = { kbps: q("kbps", "avg"), fps: q("fps", "avg"), dropped: q("dropped", "max"), errors: q("errors", "count") };
  if (!live) return { level: "idle", reasons: [], values };
  const reasons: HealthReport["reasons"] = [];
  const lt = (v: number | undefined, warn: number, bad: number, key: Key) => {
    if (v === undefined) return;
    if (v < bad) reasons.push({ key, v, level: "bad" }); else if (v < warn) reasons.push({ key, v, level: "warn" });
  };
  lt(values.kbps, 1500, 800, "health.reason.kbps");
  lt(values.fps, 24, 15, "health.reason.fps");
  if (values.dropped !== undefined) {
    if (values.dropped > 30) reasons.push({ key: "health.reason.dropped", v: values.dropped, level: "bad" });
    else if (values.dropped > 5) reasons.push({ key: "health.reason.dropped", v: values.dropped, level: "warn" });
  }
  if ((values.errors ?? 0) > 0) reasons.push({ key: "health.reason.errors", v: values.errors!, level: "bad" });
  const level: HealthLevel = reasons.some((r) => r.level === "bad") ? "bad" : reasons.length ? "warn" : "good";
  return { level, reasons, values };
}

// ---------- orçamento de tokens ----------
export type BudgetLevel = "ok" | "warn" | "over";
export function budgetState(spent: number, budget: number): { ratio: number; level: BudgetLevel } {
  if (budget <= 0) return { ratio: 0, level: "ok" };
  const ratio = spent / budget;
  return { ratio, level: ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok" };
}

// ---------- notificações agrupadas e silenciáveis ----------
export type NotifLevel = "info" | "warn" | "critical";
export interface Notif { id: number; group: NotifGroup; level: NotifLevel; text: string; ts: number; read: boolean }
export interface GroupSummary { group: NotifGroup; count: number; unread: number; latest: Notif; silenced: boolean }

export class NotifCenter {
  private items: Notif[] = [];
  private seq = 1;
  private silenced = new Set<NotifGroup>();
  constructor(private cap = 100, private now: () => number = () => Date.now()) {}

  setSilenced(group: NotifGroup, on: boolean) { if (on) this.silenced.add(group); else this.silenced.delete(group); }
  isSilenced(g: NotifGroup) { return this.silenced.has(g); }

  /** Registra sempre (caixa de entrada); `interrupt` diz se a UI pode exibir um aviso agora.
   *  Grupo silenciado nunca interrompe, exceto nível crítico. */
  add(group: NotifGroup, level: NotifLevel, text: string): { notif: Notif; interrupt: boolean } {
    const notif: Notif = { id: this.seq++, group, level, text, ts: this.now(), read: false };
    this.items.push(notif);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    return { notif, interrupt: level === "critical" || !this.silenced.has(group) };
  }
  list(): readonly Notif[] { return this.items; }
  unread(): number { return this.items.filter((n) => !n.read).length; }
  markAllRead() { for (const n of this.items) n.read = true; }
  clear() { this.items = []; }
  grouped(): GroupSummary[] {
    const m = new Map<NotifGroup, Notif[]>();
    for (const n of this.items) { const a = m.get(n.group) ?? []; a.push(n); m.set(n.group, a); }
    return [...m.entries()].map(([group, a]) => ({
      group, count: a.length, unread: a.filter((n) => !n.read).length, latest: a[a.length - 1]!, silenced: this.silenced.has(group),
    })).sort((x, y) => y.latest.ts - x.latest.ts || y.latest.id - x.latest.id);
  }
}

// ---------- ação com janela para desfazer ----------
export type DeferredState = "idle" | "pending" | "committed" | "undone";

/** Executa `run` só depois de `ms`, a menos que `undo()` venha antes. Relógio injetável; `tick(now)` avança. */
export class DeferredAction {
  state: DeferredState = "idle";
  private deadline = 0;
  private run: (() => void) | null = null;
  constructor(private now: () => number = () => Date.now()) {}

  start(run: () => void, ms: number) {
    if (this.state === "pending") return false;
    this.run = run; this.deadline = this.now() + ms; this.state = "pending"; return true;
  }
  remainingMs(): number { return this.state === "pending" ? Math.max(0, this.deadline - this.now()) : 0; }
  undo(): boolean {
    if (this.state !== "pending") return false;
    this.state = "undone"; this.run = null; return true;
  }
  /** Executa já (ex.: usuário fechou a aba? não; usado quando janela expira). */
  tick(): boolean {
    if (this.state !== "pending" || this.now() < this.deadline) return false;
    const r = this.run; this.run = null; this.state = "committed"; r?.(); return true;
  }
}
