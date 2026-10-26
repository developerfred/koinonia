import { describe, it, expect } from "vitest";
import { backoffDelay, cleanText, ProposalStore, RateLimiter, redact, SeenSet, safeLogger } from "../src/util.js";
import { NotApprovedError } from "../src/types.js";

describe("backoff", () => {
  it("grows, is capped, and is jittered within bounds", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(30, () => 1)).toBe(60000);
    expect(backoffDelay(30, () => 0.5, { maxMs: 10000 })).toBeLessThanOrEqual(10000);
    const a = backoffDelay(4, () => 0.1), b = backoffDelay(4, () => 0.9);
    expect(a).not.toBe(b);
  });
});

describe("RateLimiter", () => {
  it("limits and refills", () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect(r.tryTake()).toBe(true);
    expect(r.tryTake()).toBe(true);
    expect(r.tryTake()).toBe(false);
    expect(r.waitMs()).toBe(500);
    t = 500;
    expect(r.tryTake()).toBe(true);
  });
});

describe("SeenSet", () => {
  it("dedupes and evicts", () => {
    const s = new SeenSet(2);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
    s.add("b"); s.add("c");
    expect(s.add("a")).toBe(true); // evicted
  });
});

describe("redaction", () => {
  it("hides tokens in strings and keys", () => {
    expect(redact("PASS oauth:abcd1234")).toBe("PASS oauth:[REDACTED]");
    expect(redact({ accessToken: "x", nested: { Authorization: "Bearer zzz" }, ok: 1 })).toEqual({ accessToken: "[REDACTED]", nested: { Authorization: "[REDACTED]" }, ok: 1 });
  });
  it("safeLogger redacts", () => {
    const got: unknown[] = [];
    const l = safeLogger({ debug() {}, info: (m, f) => got.push([m, f]), warn() {}, error() {} });
    l.info("hi oauth:secret", { token: "t" });
    expect(JSON.stringify(got)).not.toMatch(/secret|"t"/);
  });
});

describe("cleanText", () => {
  it("replaces control/bidi chars preserving length and caps", () => {
    expect(cleanText("a\u0000b‮c")).toBe("a b c");
    expect(Array.from(cleanText("x".repeat(50), 10))).toHaveLength(10);
  });
});

describe("ProposalStore", () => {
  it("requires approval, single use, expiry, platform match", () => {
    let t = 0;
    const s = new ProposalStore(() => t, 1000);
    const p = s.create({ platform: "twitch", kind: "ban", targetUserId: "1" });
    expect(() => s.consume(p.id, "twitch")).toThrow(NotApprovedError);
    s.approve(p.id);
    expect(() => s.consume(p.id, "youtube")).toThrow(NotApprovedError);
    expect(s.consume(p.id, "twitch").status).toBe("executed");
    expect(() => s.consume(p.id, "twitch")).toThrow(NotApprovedError);
    const q = s.create({ platform: "twitch", kind: "ban", targetUserId: "2" });
    s.approve(q.id);
    t = 2000;
    expect(s.get(q.id)!.status).toBe("expired");
    expect(() => s.consume(q.id, "twitch")).toThrow(NotApprovedError);
    const r = s.create({ platform: "twitch", kind: "ban", targetUserId: "3" });
    s.reject(r.id);
    expect(() => s.approve(r.id)).toThrow(NotApprovedError);
  });
});
