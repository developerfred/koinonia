import { describe, expect, it } from "vitest";
import { MetricsStore } from "../src/metrics";
import {
  DeferredAction, NotifCenter, budgetState, checklist, checklistSummary, formatDuration, healthReport, intervalProgress,
  nextStep, otherView, reminderDue,
} from "../src/ui/viewstate";
import type { FlowCtx } from "../src/ui/viewstate";

const base: FlowCtx = { supported: true, cameraOn: false, micOn: false, platforms: [], live: false, manual: {} };

describe("view + next step", () => {
  it("toggles between the two views", () => {
    expect(otherView("foco")).toBe("painel");
    expect(otherView(otherView("foco"))).toBe("foco");
  });
  it("guides exactly one next step in order", () => {
    expect(nextStep({ ...base, supported: false })).toBe("unsupported");
    expect(nextStep(base)).toBe("camera");
    expect(nextStep({ ...base, cameraOn: true })).toBe("platforms");
    expect(nextStep({ ...base, cameraOn: true, platforms: ["twitch"] })).toBe("ready");
    expect(nextStep({ ...base, live: true })).toBe("live");
  });
});

describe("checklist", () => {
  it("blocks only on required items", () => {
    const ready = { ...base, cameraOn: true, platforms: ["youtube" as const] };
    const s = checklistSummary(checklist(ready));
    expect(s.canGoLive).toBe(true);
    expect(s.pending.map((i) => i.id)).toEqual(["mic", "title_set", "sound"]);
    expect(checklistSummary(checklist(base)).canGoLive).toBe(false);
  });
  it("manual items follow stored answers", () => {
    const s = checklistSummary(checklist({ ...base, manual: { title_set: true, sound: true } }));
    expect(s.pending.map((i) => i.id)).not.toContain("sound");
  });
});

describe("time + reminders", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(-5)).toBe("00:00");
  });
  it("progress is clamped", () => {
    expect(intervalProgress(50, 0, 100)).toBe(0.5);
    expect(intervalProgress(500, 0, 100)).toBe(1);
    expect(intervalProgress(5, 10, 100)).toBe(0);
    expect(intervalProgress(5, 0, 0)).toBe(0);
  });
  it("reminders are opt-in, live-only and fire once", () => {
    const o = { enabled: true, live: true, now: 100, since: 0, intervalMs: 100, shown: false };
    expect(reminderDue(o)).toBe(true);
    expect(reminderDue({ ...o, enabled: false })).toBe(false);
    expect(reminderDue({ ...o, live: false })).toBe(false);
    expect(reminderDue({ ...o, shown: true })).toBe(false);
    expect(reminderDue({ ...o, now: 99 })).toBe(false);
  });
});

describe("health + budget", () => {
  it("is idle when offline, good with healthy numbers, worse with bad ones", () => {
    const m = new MetricsStore(100);
    m.push("kbps", 3000); m.push("fps", 30); m.push("dropped", 0);
    expect(healthReport(m, false).level).toBe("idle");
    expect(healthReport(m, true).level).toBe("good");
    const w = new MetricsStore(100);
    w.push("kbps", 1000); w.push("fps", 30);
    expect(healthReport(w, true).level).toBe("warn");
    m.push("kbps", 100); m.push("kbps", 100); m.push("fps", 5); m.push("fps", 5); m.push("fps", 5);
    const r = healthReport(m, true);
    expect(r.level).toBe("bad");
    expect(r.reasons.some((x) => x.key === "health.reason.fps")).toBe(true);
  });
  it("budget levels", () => {
    expect(budgetState(10, 100).level).toBe("ok");
    expect(budgetState(80, 100).level).toBe("warn");
    expect(budgetState(100, 100).level).toBe("over");
    expect(budgetState(5, 0).level).toBe("ok");
  });
});

describe("NotifCenter", () => {
  it("groups, counts unread and honours silence (except critical)", () => {
    let t = 0;
    const n = new NotifCenter(10, () => ++t);
    n.setSilenced("chat", true);
    expect(n.add("chat", "info", "a").interrupt).toBe(false);
    expect(n.add("chat", "critical", "b").interrupt).toBe(true);
    expect(n.add("saude", "warn", "c").interrupt).toBe(true);
    const g = n.grouped();
    expect(g).toHaveLength(2);
    expect(g[0]!.group).toBe("saude");
    expect(g.find((x) => x.group === "chat")).toMatchObject({ count: 2, unread: 2, silenced: true });
    n.markAllRead();
    expect(n.unread()).toBe(0);
    n.clear();
    expect(n.list()).toHaveLength(0);
  });
  it("caps history", () => {
    const n = new NotifCenter(3);
    for (let i = 0; i < 10; i++) n.add("sistema", "info", String(i));
    expect(n.list().map((x) => x.text)).toEqual(["7", "8", "9"]);
  });
});

describe("DeferredAction (undo window)", () => {
  it("commits after the window", () => {
    let now = 0, ran = 0;
    const d = new DeferredAction(() => now);
    expect(d.start(() => ran++, 1000)).toBe(true);
    expect(d.start(() => ran++, 1000)).toBe(false);
    now = 999; expect(d.tick()).toBe(false); expect(d.remainingMs()).toBe(1);
    now = 1000; expect(d.tick()).toBe(true);
    expect(ran).toBe(1); expect(d.state).toBe("committed");
  });
  it("undo prevents the action", () => {
    let now = 0, ran = 0;
    const d = new DeferredAction(() => now);
    d.start(() => ran++, 1000);
    expect(d.undo()).toBe(true);
    now = 5000; d.tick();
    expect(ran).toBe(0); expect(d.state).toBe("undone");
    expect(d.undo()).toBe(false);
  });
});
