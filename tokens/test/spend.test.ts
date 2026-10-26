import { describe, it, expect, vi } from "vitest";
import { ModelRouter, planCache, BudgetTracker, ResponseCache, EventBatcher, UsageLedger, MODEL_IDS } from "../src/index.js";

describe("ModelRouter", () => {
  const r = new ModelRouter({ taskTiers: { "stream-plan": "large" } });
  it("routes by complexity", () => {
    expect(r.route({ text: "oi" }).model).toBe("claude-haiku-5-5");
    expect(r.route({ text: "Analyze why retention dropped and plan a strategy", toolCount: 3 }).model).toBe("claude-opus-5-5");
    expect(r.route({ text: "x", task: "stream-plan" }).tier).toBe("large");
    expect(r.route({ text: "please explain this bug", toolCount: 1 }).tier).toBe("medium");
  });
  it("degrades with floor", () => {
    expect(r.route({ text: "x", task: "stream-plan", degradeSteps: 1 }).model).toBe(MODEL_IDS.medium);
    expect(r.route({ text: "oi", degradeSteps: 2 }).tier).toBe("small");
  });
});

describe("planCache", () => {
  const big = "r".repeat(5000);
  it("puts stable first and places breakpoints", () => {
    const p = planCache({
      tools: [{ name: "zeta", input_schema: {} }, { name: "alpha", description: big, input_schema: {} }],
      system: [
        { text: "now: 12:00", stability: "volatile" },
        { text: big, stability: "session" },
        { text: big, stability: "static" },
      ],
      messages: [
        { role: "user", content: big }, { role: "assistant", content: "ok" }, { role: "user", content: "new" },
      ],
    });
    expect(p.tools.map((t) => t.name)).toEqual(["alpha", "zeta"]);
    expect(p.system[2]!.text).toBe("now: 12:00");
    expect(p.system[2]!.cache_control).toBeUndefined();
    expect(p.system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[0]!.cache_control).toBeDefined();
    expect(p.breakpoints.length).toBeLessThanOrEqual(4);
    const m = p.messages[1]!.content as any[];
    expect(m[0].cache_control).toBeDefined();
    expect((p.messages[2]!.content as string)).toBe("new");
  });
  it("skips tiny prefixes and supports 1h ttl", () => {
    expect(planCache({ system: [{ text: "hi" }] }).breakpoints).toHaveLength(0);
    const p = planCache({ system: [{ text: big }], ttl: "1h" });
    expect(p.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("BudgetTracker", () => {
  it("walks warn/degrade/stop and hour window slides", () => {
    let now = 0;
    const changes: string[] = [];
    const b = new BudgetTracker({ perSession: 1000, perHour: 100000, clock: () => now, onStateChange: (s) => changes.push(s.state) });
    expect(b.record(100).state).toBe("ok");
    expect(b.record(650).state).toBe("warn");
    const d = b.record(150);
    expect(d.state).toBe("degrade");
    expect(d.degradeSteps).toBe(1);
    expect(b.canSpend(100)).toBe(false);
    expect(b.record(100).state).toBe("stop");
    expect(changes).toEqual(["warn", "degrade", "stop"]);
    now = 3_700_000;
    expect(b.status().hourUsed).toBe(0);
    expect(b.status().sessionUsed).toBe(1000);
  });
});

describe("ResponseCache", () => {
  it("matches normalized phrasing, expires, evicts LRU", async () => {
    let now = 0;
    const c = new ResponseCache<string>({ maxEntries: 2, ttlMs: 100, clock: () => now });
    c.set("What is the schedule?", "A");
    expect(c.get("schedule what is the, please")).toBe("A");
    now = 101;
    expect(c.get("what is the schedule")).toBeUndefined();
    c.set("a", "1"); c.set("b", "2"); c.get("a"); c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    const fn = vi.fn(async () => "v");
    await c.wrap("q", fn); await c.wrap("Q", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.stats().hits).toBeGreaterThan(0);
  });
});

describe("EventBatcher", () => {
  it("flushes on window and size", async () => {
    vi.useFakeTimers();
    const out: number[][] = [];
    const b = new EventBatcher<number>({ windowMs: 1000, maxItems: 3, onFlush: (x) => { out.push(x); } });
    b.add(1); b.add(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(out).toEqual([[1, 2]]);
    b.add(3); b.add(4); b.add(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(out[1]).toEqual([3, 4, 5]);
    expect(b.coalesced).toBe(3);
    vi.useRealTimers();
  });
});

describe("UsageLedger", () => {
  it("reports per tool/task and savings", () => {
    const l = new UsageLedger();
    l.record({ tool: "chat.read", task: "reply", model: MODEL_IDS.small, inputTokens: 1000, outputTokens: 100 });
    l.record({ tool: "chat.read", task: "reply", model: MODEL_IDS.medium, inputTokens: 500, cacheReadTokens: 10000 });
    l.compaction(5000, 1000, { tool: "chat.read" });
    l.routing({ tool: "chat.read", model: MODEL_IDS.small, inputTokens: 1000, outputTokens: 100 });
    const r = l.report();
    expect(r.byTool["chat.read"]!.calls).toBe(2);
    expect(r.byTask["reply"]!.totalTokens).toBe(1000 + 100 + 500 + 10000);
    expect(r.totals.tokensSaved).toBe(4000);
    expect(r.savingsBySource["prompt-cache"]!.usdSaved).toBeGreaterThan(0);
    expect(r.savingsBySource["routing"]!.usdSaved).toBeGreaterThan(0);
    expect(r.totals.usdSaved).toBeGreaterThan(0);
    expect(r.savingsRatio).toBeGreaterThan(0);
    expect(JSON.stringify(l)).toContain("byTool");
  });
});
