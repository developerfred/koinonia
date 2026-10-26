import { describe, expect, it } from "vitest";
import { detectMoments, robustZ } from "../src/detect.js";
import { session } from "./fixture.js";

const near = (ms: number, target: number, tol = 12_000) => Math.abs(ms - target) <= tol;

describe("detectMoments on recorded session", () => {
  const moments = detectMoments(session);

  it("finds the loud + hype moment first, with multiple explained signals", () => {
    const top = moments[0]!;
    expect(near(top.peakMs, 122_500)).toBe(true);
    expect(Object.keys(top.signals).length).toBeGreaterThanOrEqual(3);
    expect(top.reasons.map((r) => r.signal)).toEqual(expect.arrayContaining(["audio", "chatRate", "transcript"]));
    expect(top.summary).toMatch(/dB/);
  });

  it("catches the quiet talk-only moment via transcript cues", () => {
    const quiet = moments.find((m) => near(m.peakMs, 252_500));
    expect(quiet).toBeDefined();
    expect(quiet!.signals.audio).toBeUndefined();
    expect(quiet!.reasons[0]!.signal).toBe("transcript");
    expect(quiet!.reasons[0]!.text).toMatch(/disbelief|reveal/);
  });

  it("catches the raid", () => {
    expect(moments.some((m) => m.reasons.some((r) => r.signal === "event" && /raid/.test(r.text)))).toBe(true);
  });

  it("does not flag ordinary talk", () => {
    expect(moments.some((m) => near(m.peakMs, 60_000, 20_000))).toBe(false);
  });

  it("respects thresholds and limits", () => {
    expect(detectMoments(session, { minScore: 0.95 }).length).toBeLessThan(moments.length);
    expect(detectMoments(session, { maxMoments: 1 })).toHaveLength(1);
    const noTranscript = detectMoments({ ...session, transcript: [] });
    expect(noTranscript.some((m) => near(m.peakMs, 252_500))).toBe(false);
  });

  it("keeps durations within bounds and inside the session", () => {
    for (const m of moments) {
      expect(m.endMs - m.startMs).toBeLessThanOrEqual(60_000);
      expect(m.endMs - m.startMs).toBeGreaterThanOrEqual(15_000);
      expect(m.startMs).toBeGreaterThanOrEqual(0);
      expect(m.endMs).toBeLessThanOrEqual(session.endMs);
    }
  });

  it("works with a single signal source", () => {
    const onlyAudio = detectMoments({ startMs: 0, endMs: 600_000, audio: session.audio });
    expect(near(onlyAudio[0]!.peakMs, 122_500)).toBe(true);
    expect(detectMoments({ startMs: 0, endMs: 1000 })).toEqual([]);
  });
});

describe("robustZ", () => {
  it("uses trailing history", () => {
    const s = [1, 1, 1, 1, 1, 1, 10];
    expect(robustZ(s, 6, 6, 1).z).toBeGreaterThan(8);
  });
});
