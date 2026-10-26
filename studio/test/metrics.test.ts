import { describe, expect, it } from "vitest";
import { MetricsStore } from "../src/metrics";

describe("MetricsStore", () => {
  it("aggregates within window", () => {
    let now = 100_000;
    const s = new MetricsStore(100, () => now);
    s.push("kbps", 1000, now - 90_000); s.push("kbps", 3000, now - 5000); s.push("kbps", 5000, now - 1000);
    expect(s.query("kbps", 10, "avg")).toEqual({ n: 2, v: 4000 });
    expect(s.query("kbps", 120, "min")).toEqual({ n: 3, v: 1000 });
    expect(s.query("nope", 10)).toEqual({ n: 0 });
  });
  it("alerts are edge triggered and drain once", () => {
    const s = new MetricsStore(100, () => 0);
    const id = s.addAlert("kbps", "lt", 2000);
    s.push("kbps", 3000); s.push("kbps", 1500); s.push("kbps", 1000);
    expect(s.drainFired()).toHaveLength(1);
    expect(s.drainFired()).toHaveLength(0);
    s.push("kbps", 3000); s.push("kbps", 1000);
    expect(s.drainFired()).toHaveLength(1);
    expect(s.removeAlert(id)).toBe(true);
  });
  it("caps series", () => {
    const s = new MetricsStore(3, () => 10);
    for (let i = 0; i < 10; i++) s.push("m", i, 10);
    expect(s.query("m", 10, "count").v).toBe(3);
  });
});
