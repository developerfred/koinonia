import type { AudioSample, ChatEvent, Moment, Ms, Reason, SignalName, StreamEvent, TranscriptSegment } from "./types.js";

export interface KeywordCue {
  /** Case-insensitive, accent-insensitive substring or RegExp tested on normalized text. */
  pattern: string | RegExp;
  /** 0..1 contribution when matched. */
  weight: number;
  label: string;
}

export interface DetectConfig {
  /** Analysis bucket size. */
  bucketMs: Ms;
  /** Trailing baseline window used for robust (median/MAD) comparisons. */
  baselineMs: Ms;
  /** Fused score needed for a bucket to seed a moment. */
  minScore: number;
  /** A signal counts as "active" (agreement bonus) at or above this score. */
  activeScore: number;
  /** Bonus per extra active signal. */
  agreementBonus: number;
  /** A single signal at score s yields fused >= soloFactor * s, so quiet/talk-only moments can still pass. */
  soloFactor: number;
  weights: Record<SignalName, number>;
  mergeGapMs: Ms;
  padBeforeMs: Ms;
  padAfterMs: Ms;
  minDurationMs: Ms;
  maxDurationMs: Ms;
  maxMoments: number;
  chatRate: { minMessages: number; minRatio: number; zFloor: number; zFull: number };
  chatBurst: { minCount: number; minShare: number; zFull: number };
  audio: { minDeltaDb: number; fullDeltaDb: number; silenceDb: number };
  transcript: { keywords: KeywordCue[]; energyWeight: number; exclaimFull: number; rateZFull: number };
  events: Record<string, number>;
  /** Extra lexicon for chat reactions (normalized lowercase tokens / regex sources). */
  reactionLexicon: { laughter: RegExp; positive: RegExp; negative: RegExp };
}

