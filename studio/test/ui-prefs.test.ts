import { describe, expect, it } from "vitest";
import { STORAGE_KEY, clampFont, defaultPrefs, loadPrefs, sanitize, savePrefs } from "../src/ui/prefs";
import type { StorageLike } from "../src/ui/prefs";

const mem = (init: Record<string, string> = {}): StorageLike & { m: Map<string, string> } => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};
const broken: StorageLike = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };

describe("prefs", () => {
  it("round-trips", () => {
    const st = mem();
    const p = { ...defaultPrefs(), view: "painel" as const, theme: "dark" as const, fontScale: 1.25, density: "compacta" as const };
    expect(savePrefs(p, st)).toBe(true);
    expect(loadPrefs(st)).toEqual(p);
  });
  it("never throws when storage is unavailable", () => {
    expect(loadPrefs(broken)).toEqual(defaultPrefs());
    expect(savePrefs(defaultPrefs(), broken)).toBe(false);
    expect(loadPrefs(null)).toEqual(defaultPrefs());
    expect(savePrefs(defaultPrefs(), null)).toBe(false);
  });
  it("recovers from corrupt data", () => {
    expect(loadPrefs(mem({ [STORAGE_KEY]: "{not json" }))).toEqual(defaultPrefs());
  });
  it("sanitizes every field", () => {
    const p = sanitize({ view: "x", theme: 3, contrast: "high", density: "calma", fontScale: 99, reminderMin: 1, platforms: ["twitch", "foo"],
      silenced: { chat: false, bogus: true }, collapsed: { foco: { a: true, b: "no" } }, tokenBudget: -4 });
    expect(p.view).toBe("foco"); expect(p.theme).toBe("auto"); expect(p.contrast).toBe("high"); expect(p.density).toBe("calma");
    expect(p.fontScale).toBe(1.5); expect(p.reminderMin).toBe(5); expect(p.platforms).toEqual(["twitch"]);
    expect(p.silenced.chat).toBe(false); expect(p.collapsed.foco).toEqual({ a: true }); expect(p.tokenBudget).toBe(200000);
  });
  it("clamps font scale to steps", () => {
    expect(clampFont(0.1)).toBe(0.9); expect(clampFont(1.02)).toBe(1); expect(clampFont(2)).toBe(1.5);
  });
});
