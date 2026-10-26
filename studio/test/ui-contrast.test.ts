import css from "../src/ui/styles.css?raw";
import { describe, expect, it } from "vitest";


/** extrai o corpo do bloco que começa exatamente em `selector {` */
function block(selector: string): Record<string, string> {
  const i = css.indexOf(selector + " {");
  if (i < 0) throw new Error("bloco ausente: " + selector);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

const themes: Record<string, Record<string, string>> = {
  light: block(":root"),
  dark: block(':root[data-theme="dark"]'),
  "light-high": block(':root[data-contrast="high"]'),
  "dark-high": block(':root[data-contrast="high"][data-theme="dark"]'),
};

// [primeiro plano, fundo, mínimo]: 4.5 texto, 3 componentes de interface
const pairs: [string, string, number][] = [
  ["text", "bg", 7], ["text", "surface", 7], ["text", "surface-2", 4.5], ["muted", "bg", 4.5], ["muted", "surface", 4.5], ["muted", "surface-2", 4.5],
  ["on-accent", "accent", 4.5], ["on-live", "live", 4.5], ["accent-text", "accent-soft", 4.5], ["accent-text", "surface", 4.5],
  ["good", "surface", 4.5], ["warn", "surface", 4.5], ["bad", "surface", 4.5], ["live", "surface", 4.5],
  ["focus", "bg", 3], ["focus", "surface", 3], ["border-strong", "bg", 3], ["border-strong", "surface", 3], ["accent", "surface", 3],
];

describe("tokens de contraste (WCAG AA+)", () => {
  for (const [name, tk] of Object.entries(themes)) {
    it(`${name} atende aos mínimos`, () => {
      for (const [fg, bg, min] of pairs) {
        const r = ratio(tk[fg]!, tk[bg]!);
        expect(r, `${name}: ${fg} sobre ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      }
    });
  }
  it("o modo escuro automático é idêntico ao explícito", () => {
    expect(block(':root:not([data-theme="light"])')).toEqual(themes.dark);
    expect(block(':root[data-contrast="high"]:not([data-theme="light"])')).toEqual(themes["dark-high"]);
  });
  it("respeita prefers-reduced-motion e não tem animações em laço", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).not.toMatch(/animation-iteration-count:\s*infinite|@keyframes/);
  });
});
