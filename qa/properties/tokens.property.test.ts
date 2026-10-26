// Property-based tests (fast-check, fixed seeds => reproducible) for the token-saving toolkit and the studio chat ring.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { existsSync } from "node:fs";
import { P } from "../lib/env";
import { gap } from "../lib/gap";

const has = (f: string) => existsSync(`${P.tokens}/src/${f}`);
const runs = Number(process.env.QA_PROP_RUNS ?? 300);
const opt = (seed: number) => ({ numRuns: runs, seed });

const word = fc.constantFrom("hello", "pog", "kekw", "audio", "lag", "setup", "clip", "gg", "mic", "link", "discord", "oi", "boa", "noite", "que", "jogada");
const msg = fc.record({
  user: fc.constantFrom("a", "b", "c", "d", "e", "f"),
  text: fc.array(word, { minLength: 1, maxLength: 8 }).map((w) => w.join(" ")),
});
const msgs = fc.array(msg, { maxLength: 80 });

describe.runIf(has("chat.ts"))("compactChat", async () => {
  const { compactChat } = await import("../../tokens/src/chat");

  it("never exceeds limit; counts never exceed input; dropped = total - represented", () => {
    fc.assert(fc.property(msgs, fc.integer({ min: 1, max: 30 }), (m, limit) => {
      const r = compactChat(m, { limit });
      expect(r.entries.length).toBeLessThanOrEqual(limit);
      const rep = r.entries.reduce((n, e) => n + e.count, 0);
      expect(rep).toBeLessThanOrEqual(m.length);
      expect(r.droppedMessages).toBe(m.length - rep);
      expect(r.totalMessages).toBe(m.length);
      for (const e of r.entries) { expect(e.count).toBeGreaterThanOrEqual(1); expect(e.text.length).toBeLessThanOrEqual(140); }
    }), opt(1));
  });

  it("is deterministic and does not mutate its input", () => {
    fc.assert(fc.property(msgs, (m) => {
      const copy = JSON.parse(JSON.stringify(m));
      const a = compactChat(m), b = compactChat(m);
      expect(a).toEqual(b);
      expect(m).toEqual(copy);
    }), opt(2));
  });

  it("with dedupe+cluster off and a large limit nothing is dropped", () => {
    fc.assert(fc.property(msgs, (m) => {
      const r = compactChat(m, { dedupe: false, cluster: false, limit: 1000 });
      expect(r.entries.length).toBe(m.length);
      expect(r.droppedMessages).toBe(0);
    }), opt(3));
  });

  it("clusters always represent at least minClusterSize original messages", () => {
    fc.assert(fc.property(msgs, fc.integer({ min: 2, max: 6 }), (m, minClusterSize) => {
      for (const e of compactChat(m, { minClusterSize, limit: 1000 }).entries) if (e.kind === "cluster") expect(e.count).toBeGreaterThanOrEqual(minClusterSize);
    }), opt(4));
  });

  it("every emitted message text/user comes from the input", () => {
    fc.assert(fc.property(msgs, (m) => {
      const texts = new Set(m.map((x) => x.text)), users = new Set(m.map((x) => x.user));
      for (const e of compactChat(m, { limit: 1000 }).entries) { expect(texts.has(e.text)).toBe(true); expect(users.has(e.user)).toBe(true); }
    }), opt(5));
  });
});

describe.runIf(has("trim.ts"))("trimOutput", async () => {
  const { trimOutput } = await import("../../tokens/src/trim");
  const key = fc.stringMatching(/^[a-z]{1,3}$/);
  const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    v: fc.oneof({ depthSize: "small" }, fc.string({ maxLength: 600 }), fc.integer(), fc.boolean(), fc.constant(null), tie("arr"), tie("obj")),
    arr: fc.array(tie("v"), { maxLength: 4 }),
    obj: fc.dictionary(key, tie("v"), { maxKeys: 4 }),
  })).v;
  const verb = fc.constantFrom("minimal", "normal", "full") as fc.Arbitrary<"minimal" | "normal" | "full">;

  it("is idempotent", () => {
    fc.assert(fc.property(json, verb, fc.boolean(), (x, verbosity, dropEmpty) => {
      const once = trimOutput(x, { verbosity, dropEmpty });
      expect(trimOutput(once, { verbosity, dropEmpty })).toEqual(once);
    }), opt(6));
  });

  it("with fields: output keys are a subset of the requested heads, values equal the input's", () => {
    fc.assert(fc.property(fc.dictionary(key, fc.oneof(fc.integer(), fc.constant(true), fc.string({ maxLength: 20 })), { minKeys: 1, maxKeys: 6 }), fc.array(key, { minLength: 1, maxLength: 3 }), (x, fields) => {
      const out = trimOutput(x, { fields, verbosity: "full", dropEmpty: false }) as Record<string, unknown>;
      for (const k of Object.keys(out)) { expect(fields).toContain(k); expect(out[k]).toEqual((x as any)[k]); }
    }), opt(7));
  });

  it("never grows the serialized size when only dropping/truncating (full verbosity, no fields)", () => {
    fc.assert(fc.property(json, (x) => {
      const out = trimOutput(x, { verbosity: "full" });
      expect(JSON.stringify(out ?? null).length).toBeLessThanOrEqual(JSON.stringify(x ?? null).length);
    }), opt(8));
  });

  it("truncated strings never exceed maxString", () => {
    fc.assert(fc.property(fc.string({ maxLength: 1000 }), fc.integer({ min: 2, max: 200 }), (s, maxString) => {
      expect((trimOutput(s, { maxString }) as string).length).toBeLessThanOrEqual(maxString);
    }), opt(9));
  });
});

