import { describe, expect, it } from "vitest";
import { ApprovalError, InstagramReelsAdapter, NotImplementedError, Publisher, TikTokAdapter, YouTubeShortsAdapter, defaultAdapters, type PublishAdapter, type PublishAsset, type PublishMeta } from "../src/publish.js";
import { buildChapters, generateReport, parseJsonLoose, type LlmProvider } from "../src/report.js";
import { tokensCompactor } from "../src/tokens-adapter.js";
import { detectMoments } from "../src/detect.js";
import { session } from "./fixture.js";

const asset: PublishAsset = { fileRef: "f.mp4", publicUrl: "https://cdn.example/f.mp4", durationMs: 30_000, width: 1080, height: 1920, bytes: 5e6, mime: "video/mp4" };
const meta: PublishMeta = { title: "Clip", description: "d", hashtags: ["a"], visibility: "private" };

describe("publish adapters", () => {
  it("document requirements with provenance and are stubs", async () => {
    for (const a of defaultAdapters()) {
      expect(a.spec.flow.length).toBeGreaterThan(1);
      expect([...a.spec.auth, ...a.spec.limits].every((r) => r.confidence === "documented" || r.confidence === "assumed")).toBe(true);
      await expect(a.publish(asset, meta, { accessToken: "x" })).rejects.toBeInstanceOf(NotImplementedError);
    }
  });
  it("validates platform rules", () => {
    expect(new InstagramReelsAdapter().validate({ ...asset, publicUrl: undefined }, meta).some((i) => i.severity === "error")).toBe(true);
    expect(new InstagramReelsAdapter().validate({ ...asset, durationMs: 120_000 }, meta).some((i) => i.severity === "error")).toBe(true);
    expect(new TikTokAdapter().validate(asset, { ...meta, visibility: "public" }).some((i) => /private/.test(i.message))).toBe(true);
    expect(new YouTubeShortsAdapter().validate(asset, meta)).toEqual([]);
  });
});

describe("Publisher approval gate", () => {
  const fake: PublishAdapter = { ...new YouTubeShortsAdapter(), platform: "youtube_shorts", spec: new YouTubeShortsAdapter().spec, validate: () => [], publish: async () => ({ platform: "youtube_shorts", remoteId: "abc", status: "processing" }) };
  const mk = (t = { v: 0 }) => ({ t, p: new Publisher({ adapters: [fake], credentials: async () => ({ accessToken: "t" }), now: () => t.v, approvalTtlMs: 1000 }) });
  it("cannot publish before approval", async () => {
    const { p } = mk();
    const { request } = p.submit("youtube_shorts", asset, meta);
    await expect(p.publish(request.id)).rejects.toBeInstanceOf(ApprovalError);
  });
  it("publishes after approval, rejects stale fingerprint, edits after approval and expiry", async () => {
    const { p, t } = mk();
    const { request } = p.submit("youtube_shorts", asset, meta);
    expect(() => p.approve(request.id, "ana", "deadbeef")).toThrow(/changed/);
    p.approve(request.id, "ana", request.fingerprint);
    request.meta.title = "edited";
    await expect(p.publish(request.id)).rejects.toThrow(/after approval/);
    request.meta.title = "Clip";
    t.v = 5000;
    await expect(p.publish(request.id)).rejects.toThrow(/expired/);
    p.approve(request.id, "ana", request.fingerprint);
    expect((await p.publish(request.id)).status).toBe("published");
  });
  it("real stub adapter failure is recorded, not thrown", async () => {
    const p = new Publisher({ adapters: [new TikTokAdapter()], credentials: async () => ({ accessToken: "t" }) });
    const { request } = p.submit("tiktok", asset, meta);
    p.approve(request.id, "ana", request.fingerprint);
    const r = await p.publish(request.id);
    expect(r.status).toBe("failed");
  });
});

describe("post-live report", () => {
  const moments = detectMoments(session);
  const input = { title: "Setup night", startMs: 0, endMs: 600_000, transcript: session.transcript, chat: session.chat, events: session.events, moments, frameHints: [{ tMs: 121_000, faceScore: 0.9, sharpness: 0.8 }, { tMs: 122_000, isTransition: true }] };

  it("builds chapters at scene/raid boundaries with min length", () => {
    const ch = buildChapters(input);
    expect(ch[0]!.timestamp).toBe("00:00");
    expect(ch.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < ch.length - 1; i++) expect(ch[i]!.endMs - ch[i]!.startMs).toBeGreaterThanOrEqual(120_000);
  });
  it("works without an LLM (deterministic)", async () => {
    const r = await generateReport(input);
    expect(r.generation.usedLlm).toBe(false);
    expect(r.whatWorked.find((w) => w.kind === "raid")!.chatRateAfter).toBeGreaterThan(0);
    expect(r.whatWorked.some((w) => w.kind === "poll")).toBe(true);
    expect(r.thumbnails[0]!.tMs).toBe(121_000);
    expect(r.chapterText.split("\n")[0]).toMatch(/^00:00 /);
  });
  it("uses the injected LLM with compacted context and tolerates bad output", async () => {
    const prompts: string[] = [];
    const llm: LlmProvider = {
      complete: async (req) => {
        prompts.push(req.prompt);
        const n = (req.prompt.match(/\[\d+\] /g) ?? []).length;
        return { text: "```json\n" + JSON.stringify({ summary: "Resumo ok", titles: ["T1", "T2"], chapterTitles: Array.from({ length: n }, (_, i) => `Cap ${i}`) }) + "\n```" };
      },
    };
    const r = await generateReport(input, { llm, compactor: tokensCompactor() });
    expect(r.summary).toBe("Resumo ok");
    expect(r.titles).toEqual(["T1", "T2"]);
    expect(r.chapters[0]!.title).toBe("Cap 0");
    expect(r.generation.contextTokensAfter).toBeLessThan(r.generation.contextTokensBefore);
    expect(prompts[0]!.length).toBeLessThan(JSON.stringify(session.chat).length / 4);
    const bad = await generateReport(input, { llm: { complete: async () => ({ text: "nope" }) } });
    expect(bad.generation.usedLlm).toBe(false);
    expect(bad.generation.warnings[0]).toMatch(/unparsable/);
    const boom = await generateReport(input, { llm: { complete: async () => { throw new Error("rate limit"); } } });
    expect(boom.generation.warnings[0]).toMatch(/rate limit/);
  });
  it("parseJsonLoose", () => {
    expect(parseJsonLoose<{ a: number }>('xx {"a":1} yy')).toEqual({ a: 1 });
    expect(parseJsonLoose("{bad")).toBeNull();
  });
});
