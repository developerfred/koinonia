export type View = "foco" | "painel";
export type Theme = "auto" | "light" | "dark";
export type Contrast = "normal" | "high";
export type Density = "calma" | "normal" | "compacta";
export type Platform = "twitch" | "youtube";
export type NotifGroup = "saude" | "live" | "chat" | "tokens" | "sistema";

export const NOTIF_GROUPS: NotifGroup[] = ["saude", "live", "chat", "tokens", "sistema"];
export const PLATFORMS: Platform[] = ["twitch", "youtube"];
export const FONT_MIN = 0.9, FONT_MAX = 1.5, FONT_STEP = 0.05;

export interface Prefs {
  view: View;
  theme: Theme;
  contrast: Contrast;
  density: Density;
  fontScale: number;
  reminders: boolean;
  reminderMin: number;
  silenced: Record<NotifGroup, boolean>;
  onboarded: boolean;
  platforms: Platform[];
  /** painéis recolhidos por visualização (chave = id do painel) */
  collapsed: Record<View, Record<string, boolean>>;
  tokenBudget: number;
  manual: Record<string, boolean>;
}

export const STORAGE_KEY = "koinonia.studio.prefs.v1";

export function defaultPrefs(): Prefs {
  return {
    view: "foco", theme: "auto", contrast: "normal", density: "normal", fontScale: 1,
    reminders: false, reminderMin: 45,
    silenced: { saude: false, live: false, chat: true, tokens: false, sistema: false },
    onboarded: false, platforms: ["twitch", "youtube"],
    collapsed: { foco: {}, painel: {} },
    tokenBudget: 200_000, manual: {},
  };
}

const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function clampFont(n: number): number {
  const stepped = Math.round(clamp(n, FONT_MIN, FONT_MAX) / FONT_STEP) * FONT_STEP;
  return clamp(Math.round(stepped * 100) / 100, FONT_MIN, FONT_MAX);
}

/** Valida dados desconhecidos (JSON do localStorage); qualquer campo ruim volta ao padrão. */
export function sanitize(raw: unknown): Prefs {
  const d = defaultPrefs();
  const r = rec(raw);
  const sil = rec(r.silenced);
  const silenced = { ...d.silenced };
  for (const g of NOTIF_GROUPS) silenced[g] = bool(sil[g], d.silenced[g]);
  const col = rec(r.collapsed);
  const flags = (o: unknown) => {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(rec(o))) if (typeof v === "boolean") out[k] = v;
    return out;
  };
  const plats = Array.isArray(r.platforms) ? PLATFORMS.filter((p) => (r.platforms as unknown[]).includes(p)) : d.platforms;
  return {
    view: oneOf(r.view, ["foco", "painel"], d.view),
    theme: oneOf(r.theme, ["auto", "light", "dark"], d.theme),
    contrast: oneOf(r.contrast, ["normal", "high"], d.contrast),
    density: oneOf(r.density, ["calma", "normal", "compacta"], d.density),
    fontScale: typeof r.fontScale === "number" && Number.isFinite(r.fontScale) ? clampFont(r.fontScale) : d.fontScale,
    reminders: bool(r.reminders, d.reminders),
    reminderMin: typeof r.reminderMin === "number" && Number.isFinite(r.reminderMin) ? clamp(Math.round(r.reminderMin), 5, 180) : d.reminderMin,
    silenced,
    onboarded: bool(r.onboarded, d.onboarded),
    platforms: plats,
    collapsed: { foco: flags(col.foco), painel: flags(col.painel) },
    tokenBudget: typeof r.tokenBudget === "number" && r.tokenBudget >= 0 ? Math.min(Math.round(r.tokenBudget), 1e9) : d.tokenBudget,
    manual: flags(r.manual),
  };
}

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function safeStorage(): StorageLike | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadPrefs(st: StorageLike | null = safeStorage()): Prefs {
  try {
    const s = st?.getItem(STORAGE_KEY);
    return sanitize(s ? JSON.parse(s) : null);
  } catch { return defaultPrefs(); }
}

/** @returns false quando não foi possível gravar (modo privado, cota, bloqueio). */
export function savePrefs(p: Prefs, st: StorageLike | null = safeStorage()): boolean {
  try { if (!st) return false; st.setItem(STORAGE_KEY, JSON.stringify(p)); return true; } catch { return false; }
}
