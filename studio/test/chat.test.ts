import { describe, expect, it } from "vitest";
import { ChatBuffer } from "../src/chat/ring";

const m = (user: string, text: string) => ({ ts: 1, platform: "twitch", user, text });

describe("ChatBuffer", () => {
  it("assigns increasing cursors and returns deltas", () => {
    const b = new ChatBuffer(10);
    b.push(m("a", "hi")); b.push(m("b", "yo"));
    const d = b.since(0);
    expect(d.c).toBe(2);
    expect(d.m).toEqual([{ u: "a", t: "hi" }, { u: "b", t: "yo" }]);
    expect(b.since(d.c).m).toEqual([]);
    expect(b.since(d.c).c).toBe(2);
    b.push(m("c", "new"));
    expect(b.since(2).m).toEqual([{ u: "c", t: "new" }]);
  });
  it("evicts oldest and reports lost", () => {
    const b = new ChatBuffer(3);
    for (let i = 1; i <= 5; i++) b.push(m("u", "m" + i));
    expect(b.oldest).toBe(3);
    const d = b.since(0);
    expect(d.lost).toBe(2);
    expect(d.m.map((x) => x.t)).toEqual(["m3", "m4", "m5"]);
    expect(b.get(2)).toBeUndefined();
    expect(b.get(4)?.text).toBe("m4");
  });
  it("limit sets more and cursor resumes", () => {
    const b = new ChatBuffer(10);
    for (let i = 1; i <= 5; i++) b.push(m("u", "m" + i));
    const d1 = b.since(0, { limit: 2 });
    expect(d1.more).toBe(true); expect(d1.c).toBe(2);
    const d2 = b.since(d1.c, { limit: 10 });
    expect(d2.more).toBeUndefined();
    expect(d2.m.length).toBe(3);
  });
  it("dedupes repeated text with count", () => {
    const b = new ChatBuffer(10);
    b.push(m("a", "KEKW")); b.push(m("b", "kekw ")); b.push(m("c", "other"));
    const d = b.since(0);
    expect(d.m).toEqual([{ u: "a", t: "KEKW", x: 2 }, { u: "c", t: "other" }]);
    expect(b.since(0, { dedupe: false }).m.length).toBe(3);
  });
  it("fields param selects compact keys; future cursor is safe", () => {
    const b = new ChatBuffer(5);
    b.push(m("a", "x"));
    expect(b.since(0, { fields: ["id", "text"] }).m).toEqual([{ i: 1, t: "x" }]);
    expect(b.since(99).c).toBe(99);
  });
});
