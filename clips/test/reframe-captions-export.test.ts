import { describe, expect, it } from "vitest";
import { cropAt, planReframe, type FrameDetections } from "../src/reframe.js";
import { DEFAULT_CAPTION_STYLE, drawOps, groupWords, rebaseWords, renderCaptionOps, type Canvas2DLike } from "../src/captions.js";
import { buildExportJob, runExport, validateExportJob } from "../src/export.js";
import { detectMoments } from "../src/detect.js";
import { session } from "./fixture.js";

const face = (cx: number, id?: string) => ({ kind: "face" as const, x: cx - 100, y: 200, w: 200, h: 240, confidence: 0.9, trackId: id });
const frames = (xs: number[], step = 100): FrameDetections[] => xs.map((x, i) => ({ tMs: i * step, boxes: [face(x)] }));

describe("planReframe", () => {
  const base = { srcWidth: 1920, srcHeight: 1080 };
  it("produces 9:16 windows that stay inside the frame and follow a face", () => {
    const xs = Array.from({ length: 100 }, (_, i) => (i < 50 ? 500 : 1400));
    const plan = planReframe(frames(xs), 0, 9900, base);
    expect(plan.keyframes[0]!.w).toBe(608);
    for (const k of plan.keyframes) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x + k.w).toBeLessThanOrEqual(1920);
    }
    expect(Math.abs(plan.keyframes[40]!.x + 304 - 500)).toBeLessThan(40);
    expect(Math.abs(plan.keyframes[99]!.x + 304 - 1400)).toBeLessThan(80);
  });
  it("limits pan speed and ignores jitter inside the deadzone", () => {
    const plan = planReframe(frames([500, 1500, 1500, 1500]), 0, 300, { ...base, smoothing: 1 });
    expect(plan.keyframes[1]!.x - plan.keyframes[0]!.x).toBeLessThanOrEqual(90);
    const still = planReframe(frames([960, 970, 950, 965, 955]), 0, 400, base);
    expect(new Set(still.keyframes.map((k) => k.x)).size).toBe(1);
  });
  it("holds, then eases to the fallback when detections disappear", () => {
    const f = [{ tMs: 0, boxes: [face(300)] }];
    const plan = planReframe(f, 0, 6000, { ...base, holdMs: 1000 });
    expect(plan.keyframes[5]!.x).toBeLessThan(plan.keyframes[0]!.x + 5);
    expect(plan.keyframes[plan.keyframes.length - 1]!.x).toBeGreaterThan(plan.keyframes[10]!.x);
  });
  it("handles portrait sources on the vertical axis and cropAt interpolates", () => {
    const plan = planReframe([{ tMs: 0, boxes: [{ kind: "face", x: 100, y: 1500, w: 200, h: 200, confidence: 1 }] }], 0, 3000, { srcWidth: 1080, srcHeight: 2400 });
    expect(plan.keyframes[0]!.w).toBe(1080);
    expect(plan.keyframes[0]!.h).toBe(1920);
    const mid = cropAt(plan, 50);
    expect(mid.y).toBeGreaterThanOrEqual(plan.keyframes[0]!.y);
  });
});

describe("captions", () => {
  const words = session.transcript.find((s) => s.words)!.words!;
  it("rebases and groups word timings", () => {
    const re = rebaseWords(words, 245_000, 260_000);
    expect(re[0]!.startMs).toBe(5000);
    const cues = groupWords(re, { maxCharsPerLine: 14 });
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(16);
    }
    expect(cues.flatMap((c) => c.lines.flat()).map((w) => w.text)).toEqual(words.map((w) => w.text));
  });
  it("renders active word highlight at the right time and nothing outside cues", () => {
    const cues = groupWords(words.map((w) => ({ ...w, startMs: w.startMs - 250_000, endMs: w.endMs - 250_000 })));
    expect(renderCaptionOps(cues, DEFAULT_CAPTION_STYLE, 99_999, { width: 1080, height: 1920 })).toEqual([]);
    const ops = renderCaptionOps(cues, DEFAULT_CAPTION_STYLE, 500, { width: 1080, height: 1920 });
    const active = ops.filter((o) => o.op === "text" && o.fill === DEFAULT_CAPTION_STYLE.activeFill);
    expect(active).toHaveLength(1);
    expect((active[0] as { text: string }).text).toBe("O");
    for (const o of ops) if (o.op === "text") expect(o.y).toBeLessThan(1920 * (1 - 0.22));
  });
  it("drawOps drives a canvas-like context", () => {
    const calls: string[] = [];
    const ctx = { save() {}, restore() {}, translate() {}, scale() {}, font: "", fillStyle: "", strokeStyle: "", lineWidth: 0, lineJoin: "", globalAlpha: 1, shadowColor: "", shadowBlur: 0, shadowOffsetY: 0, textBaseline: "", fillText: (t: string) => calls.push("f:" + t), strokeText: (t: string) => calls.push("s:" + t), fillRect() {}, beginPath() {}, fill() {}, measureText: (t: string) => ({ width: t.length * 10 }) } as Canvas2DLike;
    const cues = groupWords([{ text: "hi", startMs: 0, endMs: 600 }]);
    drawOps(ctx, renderCaptionOps(cues, DEFAULT_CAPTION_STYLE, 300, { width: 1080, height: 1920 }));
    expect(calls).toEqual(["s:HI", "f:HI"]);
  });
});

describe("export job", () => {
  const m = detectMoments(session)[0]!;
  const crop = planReframe(frames([960, 960]), m.startMs, m.endMs, { srcWidth: 1920, srcHeight: 1080, stepMs: 1000 });
  const job = buildExportJob({ id: "j1", sourceRef: "ring:1", destRef: "out/j1.mp4", moment: m, crop, captions: { cues: [], style: DEFAULT_CAPTION_STYLE }, title: "t", now: () => 1 });
  it("describes ordered steps and validates", () => {
    expect(job.steps).toEqual(["extract", "decode", "crop", "scale", "captions", "loudnorm", "encode", "mux"]);
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
    expect(validateExportJob(job).filter((i) => i.severity === "error")).toEqual([]);
  });
  it("rejects bad jobs and runs good ones through the executor", async () => {
    const bad = { ...job, output: { ...job.output, width: 1920, height: 1080 } };
    expect(validateExportJob(bad).some((i) => i.severity === "error")).toBe(true);
    const exec = { run: async (j: typeof job, p?: (x: { step: "mux"; fraction: number }) => void) => (p?.({ step: "mux", fraction: 1 }), { destRef: j.output.destRef, bytes: 10, durationMs: 1 }) };
    const seen: number[] = [];
    await expect(runExport(exec as never, bad)).rejects.toThrow(/invalid/);
    expect((await runExport(exec as never, job, (p) => seen.push(p.fraction))).destRef).toBe("out/j1.mp4");
    expect(seen).toEqual([1]);
  });
});
