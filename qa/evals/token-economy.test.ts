// Token-economy evals: a DETERMINISTIC benchmark of how many tokens the toolkit saves on recorded fixtures.
// Everything is seeded/fixed (fixtures from qa/tools/gen-fixtures.mjs, token estimate = tokens/src/estimate.ts), so numbers are
// exactly reproducible. CI fails if any savings metric regresses more than TOLERANCE below baseline.json, or below the hard floor.
//   update baseline after an intentional improvement:  npm --prefix qa run evals:update   (then review the diff!)
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, P, QA } from "../lib/env";

const TOLERANCE = 0.02;      // absolute drop allowed in a ratio metric before CI fails
const BASELINE = join(QA, "evals", "baseline.json");
const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
const current: Record<string, number> = {};
// Hard floors: even a fresh baseline must beat these (guards against baselining a regression).
const FLOORS: Record<string, number> = {
  "chat.hype.saved": 0.3, "chat.qna.saved": 0.2, "chat.hype.studio_tool.saved": 0.5,
  "trim.health.minimal.saved": 0.5, "delta.health.cumulative.saved": 0.7,
  "router.cost.saved_vs_all_large": 0.4, "cache.qna.hit_rate": 0.1,
  "chat.hype.retention": 0.9, "chat.qna.retention": 0.9,
};
const record = (k: string, v: number) => { current[k] = Math.round(v * 10000) / 10000; };

const has = existsSync(`${P.tokens}/src/chat.ts`);
const est = (x: unknown) => Math.ceil((typeof x === "string" ? x : JSON.stringify(x)).length / 4);

