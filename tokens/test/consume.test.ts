import { describe, it, expect } from "vitest";
import { compactChat, DeltaTracker, sliceAfterCursor, trimOutput, RollingSummary, extractiveSummarizer, estimateTokens } from "../src/index.js";

describe("compactChat", () => {
  it("dedupes spam, clusters topics and limits", () => {
    const msgs = [
      ...Array.from({ length: 10 }, (_, i) => ({ user: `u${i}`, text: "LOOOOL!!!" })),
      { user: "a", text: "what game is next?" },
      { user: "b", text: "game when?" },
      { user: "c", text: "game please next" },
      { user: "d", text: "hello streamer" },
    ];
    const r = compactChat(msgs, { limit: 3 });
    expect(r.entries.length).toBeLessThanOrEqual(3);
    expect(r.entries[0]!.count).toBeGreaterThanOrEqual(1);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
    const lol = compactChat(msgs.slice(0, 10), { cluster: false });
    expect(lol.entries).toHaveLength(1);
    expect(lol.entries[0]!.count).toBe(10);
  });
});

describe("DeltaTracker", () => {
  it("returns full then only changes", () => {
    const t = new DeltaTracker<{ id: string; v: number }>({ idOf: (i) => i.id, trackRemovals: true });
    const r1 = t.respond([{ id: "a", v: 1 }, { id: "b", v: 1 }]);
    expect(r1.items).toHaveLength(2);
    const r2 = t.respond([{ id: "a", v: 1 }, { id: "b", v: 2 }], r1.cursor);
    expect(r2.items).toEqual([{ id: "b", v: 2 }]);
    const r3 = t.respond([{ id: "b", v: 2 }], r2.cursor);
    expect(r3.items).toHaveLength(0);
    expect(r3.removed).toEqual(["a"]);
    const r4 = t.respond([{ id: "b", v: 2 }], r3.cursor);
    expect(r4.unchanged).toBe(true);
  });
  it("slices append-only feeds", () => {
    const a = sliceAfterCursor([1, 2, 3]);
    expect(sliceAfterCursor([1, 2, 3, 4], a.cursor).items).toEqual([4]);
  });
});

describe("trimOutput", () => {
  const data = [{ id: 1, user: { name: "x", email: "e" }, bio: "b".repeat(500), nothing: null }];
  it("fields with dotted paths", () => {
    expect(trimOutput(data, { fields: ["id", "user.name"] })).toEqual([{ id: 1, user: { name: "x" } }]);
  });
  it("verbosity presets and truncation", () => {
    const out = trimOutput(data, { verbosity: "minimal", presets: { minimal: ["id", "bio"] } }) as any[];
    expect(Object.keys(out[0])).toEqual(["id", "bio"]);
    expect(out[0].bio.length).toBe(80);
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(data));
  });
});

describe("RollingSummary", () => {
  it("folds old turns into the summary", async () => {
    const rs = new RollingSummary({ summarizer: extractiveSummarizer(), keepRecent: 2, maxTailTokens: 20 });
    for (let i = 0; i < 6; i++) await rs.add({ role: "user", content: `Turn ${i} says something long enough. More text here.` });
    const c = rs.context();
    expect(c.recent).toHaveLength(2);
    expect(c.summary).toContain("Turn 0");
  });
});
