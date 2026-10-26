import type { Ms, Word } from "./types.js";

/** Implemented by the studio (e.g. on-device speech model) or a server; this package never calls it itself except via helpers. */
export interface CaptionProvider {
  transcribeWords(req: { mediaRef: string; startMs: Ms; endMs: Ms; language?: string }): Promise<Word[]>;
}

export interface CaptionCue {
  startMs: Ms;
  endMs: Ms;
  /** Lines of words; each word keeps its own timing for karaoke-style highlight. */
  lines: Word[][];
}

export interface GroupOptions {
  maxCharsPerLine: number;
  maxLines: number;
  maxCueMs: Ms;
  /** Gap between words that forces a new cue. */
  breakGapMs: Ms;
  /** Minimum on-screen time for a cue (extends endMs up to next cue start). */
  minCueMs: Ms;
}

export const DEFAULT_GROUP: GroupOptions = { maxCharsPerLine: 16, maxLines: 2, maxCueMs: 3000, breakGapMs: 600, minCueMs: 500 };

/** Re-base words to a clip (t=0 at clipStart) and drop words outside [clipStart, clipEnd]. */
export function rebaseWords(words: Word[], clipStartMs: Ms, clipEndMs: Ms): Word[] {
  return words.filter((w) => w.endMs > clipStartMs && w.startMs < clipEndMs).map((w) => ({ ...w, startMs: Math.max(0, w.startMs - clipStartMs), endMs: Math.min(clipEndMs, w.endMs) - clipStartMs }));
}

export function groupWords(words: Word[], opts: Partial<GroupOptions> = {}): CaptionCue[] {
  const o = { ...DEFAULT_GROUP, ...opts };
  const cues: CaptionCue[] = [];
  let lines: Word[][] = [[]];
  let cueStart = 0;
  let prev: Word | undefined;
  const flush = () => {
    const flat = lines.flat();
    if (flat.length) cues.push({ startMs: flat[0]!.startMs, endMs: flat[flat.length - 1]!.endMs, lines: lines.filter((l) => l.length) });
    lines = [[]];
  };
  for (const w of words) {
    const flat = lines.flat();
    const endPunct = prev && /[.!?…]$/.test(prev.text);
    if (flat.length && (w.startMs - prev!.endMs > o.breakGapMs || w.endMs - cueStart > o.maxCueMs || endPunct)) flush();
    if (!lines.flat().length) cueStart = w.startMs;
    let line = lines[lines.length - 1]!;
    const len = line.reduce((a, x) => a + x.text.length + 1, 0) + w.text.length;
    if (line.length && len > o.maxCharsPerLine) {
      if (lines.length >= o.maxLines) {
        flush();
        cueStart = w.startMs;
      }
      lines.push([]);
      line = lines[lines.length - 1]!;
    }
    line.push(w);
    prev = w;
  }
  flush();
  // enforce minimum duration without overlapping the next cue
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const limit = cues[i + 1]?.startMs ?? Infinity;
    if (c.endMs - c.startMs < o.minCueMs) c.endMs = Math.min(limit, c.startMs + o.minCueMs);
  }
  return cues;
}

// ---------------------------------------------------------------- style + render spec

export interface CaptionStyle {
  fontFamily: string;
  fontWeight: number;
  fontSizePx: number;
  lineHeight: number;
  uppercase: boolean;
  fill: string;
  /** Color for the currently spoken word (null = no highlight). */
  activeFill: string | null;
  /** Scale pop for the active word (1 = none). */
  activeScale: number;
  stroke: string | null;
  strokeWidthPx: number;
  shadow: { color: string; blurPx: number; offsetY: number } | null;
  box: { fill: string; paddingPx: number; radiusPx: number } | null;
  /** Horizontal text area as a fraction of canvas width. */
  maxWidthFraction: number;
  /** Distance from canvas bottom to the bottom of the block. Default keeps clear of platform UI. */
  marginBottomFraction: number;
  align: "center";
  fadeMs: Ms;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: "Inter, 'Segoe UI', sans-serif",
  fontWeight: 800,
  fontSizePx: 72,
  lineHeight: 1.15,
  uppercase: true,
  fill: "#FFFFFF",
  activeFill: "#FFE14D",
  activeScale: 1.08,
  stroke: "#000000",
  strokeWidthPx: 10,
  shadow: { color: "rgba(0,0,0,0.5)", blurPx: 8, offsetY: 4 },
  box: null,
  maxWidthFraction: 0.86,
  // ~ lower 22% is typically covered by platform UI on vertical feeds (assumed, not an official figure)
  marginBottomFraction: 0.22,
  align: "center",
  fadeMs: 80,
};