describe.runIf(has)("token economy", async () => {
  const tk: any = await import("../../tokens/src/index");
  const estimate = (x: unknown) => tk.estimateTokens(x);
  const norm = (s: string) => tk.normalizeText(s);

  for (const name of ["hype", "qna", "quiet"]) {
    it(`chat compaction on '${name}'`, () => {
      const msgs = fixture<any[]>(`chat/${name}.json`);
      const raw = estimate(msgs.map((m) => ({ user: m.user, text: m.text })));
      // the agent sees windows of 30 messages per poll
      let before = 0, after = 0, kept = 0, wanted = 0;
      for (let i = 0; i < msgs.length; i += 30) {
        const win = msgs.slice(i, i + 30);
        const r = tk.compactChat(win, { limit: 10 });
        before += estimate(win.map((m: any) => ({ user: m.user, text: m.text }))); after += r.tokensAfter;
        // retention: the top-3 most repeated messages of the window must be represented by an entry of >= their count
        const freq = new Map<string, number>(); for (const m of win) freq.set(norm(m.text), (freq.get(norm(m.text)) ?? 0) + 1);
        for (const [, c] of [...freq].sort((a, b) => b[1] - a[1]).slice(0, 3)) if (c >= 3) { wanted++; if (r.entries.some((e: any) => e.count >= c)) kept++; }
      }
      expect(before).toBe(raw > 0 ? before : 0);
      record(`chat.${name}.saved`, 1 - after / before);
      if (wanted) record(`chat.${name}.retention`, kept / wanted);
    });
  }

  it("studio get_chat tool output (ring buffer, dedupe, short keys) vs raw dump", async () => {
    if (!existsSync(`${P.studio}/src/chat/ring.ts`)) return;
    const { ChatBuffer } = await import("../../studio/src/chat/ring");
    const msgs = fixture<any[]>("chat/hype.json");
    const buf = new ChatBuffer(1000);
    let cursor = 0, raw = 0, compact = 0;
    for (let i = 0; i < msgs.length; i += 30) {
      const win = msgs.slice(i, i + 30);
      for (const m of win) buf.push({ ts: m.ts, platform: m.platform, user: m.user, text: m.text });
      raw += est(win.map((m) => ({ id: m.id, ts: m.ts, platform: m.platform, user: m.user, text: m.text })));
      const d = buf.since(cursor, { limit: 30 }); cursor = d.c; compact += est(d);
    }
    record("chat.hype.studio_tool.saved", 1 - compact / raw);
  });

  it("trimOutput verbosity=minimal on tool results", () => {
    const health = fixture<any[]>("chat/health.json");
    const raw = estimate(health);
    const out = tk.trimOutput(health, { verbosity: "minimal", presets: { minimal: ["id", "kbps", "dropped"] } });
    record("trim.health.minimal.saved", 1 - estimate(out) / raw);
    expect(JSON.stringify(out)).toContain("kbps");
  });

  it("delta cursor vs full state over 40 polls (5% of sources change per poll)", () => {
    const base = fixture<any[]>("chat/health.json").slice(0, 100).map((h, i) => ({ ...h, id: `s${i}` }));
    const tracker = new tk.DeltaTracker({ idOf: (i: any) => i.id });
    let full = 0, delta = 0, cursor: string | undefined;
    let state = base;
    for (let poll = 0; poll < 40; poll++) {
      state = state.map((s, i) => ((i * 7 + poll * 13) % 20 === 0 ? { ...s, kbps: s.kbps + poll + 1 } : s));
      full += estimate(state);
      const r = tracker.respond(state, cursor); cursor = r.cursor; delta += estimate({ items: r.items, cursor: r.cursor, unchanged: r.unchanged });
    }
    record("delta.health.cumulative.saved", 1 - delta / full);
  });

  it("model router vs always-large (the no-router, quality-safe baseline) (priced with tokens/src/models.ts DEFAULT_PRICES)", () => {
    const reqs = fixture<any[]>("chat/router_requests.json");
    const router = new tk.ModelRouter();
    let routed = 0, baselineCost = 0; const tiers: Record<string, number> = { small: 0, medium: 0, large: 0 };
    const price = (model: string) => (tk.DEFAULT_PRICES[model]?.input ?? 3);
    for (const r of reqs) {
      const toks = estimate(r.text) + r.contextTokens;
      const d = router.route(r);
      tiers[d.tier]!++;
      routed += (toks * price(d.model)) / 1e6; baselineCost += (toks * price(tk.MODEL_IDS.large)) / 1e6;
    }
    record("router.cost.saved_vs_all_large", 1 - routed / baselineCost);
    expect(tiers.small! + tiers.medium! + tiers.large!).toBe(reqs.length);
  });

  it("semantic response cache hit-rate on repeated viewer questions", () => {
    const msgs = fixture<any[]>("chat/qna.json").filter((m) => m.text.includes("?"));
    const cache = new tk.ResponseCache({ clock: () => 0 });
    let hits = 0;
    for (const m of msgs) { if (cache.get(m.text) !== undefined) hits++; else cache.set(m.text, "answer"); }
    record("cache.qna.hit_rate", msgs.length ? hits / msgs.length : 0);
  });

  afterAll(() => {
    mkdirSync(join(QA, ".out"), { recursive: true });
    writeFileSync(join(QA, ".out", "evals.json"), JSON.stringify(current, null, 2));
    const rows = Object.entries(current).map(([k, v]) => `${k.padEnd(36)} ${(v * 100).toFixed(1).padStart(6)}%   baseline ${baseline[k] === undefined ? "  n/a" : (baseline[k]! * 100).toFixed(1) + "%"}`);
    console.log("\n[token-economy]\n" + rows.join("\n"));
    if (process.env.UPDATE_BASELINE) writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  });

  it("no regression vs baseline.json and hard floors respected", () => {
    expect(Object.keys(current).length, "benchmarks did not run").toBeGreaterThan(5);
    for (const [k, v] of Object.entries(current)) {
      if (FLOORS[k] !== undefined) expect(v, `${k} below hard floor`).toBeGreaterThanOrEqual(FLOORS[k]!);
      if (!process.env.UPDATE_BASELINE) {
        expect(baseline[k], `${k} has no baseline; run: npm --prefix qa run evals:update`).toBeDefined();
        expect(v, `${k} regressed vs baseline ${baseline[k]}`).toBeGreaterThanOrEqual(baseline[k]! - TOLERANCE);
      }
    }
  });
});
