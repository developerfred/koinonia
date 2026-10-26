import type { ChatEvent, Moment, Ms, StreamEvent, TranscriptSegment } from "./types.js";

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Hint for model routing (tokens/router): titles and chapters are small-model work. */
  tier: "small" | "large";
}
export interface LlmProvider {
  complete(req: LlmRequest): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

/** Context compaction, injected. Use tokensCompactor() (tokens-adapter.ts) to plug @koinonia/tokens. */
export interface Compactor {
  chat(messages: ChatEvent[], limit: number): { text: string; tokensBefore: number; tokensAfter: number };
  estimate(text: string): number;
}

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

export const basicCompactor: Compactor = {
  estimate: (t) => Math.ceil(t.length / 4),
  chat(messages, limit) {
    const counts = new Map<string, number>();
    for (const m of messages) {
      const k = m.text.trim().toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t, c]) => (c > 1 ? `${t} x${c}` : t));
    const before = messages.reduce((a, m) => a + Math.ceil((m.user.length + m.text.length) / 4), 0);
    const text = lines.join("\n");
    return { text, tokensBefore: before, tokensAfter: Math.ceil(text.length / 4) };
  },
};

export interface FrameHint {
  tMs: Ms;
  /** 0..1 */
  faceScore?: number;
  sharpness?: number;
  /** 1 when the frame is a transition/black/loading screen. */
  isTransition?: boolean;
}

export interface ReportInput {
  title?: string;
  startMs: Ms;
  endMs: Ms;
  transcript: TranscriptSegment[];
  chat: ChatEvent[];
  events: StreamEvent[];
  moments: Moment[];
  frameHints?: FrameHint[];
}

export interface Chapter {
  startMs: Ms;
  endMs: Ms;
  title: string;
  /** "mm:ss" */
  timestamp: string;
}

export interface WorkedItem {
  kind: "peak" | "raid" | "poll" | "other";
  atMs: Ms;
  text: string;
  /** chat msgs/min after vs before, when applicable */
  chatRateBefore?: number;
  chatRateAfter?: number;
}

export interface ThumbnailCandidate {
  tMs: Ms;
  score: number;
  why: string;
}

export interface LiveReport {
  summary: string;
  chapters: Chapter[];
  /** YouTube-description-ready chapter list. */
  chapterText: string;
  titles: string[];
  thumbnails: ThumbnailCandidate[];
  whatWorked: WorkedItem[];
  stats: { durationMs: Ms; chatMessages: number; uniqueChatters: number; moments: number };
  generation: { usedLlm: boolean; llmCalls: number; contextTokensBefore: number; contextTokensAfter: number; warnings: string[] };
}

export interface ReportOptions {
  minChapterMs: Ms;
  maxChapters: number;
  transcriptGapMs: Ms;
  maxTitles: number;
  maxThumbnails: number;
  /** Window for before/after raid and poll comparison. */
  compareWindowMs: Ms;
  chatLimit: number;
  /** Max transcript chars per chapter sent to the LLM. */
  excerptChars: number;
}
export const DEFAULT_REPORT: ReportOptions = { minChapterMs: 120_000, maxChapters: 12, transcriptGapMs: 8000, maxTitles: 5, maxThumbnails: 4, compareWindowMs: 120_000, chatLimit: 25, excerptChars: 400 };

export const fmt = (ms: Ms): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const STOP = new Set("a o e de do da que um uma para com no na em os as the and to of in is it that this you i we so but for on are was com mas por mais como isso esse essa ele ela eu voce vamos entao ai ne tipo".split(" "));

export function topTerms(text: string, n: number): string[] {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) if (w.length > 3 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}

