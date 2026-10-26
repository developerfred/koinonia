import type { Clock } from "./types.ts";
import { systemClock } from "./types.ts";

/* ---------- prompt-injection hygiene ---------- */

// zero-width, bidi controls, other C0/C1 controls (keep \n and \t)
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function sanitizeUntrusted(text: string, maxLen = 300): string {
  let s = String(text).normalize("NFKC").replace(INVISIBLE, "");
  s = s.replace(/untrusted_data/gi, "untrusted-data").replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"));
  s = s.replace(/\s*\n\s*/g, " ⏎ ").replace(/[ \t]{2,}/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

const nonce = () => Math.random().toString(36).slice(2, 8);

/**
 * Fence untrusted content (chat, usernames, tool output that echoes viewers).
 * The system prompt tells the model that anything inside is data, never instructions.
 */
export function wrapUntrusted(source: string, text: string, maxLen = 4000): string {
  const id = nonce();
  const body = sanitizeUntrustedBlock(text, maxLen);
  return `<untrusted_data source="${source}" id="${id}">\n${body}\n</untrusted_data id="${id}">`;
}

function sanitizeUntrustedBlock(text: string, maxLen: number): string {
  let s = String(text).normalize("NFKC").replace(INVISIBLE, "");
  s = s.replace(/untrusted_data/gi, "untrusted-data").replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"));
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["ignore-instructions", /\b(ignore|disregard|forget)\b.{0,40}\b(previous|above|prior|earlier|all|your)\b.{0,30}\b(instruction|prompt|rule|message)s?/i],
  ["role-override", /\b(you are now|act as|new instructions?|system prompt|developer mode|jailbreak)\b/i],
  ["fake-authority", /\b(i am|this is)\b.{0,20}\b(the )?(admin|owner|streamer|developer|anthropic|system|moderator)\b/i],
  ["tool-directive", /\b(call|run|execute|invoke|use)\b.{0,20}\b(ban_user|stop_stream|delete_message|timeout_user|start_stream|tool)\b/i],
  ["approval-claim", /\b(approved?|authori[sz]ed|confirmed)\b.{0,20}\b(by|from)\b.{0,20}\b(human|admin|owner|streamer)\b/i],
  ["markup-injection", /<\/?(system|assistant|tool_use|function_calls?|untrusted_data)\b/i],
];

/** Heuristic flags only: used for audit/telemetry, never as the security boundary (the approval gate is). */
export function detectInjection(text: string): string[] {
  const s = String(text).normalize("NFKC").replace(INVISIBLE, "");
  return INJECTION_PATTERNS.filter(([, re]) => re.test(s)).map(([n]) => n);
}

/** Redact API keys / bearer tokens from any string before logging. */
export function redactSecrets(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***")
    .replace(/(x-api-key"?\s*[:=]\s*"?)[^\s",]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1***");
}

/* ---------- rate limits ---------- */

/** Token bucket: `capacity` actions, refilled evenly over `perMs`. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private capacity: number, private perMs: number, private clock: Clock = systemClock) {
    this.tokens = capacity;
    this.last = clock.now();
  }
  tryTake(n = 1): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / this.perMs) * this.capacity);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

/* ---------- loop guards ---------- */

export interface LoopGuardOptions {
  maxSteps: number;
  maxToolCalls: number;
  /** Same (tool,args) this many times in one run => blocked. */
  maxIdentical: number;
}

/** Per-run guard. Create one per agent run. */
export class LoopGuard {
  private steps = 0;
  private calls = 0;
  private seen = new Map<string, number>();
  constructor(private o: LoopGuardOptions) {}

  step(): boolean {
    return ++this.steps <= this.o.maxSteps;
  }
  /** Returns null if allowed, else the reason. */
  call(tool: string, args: unknown): string | null {
    if (++this.calls > this.o.maxToolCalls) return "max tool calls per run exceeded";
    const key = tool + ":" + stable(args);
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    if (n > this.o.maxIdentical) return `repeated identical call to ${tool} (${n}x): loop suspected`;
    return null;
  }
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as object).sort().map((k) => k + ":" + stable((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** Tools that always need human sign-off regardless of which agent calls them. */
export const DEFAULT_SENSITIVE_TOOLS: readonly string[] = ["ban_user", "timeout_user", "delete_message", "delete_clip", "stop_stream"];