describe.runIf(has("delta.ts"))("delta cursors", async () => {
  const { DeltaTracker, sliceAfterCursor } = await import("../../tokens/src/delta");
  type It = { id: string; v: number };
  const state = fc.array(fc.record({ id: fc.constantFrom("a", "b", "c", "d", "e", "f", "g"), v: fc.integer({ min: 0, max: 3 }) }), { maxLength: 7 })
    .map((a) => [...new Map(a.map((x) => [x.id, x])).values()]);

  it("a client applying deltas always converges to the server state (with removals)", () => {
    fc.assert(fc.property(fc.array(state, { minLength: 1, maxLength: 12 }), (states) => {
      const t = new DeltaTracker<It>({ idOf: (i) => i.id, trackRemovals: true });
      const client = new Map<string, It>();
      let cursor: string | undefined;
      for (const s of states) {
        const r = t.respond(s, cursor);
        for (const id of r.removed ?? []) client.delete(id);
        if (!cursor) client.clear();
        for (const it of r.items) client.set(it.id, it);
        cursor = r.cursor;
        expect([...client.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...s].sort((a, b) => a.id.localeCompare(b.id)));
      }
    }), opt(10));
  });

  it("unchanged state => empty delta and unchanged=true", () => {
    fc.assert(fc.property(state, (s) => {
      const t = new DeltaTracker<It>({ idOf: (i) => i.id });
      const r1 = t.respond(s);
      const r2 = t.respond(s, r1.cursor);
      expect(r2.items).toEqual([]); expect(r2.unchanged).toBe(true);
    }), opt(11));
  });

  it("an unknown cursor falls back to full state", () => {
    fc.assert(fc.property(state, fc.string(), (s, c) => {
      const t = new DeltaTracker<It>({ idOf: (i) => i.id });
      expect(t.respond(s, "zz" + c).items).toEqual(s);
    }), opt(12));
  });

  it("sliceAfterCursor over a growing feed yields every item exactly once, in order", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 20 }), (growth) => {
      const feed: number[] = []; const got: number[] = []; let cursor: string | undefined; let n = 0;
      for (const g of growth) { for (let i = 0; i < g; i++) feed.push(n++); const r = sliceAfterCursor(feed, cursor); got.push(...r.items); cursor = r.cursor; }
      expect(got).toEqual(feed);
    }), opt(13));
  });
});