export function buildChapters(input: ReportInput, o: ReportOptions = DEFAULT_REPORT): Chapter[] {
  const cuts = new Set<number>();
  for (const e of input.events) if (["scene", "raid", "poll_start"].includes(e.type)) cuts.add(e.tMs);
  const segs = [...input.transcript].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < segs.length; i++) if (segs[i]!.startMs - segs[i - 1]!.endMs >= o.transcriptGapMs) cuts.add(segs[i]!.startMs);
  let bounds = [input.startMs, ...[...cuts].filter((t) => t > input.startMs && t < input.endMs).sort((a, b) => a - b)];
  // enforce minimum length by dropping cuts that come too soon after the previous kept one or too close to the end
  const kept = [bounds[0]!];
  for (const t of bounds.slice(1)) if (t - kept[kept.length - 1]! >= o.minChapterMs && input.endMs - t >= o.minChapterMs / 2) kept.push(t);
  bounds = kept;
  while (bounds.length > o.maxChapters) {
    // drop the boundary that creates the shortest chapter
    let bi = 1;
    let best = Infinity;
    for (let i = 1; i < bounds.length; i++) {
      const len = (bounds[i + 1] ?? input.endMs) - bounds[i - 1]!;
      if (len < best) {
        best = len;
        bi = i;
      }
    }
    bounds.splice(bi, 1);
  }
  return bounds.map((s, i) => {
    const e = bounds[i + 1] ?? input.endMs;
    const text = segs.filter((g) => g.startMs >= s && g.startMs < e).map((g) => g.text).join(" ");
    const terms = topTerms(text, 3);
    return { startMs: s, endMs: e, title: terms.length ? terms.map((t) => t[0]!.toUpperCase() + t.slice(1)).join(" / ") : `Part ${i + 1}`, timestamp: fmt(s - input.startMs) };
  });
}

const rate = (chat: ChatEvent[], a: Ms, b: Ms) => (chat.filter((m) => m.tMs >= a && m.tMs < b).length / Math.max(1, b - a)) * 60_000;