export const DEFAULT_KEYWORDS: KeywordCue[] = [
  { pattern: /\b(no way|nao acredito|not possible|impossivel|inacreditavel|unbelievable)\b/, weight: 0.8, label: "disbelief" },
  { pattern: /\b(wait|espera|pera ai|olha so|look at this|olha isso)\b/, weight: 0.5, label: "attention call" },
  { pattern: /\b(o segredo|the secret|the trick|o truque|the key is|a chave)\b/, weight: 0.7, label: "reveal" },
  { pattern: /\b(importante|important|listen|escuta|presta atencao|pay attention)\b/, weight: 0.5, label: "emphasis" },
  { pattern: /\b(a historia|let me tell you|deixa eu contar|true story|aconteceu)\b/, weight: 0.5, label: "story opener" },
  { pattern: /\b(consegui|we did it|conseguimos|finally|finalmente|let's go|bora)\b/, weight: 0.7, label: "achievement" },
  { pattern: /\b(wtf|omg|meu deus|oh my god|que isso)\b/, weight: 0.7, label: "exclamation" },
  { pattern: /\b(thank you so much|muito obrigad|obrigado por|welcome raiders|bem-vindos)\b/, weight: 0.4, label: "community moment" },
];

export const DEFAULT_CONFIG: DetectConfig = {
  bucketMs: 5000,
  baselineMs: 120_000,
  minScore: 0.5,
  activeScore: 0.35,
  agreementBonus: 0.1,
  soloFactor: 0.8,
  weights: { chatRate: 0.25, chatBurst: 0.2, audio: 0.25, transcript: 0.2, event: 0.1 },
  mergeGapMs: 10_000,
  padBeforeMs: 8000,
  padAfterMs: 6000,
  minDurationMs: 15_000,
  maxDurationMs: 60_000,
  maxMoments: 10,
  chatRate: { minMessages: 5, minRatio: 2, zFloor: 2, zFull: 8 },
  chatBurst: { minCount: 4, minShare: 0.35, zFull: 8 },
  audio: { minDeltaDb: 6, fullDeltaDb: 15, silenceDb: -55 },
  transcript: { keywords: DEFAULT_KEYWORDS, energyWeight: 0.8, exclaimFull: 3, rateZFull: 6 },
  events: { raid: 0.9, subgift: 0.6, cheer: 0.6, poll_end: 0.6, sub: 0.3 },
  reactionLexicon: {
    laughter: /^(k{3,}|(ha|ja|he){2,}h?a*|lol+|lmao+|rs{2,}|kekw|lul|omegalul|icant)$/,
    positive: /^(pog\w*|gg|wow|insane|clutch|nice|poggers|hype|incrivel|brabo|monstro|show|lindo|amei|love|gl)$/,
    negative: /^(f|rip|oof|nooo+|nao+|sadge|pepehands|damn|ruim|triste)$/,
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends RegExp | unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function resolveConfig(over: DeepPartial<DetectConfig> = {}): DetectConfig {
  const merge = (a: any, b: any): any => {
    if (b === undefined) return a;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !(a instanceof RegExp)) {
      const out: any = { ...a };
      for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
      return out;
    }
    return b;
  };
  return merge(DEFAULT_CONFIG, over) as DetectConfig;
}

export interface DetectInput {
  startMs: Ms;
  endMs: Ms;
  chat?: ChatEvent[];
  audio?: AudioSample[];
  transcript?: TranscriptSegment[];
  events?: StreamEvent[];
}

interface Hit {
  score: number;
  text: string;
}
type BucketHits = Partial<Record<SignalName, Hit>>;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Robust z-score of series[i] against the trailing window (falls back to the whole series when history is short). */
export function robustZ(series: number[], i: number, windowBuckets: number, floor: number): { z: number; base: number } {
  let hist = series.slice(Math.max(0, i - windowBuckets), i);
  if (hist.length < 4) hist = series.filter((_, j) => j !== i);
  const med = median(hist);
  const mad = median(hist.map((x) => Math.abs(x - med))) * 1.4826;
  return { z: (series[i]! - med) / Math.max(mad, floor), base: med };
}

function bucketOf(t: Ms, start: Ms, size: Ms, n: number): number {
  const i = Math.floor((t - start) / size);
  return i < 0 || i >= n ? -1 : i;
}

export function detectMoments(input: DetectInput, overrides: DeepPartial<DetectConfig> = {}): Moment[] {
  const cfg = resolveConfig(overrides);
  const { startMs, endMs } = input;
  const size = cfg.bucketMs;
  const n = Math.max(1, Math.ceil((endMs - startMs) / size));
  const win = Math.max(4, Math.round(cfg.baselineMs / size));
  const hits: BucketHits[] = Array.from({ length: n }, () => ({}));
  const available: Record<SignalName, boolean> = {
    chatRate: !!input.chat?.length,
    chatBurst: !!input.chat?.length,
    audio: !!input.audio?.length,
    transcript: !!input.transcript?.length,
    event: !!input.events?.length,
  };

  // ---- chat rate & reaction bursts
  if (input.chat?.length) {
    const total = new Array<number>(n).fill(0);
    const react = new Array<number>(n).fill(0);
    const kinds = Array.from({ length: n }, () => ({ laughter: 0, positive: 0, negative: 0 }));
    const lex = cfg.reactionLexicon;
    for (const m of input.chat) {
      const b = bucketOf(m.tMs, startMs, size, n);
      if (b < 0) continue;
      total[b]!++;
      const toks = normalize(m.text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const all = [...toks, ...(m.emotes ?? []).map(normalize)];
      const kind = all.some((t) => lex.laughter.test(t)) ? "laughter" : all.some((t) => lex.positive.test(t)) ? "positive" : all.some((t) => lex.negative.test(t)) ? "negative" : null;
      const caps = m.text.length >= 4 && m.text === m.text.toUpperCase() && /\p{L}/u.test(m.text);
      if (kind || caps || (m.emotes?.length ?? 0) >= 2) {
        react[b]!++;
        if (kind) kinds[b]![kind]++;
      }
    }
    for (let i = 0; i < n; i++) {
      const r = robustZ(total, i, win, cfg.chatRate.zFloor);
      const ratio = total[i]! / Math.max(r.base, 1);
      if (total[i]! >= cfg.chatRate.minMessages && ratio >= cfg.chatRate.minRatio && r.z > 0) {
        const s = clamp01((r.z - 2) / (cfg.chatRate.zFull - 2));
        if (s > 0) hits[i]!.chatRate = { score: s, text: `chat rate ${total[i]} msgs/${size / 1000}s, ${ratio.toFixed(1)}x baseline (${r.base.toFixed(1)}), z=${r.z.toFixed(1)}` };
      }
      const rb = robustZ(react, i, win, cfg.chatRate.zFloor);
      const share = react[i]! / Math.max(total[i]!, 1);
      if (react[i]! >= cfg.chatBurst.minCount && share >= cfg.chatBurst.minShare && rb.z > 0) {
        const s = clamp01((rb.z - 2) / (cfg.chatBurst.zFull - 2));
        const k = kinds[i]!;
        const dom = (Object.entries(k).sort((a, b) => b[1] - a[1])[0] as [string, number]);
        if (s > 0) hits[i]!.chatBurst = { score: s, text: `${react[i]} reaction messages (${Math.round(share * 100)}% of chat), mostly ${dom[1] > 0 ? dom[0] : "caps/emote"}` };
      }
    }
  }

  // ---- audio loudness peaks
  if (input.audio?.length) {
    const peak = new Array<number>(n).fill(NaN);
    for (const a of input.audio) {
      const b = bucketOf(a.tMs, startMs, size, n);
      if (b < 0 || a.db < cfg.audio.silenceDb) continue;
      if (!(peak[b]! >= a.db)) peak[b] = a.db;
    }
    const filled = peak.map((p) => (Number.isNaN(p) ? cfg.audio.silenceDb : p));
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(peak[i]!)) continue;
      const r = robustZ(filled, i, win, 1);
      const delta = peak[i]! - r.base;
      const s = clamp01((delta - cfg.audio.minDeltaDb) / (cfg.audio.fullDeltaDb - cfg.audio.minDeltaDb));
      if (s > 0) hits[i]!.audio = { score: s, text: `loudness peak ${peak[i]!.toFixed(1)} dB, +${delta.toFixed(1)} dB over baseline` };
    }
  }

  // ---- transcript cues (keywords + vocal energy). Independent of game audio/chat volume.
  if (input.transcript?.length) {
    const wps = new Array<number>(n).fill(0);
    const segByBucket: TranscriptSegment[][] = Array.from({ length: n }, () => []);
    for (const seg of input.transcript) {
      const b = bucketOf((seg.startMs + seg.endMs) / 2, startMs, size, n);
      if (b < 0) continue;
      segByBucket[b]!.push(seg);
      wps[b]! += seg.text.split(/\s+/).filter(Boolean).length / (size / 1000);
    }
    for (let i = 0; i < n; i++) {
      const segs = segByBucket[i]!;
      if (!segs.length) continue;
      const text = segs.map((s) => s.text).join(" ");
      const norm = normalize(text);
      let kw = 0;
      const labels: string[] = [];
      for (const k of cfg.transcript.keywords) {
        const hit = typeof k.pattern === "string" ? norm.includes(normalize(k.pattern)) : k.pattern.test(norm);
        if (hit) {
          kw += k.weight;
          labels.push(k.label);
        }
      }
      const kwScore = clamp01(kw);
      const exclaims = (text.match(/!/g) ?? []).length;
      const rz = robustZ(wps, i, win, 0.5);
      const energy = Math.max(clamp01(exclaims / cfg.transcript.exclaimFull), clamp01(rz.z / cfg.transcript.rateZFull)) * cfg.transcript.energyWeight;
      const s = Math.max(kwScore, energy);
      if (s > 0.05) {
        const why = [labels.length ? `cues: ${labels.join(", ")}` : "", energy > 0 ? `energy (exclaims=${exclaims}, speech-rate z=${rz.z.toFixed(1)})` : ""].filter(Boolean).join("; ");
        hits[i]!.transcript = { score: s, text: `transcript ${why} "${text.slice(0, 80)}"` };
      }
    }
  }

  // ---- stream events
  for (const e of input.events ?? []) {
    const w = cfg.events[e.type];
    const b = bucketOf(e.tMs, startMs, size, n);
    if (!w || b < 0) continue;
    const cur = hits[b]!.event;
    if (!cur || cur.score < w) hits[b]!.event = { score: w, text: `event ${e.type}${e.data ? " " + JSON.stringify(e.data) : ""}` };
  }

  // ---- fusion
  const wSum = (Object.keys(cfg.weights) as SignalName[]).filter((k) => available[k]).reduce((a, k) => a + cfg.weights[k], 0) || 1;
  const fused = hits.map((h) => {
    const entries = Object.entries(h) as [SignalName, Hit][];
    if (!entries.length) return 0;
    const avg = entries.reduce((a, [k, v]) => a + cfg.weights[k] * v.score, 0) / wSum;
    const max = Math.max(...entries.map(([, v]) => v.score));
    const active = entries.filter(([, v]) => v.score >= cfg.activeScore).length;
    return clamp01(Math.max(avg, cfg.soloFactor * max) + cfg.agreementBonus * Math.max(0, active - 1));
  });

  // ---- group buckets into moments
  const gap = Math.max(1, Math.round(cfg.mergeGapMs / size));
  const groups: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (fused[i]! < cfg.minScore) continue;
    const last = groups[groups.length - 1];
    if (last && i - last[last.length - 1]! <= gap) last.push(i);
    else groups.push([i]);
  }
  let moments: Moment[] = groups.map((g) => {
    const peakIdx = g.reduce((a, b) => (fused[b]! > fused[a]! ? b : a));
    const peakMs = startMs + peakIdx * size + size / 2;
    let s = startMs + g[0]! * size - cfg.padBeforeMs;
    let e = startMs + (g[g.length - 1]! + 1) * size + cfg.padAfterMs;
    if (e - s > cfg.maxDurationMs) {
      s = Math.max(s, peakMs - cfg.maxDurationMs * 0.6);
      e = Math.min(e, s + cfg.maxDurationMs);
    }
    if (e - s < cfg.minDurationMs) {
      const extra = (cfg.minDurationMs - (e - s)) / 2;
      s -= extra;
      e += extra;
    }
    s = Math.max(startMs, s);
    e = Math.min(endMs, e);
    const best: Partial<Record<SignalName, Hit & { atMs: Ms }>> = {};
    for (const i of g) for (const [k, v] of Object.entries(hits[i]!) as [SignalName, Hit][]) if (!best[k] || v.score > best[k]!.score) best[k] = { ...v, atMs: startMs + i * size };
    const reasons: Reason[] = (Object.entries(best) as [SignalName, Hit & { atMs: Ms }][]).map(([signal, v]) => ({ signal, score: round(v.score), text: v.text, atMs: v.atMs })).sort((a, b) => b.score - a.score);
    const signals: Moment["signals"] = {};
    for (const r of reasons) signals[r.signal] = r.score;
    return { id: "", startMs: s, endMs: e, peakMs, score: round(fused[peakIdx]!), signals, reasons, summary: reasons.map((r) => r.text).join(" | ") };
  });
  // padding can make neighbours overlap: merge them
  moments.sort((a, b) => a.startMs - b.startMs);
  const out: Moment[] = [];
  for (const m of moments) {
    const p = out[out.length - 1];
    if (p && m.startMs <= p.endMs) {
      const hi = m.score > p.score ? m : p;
      const rs = new Map<SignalName, Reason>();
      for (const r of [...p.reasons, ...m.reasons]) if (!rs.has(r.signal) || rs.get(r.signal)!.score < r.score) rs.set(r.signal, r);
      const reasons = [...rs.values()].sort((a, b) => b.score - a.score);
      const signals: Moment["signals"] = {};
      for (const r of reasons) signals[r.signal] = r.score;
      Object.assign(p, { endMs: Math.max(p.endMs, m.endMs), peakMs: hi.peakMs, score: hi.score, reasons, signals, summary: reasons.map((r) => r.text).join(" | ") });
    } else out.push(m);
  }
  moments = out.sort((a, b) => b.score - a.score).slice(0, cfg.maxMoments);
  moments.forEach((m, i) => (m.id = `m${i + 1}`));
  return moments;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