describe.runIf(has("router.ts") && has("models.ts"))("ModelRouter", async () => {
  const { ModelRouter } = await import("../../tokens/src/router");
  const rank = { small: 0, medium: 1, large: 2 } as const;
  const req = fc.record({ text: fc.string({ maxLength: 3000 }), toolCount: fc.integer({ min: 0, max: 6 }), contextTokens: fc.integer({ min: 0, max: 50000 }) });

  it("is deterministic; more degradation never raises the tier (floor=small)", () => {
    fc.assert(fc.property(req, (r) => {
      const router = new ModelRouter({ floor: "small" });
      expect(router.route(r)).toEqual(router.route(r));
      let prev = rank[router.route(r).tier];
      for (let d = 1; d <= 3; d++) {
        const t = rank[router.route({ ...r, degradeSteps: d }).tier];
        expect(t).toBeLessThanOrEqual(prev);
        prev = t;
      }
    }), opt(14));
  });

  gap("tokens.router.floor-raises")("degrading never RAISES the tier even when floor is above the natural tier", () => {
    fc.assert(fc.property(req, (r) => {
      const router = new ModelRouter({ floor: "medium" });
      const base = rank[router.route(r).tier];
      for (let d = 1; d <= 3; d++) expect(rank[router.route({ ...r, degradeSteps: d }).tier]).toBeLessThanOrEqual(Math.max(base, rank.medium));
      // a degraded route must not be MORE expensive than the undegraded one
      for (let d = 1; d <= 3; d++) expect(rank[router.route({ ...r, degradeSteps: d }).tier]).toBeLessThanOrEqual(base);
    }), opt(14));
  });

  it("an explicit hint is honoured when not degrading, and the model id belongs to the tier", () => {
    fc.assert(fc.property(req, fc.constantFrom("small", "medium", "large") as fc.Arbitrary<"small" | "medium" | "large">, (r, hint) => {
      const router = new ModelRouter();
      const d = router.route({ ...r, hint });
      expect(d.tier).toBe(hint); expect(d.model).toBe(router.modelFor(hint));
    }), opt(15));
  });
});

describe.runIf(has("budget.ts"))("BudgetTracker", async () => {
  const { BudgetTracker } = await import("../../tokens/src/budget");
  const order = ["ok", "warn", "degrade", "stop"];
  it("state never improves as usage grows (fixed clock); degradeSteps monotone", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 40 }), (spend) => {
      const b = new BudgetTracker({ perSession: 1000, perHour: 5000, clock: () => 1 });
      let prev = 0, prevSteps = 0;
      for (const n of spend) {
        const s = b.record(n);
        expect(order.indexOf(s.state)).toBeGreaterThanOrEqual(prev); expect(s.degradeSteps).toBeGreaterThanOrEqual(prevSteps);
        prev = order.indexOf(s.state); prevSteps = s.degradeSteps;
      }
    }), opt(16));
  });
});

describe.runIf(has("summary.ts"))("RollingSummary", async () => {
  const { RollingSummary, extractiveSummarizer } = await import("../../tokens/src/summary");
  const turn = fc.record({ role: fc.constantFrom("user", "assistant", "tool") as fc.Arbitrary<"user" | "assistant" | "tool">, content: fc.string({ maxLength: 400 }) });
  it("keeps the last keepRecent turns verbatim, in order; no summary => nothing lost", async () => {
    await fc.assert(fc.asyncProperty(fc.array(turn, { maxLength: 40 }), fc.integer({ min: 1, max: 8 }), async (turns, keepRecent) => {
      const rs = new RollingSummary({ summarizer: extractiveSummarizer(500), keepRecent, maxTailTokens: 200 });
      for (const t of turns) await rs.add(t);
      const { summary, recent } = rs.context();
      expect(recent.slice(-Math.min(keepRecent, turns.length))).toEqual(turns.slice(-Math.min(keepRecent, turns.length)));
      if (summary === "") expect(recent).toEqual(turns);
      expect(summary.length).toBeLessThanOrEqual(500);
    }), opt(17));
  });
});

describe.runIf(existsSync(`${P.studio}/src/chat/ring.ts`))("studio ChatBuffer", async () => {
  const { ChatBuffer } = await import("../../studio/src/chat/ring");
  const ops = fc.array(fc.oneof(fc.record({ op: fc.constant("push" as const), n: fc.integer({ min: 1, max: 8 }) }), fc.record({ op: fc.constant("poll" as const), limit: fc.integer({ min: 1, max: 6 }) })), { maxLength: 40 });

  it("polling with the returned cursor never duplicates; delivered + lost == pushed (dedupe off)", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), ops, (cap, seq) => {
      const buf = new ChatBuffer(cap);
      let pushed = 0, cursor = 0, delivered = 0, lost = 0; const ids: number[] = [];
      const poll = (limit: number) => {
        const r = buf.since(cursor, { limit, fields: ["id"], dedupe: false });
        expect(r.c).toBeGreaterThanOrEqual(cursor);
        for (const m of r.m) ids.push(m.i as number);
        delivered += r.m.length; lost += r.lost ?? 0; cursor = r.c;
      };
      for (const o of seq) { if (o.op === "push") for (let i = 0; i < o.n; i++) { buf.push({ ts: 0, platform: "twitch", user: "u", text: "t" + pushed }); pushed++; } else poll(o.limit); }
      for (let i = 0; i < 100 && cursor < buf.cursor; i++) poll(6);
      expect(delivered + lost).toBe(pushed);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    }), opt(18));
  });
});