export function whatWorked(input: ReportInput, o: ReportOptions = DEFAULT_REPORT): WorkedItem[] {
  const out: WorkedItem[] = [];
  for (const m of [...input.moments].sort((a, b) => b.score - a.score).slice(0, 3)) out.push({ kind: "peak", atMs: m.peakMs, text: `${fmt(m.peakMs - input.startMs)}: ${m.summary}` });
  for (const e of input.events) {
    if (e.type !== "raid" && e.type !== "poll_end") continue;
    const before = rate(input.chat, e.tMs - o.compareWindowMs, e.tMs);
    const after = rate(input.chat, e.tMs, e.tMs + o.compareWindowMs);
    const d = before > 0 ? after / before : after > 0 ? Infinity : 1;
    const kind = e.type === "raid" ? "raid" : "poll";
    const detail = e.data ? ` ${JSON.stringify(e.data)}` : "";
    out.push({ kind, atMs: e.tMs, chatRateBefore: Math.round(before * 10) / 10, chatRateAfter: Math.round(after * 10) / 10, text: `${kind === "raid" ? "Raid" : "Poll"}${detail} at ${fmt(e.tMs - input.startMs)}: chat ${before.toFixed(1)} -> ${after.toFixed(1)} msgs/min${d >= 1.5 ? " (engaged)" : d <= 0.7 ? " (chat cooled)" : ""}` });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function thumbnailCandidates(input: ReportInput, o: ReportOptions = DEFAULT_REPORT): ThumbnailCandidate[] {
  const hints = input.frameHints ?? [];
  const cands: ThumbnailCandidate[] = [];
  for (const m of input.moments) {
    const near = hints.filter((h) => Math.abs(h.tMs - m.peakMs) <= 3000 && !h.isTransition);
    if (!near.length) {
      cands.push({ tMs: m.peakMs, score: m.score * 0.6, why: `peak of moment ${m.id} (no frame analysis available)` });
      continue;
    }
    for (const h of near) {
      const closeness = 1 - Math.abs(h.tMs - m.peakMs) / 3000;
      cands.push({ tMs: h.tMs, score: Math.round((m.score * 0.4 + (h.faceScore ?? 0) * 0.35 + Math.min(1, h.sharpness ?? 0.5) * 0.15 + closeness * 0.1) * 1000) / 1000, why: `near peak of ${m.id}; face=${(h.faceScore ?? 0).toFixed(2)}, sharp=${(h.sharpness ?? 0.5).toFixed(2)}` });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const picked: ThumbnailCandidate[] = [];
  for (const c of cands) if (picked.length < o.maxThumbnails && picked.every((p) => Math.abs(p.tMs - c.tMs) >= 10_000)) picked.push(c);
  return picked;
}

/** Extracts the first JSON object from model text (tolerates fences/prose). */
export function parseJsonLoose<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

interface LlmShape {
  summary?: unknown;
  titles?: unknown;
  chapterTitles?: unknown;
}

export interface ReportDeps {
  llm?: LlmProvider;
  compactor?: Compactor;
  options?: Partial<ReportOptions>;
}

export async function generateReport(input: ReportInput, deps: ReportDeps = {}): Promise<LiveReport> {
  const o = { ...DEFAULT_REPORT, ...deps.options };
  const compactor = deps.compactor ?? basicCompactor;
  const warnings: string[] = [];
  const chapters = buildChapters(input, o);
  const worked = whatWorked(input, o);
  const thumbs = thumbnailCandidates(input, o);
  const duration = input.endMs - input.startMs;
  const chat = compactor.chat(input.chat, o.chatLimit);

  let summary = `${input.title ?? "Live"}: ${fmt(duration)} long, ${chapters.length} chapters, ${input.moments.length} highlight moments.${input.moments[0] ? ` Biggest peak at ${fmt(input.moments[0].peakMs - input.startMs)}.` : ""}`;
  let titles = [input.title ? `${input.title} - best moments` : `Live highlights (${fmt(duration)})`, ...input.moments.slice(0, 2).map((m) => `Highlight at ${fmt(m.peakMs - input.startMs)}`)].slice(0, o.maxTitles);
  let usedLlm = false;
  let calls = 0;
  let after = chat.tokensAfter;

  if (deps.llm) {
    const excerpts = chapters.map((c, i) => {
      const t = input.transcript.filter((g) => g.startMs >= c.startMs && g.startMs < c.endMs).map((g) => g.text).join(" ").slice(0, o.excerptChars);
      return `[${i}] ${c.timestamp} ${t}`;
    });
    const prompt = [
      `Stream title: ${input.title ?? "(untitled)"}; duration ${fmt(duration)}.`,
      `Chapters (index, start, transcript excerpt):\n${excerpts.join("\n")}`,
      `Top chat (deduped):\n${chat.text}`,
      `Highlights:\n${input.moments.slice(0, 5).map((m) => `${fmt(m.peakMs - input.startMs)} score ${m.score}: ${m.summary}`).join("\n")}`,
      `What worked:\n${worked.map((w) => w.text).join("\n")}`,
      `Return ONLY JSON: {"summary": string (<=60 words), "titles": string[${o.maxTitles}] (<=70 chars each), "chapterTitles": string[${chapters.length}] (<=5 words each, same order)}.`,
    ].join("\n\n");
    after += compactor.estimate(prompt);
    try {
      calls++;
      const res = await deps.llm.complete({ system: "You write concise, factual post-stream reports for a streamer. Use the language of the transcript. Never invent events.", prompt, maxTokens: 700, tier: "small" });
      const j = parseJsonLoose<LlmShape>(res.text);
      if (!j) warnings.push("llm: unparsable response, used deterministic fallback");
      else {
        if (typeof j.summary === "string" && j.summary.trim()) summary = j.summary.trim();
        if (Array.isArray(j.titles)) {
          const t = j.titles.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, o.maxTitles);
          if (t.length) titles = t;
        }
        if (Array.isArray(j.chapterTitles)) j.chapterTitles.forEach((t, i) => typeof t === "string" && t.trim() && chapters[i] && (chapters[i]!.title = t.trim()));
        usedLlm = true;
      }
    } catch (e) {
      warnings.push(`llm: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    summary,
    chapters,
    chapterText: chapters.map((c) => `${c.timestamp} ${c.title}`).join("\n"),
    titles,
    thumbnails: thumbs,
    whatWorked: worked,
    stats: { durationMs: duration, chatMessages: input.chat.length, uniqueChatters: new Set(input.chat.map((m) => m.user)).size, moments: input.moments.length },
    generation: { usedLlm, llmCalls: calls, contextTokensBefore: chat.tokensBefore + compactor.estimate(input.transcript.map((t) => t.text).join(" ")), contextTokensAfter: after, warnings },
  };
}