/** Primitive draw op; trivially mapped to CanvasRenderingContext2D / OffscreenCanvas. */
export type DrawOp =
  | { op: "box"; x: number; y: number; w: number; h: number; fill: string; radius: number; alpha: number }
  | { op: "text"; text: string; x: number; y: number; font: string; fill: string; stroke: string | null; strokeWidth: number; shadow: CaptionStyle["shadow"]; scale: number; alpha: number };

export type MeasureText = (text: string, font: string) => number;

/** Fallback metric for tests/workers without a canvas: avg glyph ~0.56em. */
export const approxMeasure: MeasureText = (text, font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return text.length * (m ? parseFloat(m[1]!) : 16) * 0.56;
};

export interface RenderSpecOptions {
  width: number;
  height: number;
  measure?: MeasureText;
}

/** Pure: cues + style + time -> draw ops (baseline y = text baseline, x = word left edge). Empty when no cue is active. */
export function renderCaptionOps(cues: CaptionCue[], style: CaptionStyle, tMs: Ms, r: RenderSpecOptions): DrawOp[] {
  const cue = cues.find((c) => tMs >= c.startMs && tMs < c.endMs);
  if (!cue) return [];
  const measure = r.measure ?? approxMeasure;
  const font = `${style.fontWeight} ${style.fontSizePx}px ${style.fontFamily}`;
  const t = (s: string) => (style.uppercase ? s.toUpperCase() : s);
  const alpha = style.fadeMs > 0 ? Math.min(1, (tMs - cue.startMs) / style.fadeMs, (cue.endMs - tMs) / style.fadeMs) : 1;
  const space = measure(" ", font);
  const lineH = style.fontSizePx * style.lineHeight;
  const blockH = lineH * cue.lines.length;
  const bottom = r.height * (1 - style.marginBottomFraction);
  const top = bottom - blockH;
  const ops: DrawOp[] = [];
  const widths = cue.lines.map((line) => line.reduce((a, w, i) => a + measure(t(w.text), font) + (i ? space : 0), 0));
  if (style.box) {
    const bw = Math.max(...widths) + style.box.paddingPx * 2;
    ops.push({ op: "box", x: (r.width - bw) / 2, y: top - style.box.paddingPx, w: bw, h: blockH + style.box.paddingPx * 2, fill: style.box.fill, radius: style.box.radiusPx, alpha });
  }
  cue.lines.forEach((line, li) => {
    let x = (r.width - widths[li]!) / 2;
    const y = top + lineH * li + style.fontSizePx; // approx baseline
    for (const w of line) {
      const active = style.activeFill !== null && tMs >= w.startMs && tMs < w.endMs;
      const text = t(w.text);
      ops.push({ op: "text", text, x, y, font, fill: active ? style.activeFill! : style.fill, stroke: style.stroke, strokeWidth: style.strokeWidthPx, shadow: style.shadow, scale: active ? style.activeScale : 1, alpha });
      x += measure(text, font) + space;
    }
  });
  return ops;
}

/** Minimal subset of CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D used by drawOps. */
export interface Canvas2DLike {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  font: string;
  fillStyle: string | unknown;
  strokeStyle: string | unknown;
  lineWidth: number;
  lineJoin: string;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetY: number;
  textBaseline: string;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number): void;
  fill(): void;
  measureText(t: string): { width: number };
}

export function drawOps(ctx: Canvas2DLike, ops: DrawOp[]): void {
  for (const op of ops) {
    ctx.save();
    ctx.globalAlpha = op.alpha;
    if (op.op === "box") {
      ctx.fillStyle = op.fill;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(op.x, op.y, op.w, op.h, op.radius);
        ctx.fill();
      } else ctx.fillRect(op.x, op.y, op.w, op.h);
    } else {
      ctx.font = op.font;
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      const w = ctx.measureText(op.text).width;
      ctx.translate(op.x + w / 2, op.y);
      ctx.scale(op.scale, op.scale);
      const x = -w / 2;
      if (op.shadow) {
        ctx.shadowColor = op.shadow.color;
        ctx.shadowBlur = op.shadow.blurPx;
        ctx.shadowOffsetY = op.shadow.offsetY;
      }
      if (op.stroke && op.strokeWidth > 0) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = op.strokeWidth;
        ctx.strokeText(op.text, x, 0);
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = op.fill;
      ctx.fillText(op.text, x, 0);
    }
    ctx.restore();
  }
}
