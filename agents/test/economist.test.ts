import { describe, expect, it } from "vitest";
import { TokenEconomist } from "../src/economist.ts";
import { DEFAULT_AGENTS, clipper, moderator, producer, tokenEconomist } from "../src/definitions.ts";
import { say } from "../src/providers/fake.ts";
import { setup, ManualClock } from "./helpers.ts";

describe("Token Economist", () => {
  it("compacts big tool output and drops binary blobs", () => {
    const e = new TokenEconomist({ toolResultMaxTokens: 100 });
    const out = e.compact("capture_frame", JSON.stringify({ mime: "image/jpeg", b64: "A".repeat(50_000) }));
    expect(out.length).toBeLessThan(300);
    expect(out).toContain("omitted");
    expect(e.report().totals.tokensSaved).toBeGreaterThan(10_000);
  });

  it("routes by default tier, degrades near budget, denies at budget", () => {
    const clock = new ManualClock();
    const e = new TokenEconomist({ clock, global: { perHour: 10_000 } });
    const req = { agentId: "a", defaultTier: "large" as const, text: "x", toolCount: 1, maxTokens: 100, overheadTokens: 50 };
    expect(e.checkpoint(req)).toMatchObject({ allow: true, model: "claude-opus-5-5" });
    e.record("a", "claude-opus-5-5", { inputTokens: 6000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const d = e.checkpoint(req); // 90% -> degrade
    expect(d.allow).toBe(true);
    expect(d.model).toBe("claude-sonnet-5-5");
    e.record("a", "claude-sonnet-5-5", { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(e.checkpoint(req).allow).toBe(false);
  });

  it("an agent over its own hourly budget gets no more model calls", async () => {
    const { orch, provider } = await setup([{ ...producer, budgetPerHour: 1800 /* just above one small run */ }], [[say("a")], [say("b")]]);
    expect((await orch.ask("producer", "one")).status).toBe("ok");
    const r = await orch.ask("producer", "two");
    expect(r.status).toBe("budget");
    expect(provider.requests.length).toBe(1);
  });

  it("throttles low-priority agents first when the global budget runs hot, via the native agent", async () => {
    const { orch, clock } = await setup(DEFAULT_AGENTS, [], {
      economist: new TokenEconomist({ global: { perHour: 1000 } }),
    });
    // build the economist with the orchestrator clock instead
    const econ = new TokenEconomist({ clock, global: { perHour: 1000 } });
    econ.record("x", "claude-haiku-5-5", { inputTokens: 950, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }); // 95%: degrade
    const t = econ.enforce(orch);
    expect(t.clipper!.level).toBeGreaterThanOrEqual(1);
    expect(orch.get("clipper").throttle.level).toBeGreaterThanOrEqual(1);
    expect(orch.get("economist").throttle.level).toBe(1); // highest priority only mildly slowed
    econ.record("x", "claude-haiku-5-5", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }); // stop
    econ.enforce(orch);
    expect(orch.get("clipper").throttle.level).toBe(3);
    // paused-by-throttle agent skips runs
    const r = await orch.trigger("clipper", "chat.spike", { sample: [] });
    expect(r.status).toBe("skipped");
    expect(moderator.priority).toBeLessThan(producer.priority);
    expect(tokenEconomist.native).toBeTypeOf("function");
  });
});
