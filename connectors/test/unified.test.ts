import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UnifiedChat, toRingMsg } from "../src/unified.js";
import type { ChatConnector, ChatMessage, ConnectorEvent, Platform } from "../src/types.js";
import { ProposalStore } from "../src/util.js";
import { ChatBuffer } from "../../studio/src/chat/ring.js";

class Fake implements ChatConnector {
  state = "idle" as const;
  cbs: ((m: ChatMessage) => void)[] = []; evs: ((e: ConnectorEvent) => void)[] = [];
  proposalStore = new ProposalStore();
  executed: string[] = [];
  constructor(readonly platform: Platform, private failConnect = false) {}
  async connect() { if (this.failConnect) throw new Error("nope"); }
  async disconnect() {}
  onMessage(cb: (m: ChatMessage) => void) { this.cbs.push(cb); return () => {}; }
  onEvent(cb: (e: ConnectorEvent) => void) { this.evs.push(cb); return () => {}; }
  async send() {} async deleteMessage() {}
  requestTimeout(u: string, d: number) { return this.proposalStore.create({ platform: this.platform, kind: "timeout", targetUserId: u, durationSec: d }); }
  requestBan(u: string) { return this.proposalStore.create({ platform: this.platform, kind: "ban", targetUserId: u }); }
  async executeProposal(id: string) { this.proposalStore.consume(id, this.platform); this.executed.push(id); }
  emit(m: ChatMessage) { this.cbs.forEach((c) => c(m)); }
}
const mk = (platform: Platform, id: string, ts: number, text = "hi", name = "u"): ChatMessage => ({
  platform, id, channel: "c", ts, user: { id: "1", login: name, name }, text, emotes: [], badges: [], kind: "chat",
});

beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }); });
afterEach(() => { vi.useRealTimers(); });

describe("UnifiedChat", () => {
  it("orders by timestamp within the hold window and numbers the feed", async () => {
    const tw = new Fake("twitch"), yt = new Fake("youtube");
    const u = new UnifiedChat({ holdMs: 200 }).add(tw).add(yt);
    const got: [number, string][] = [];
    u.onMessage((i) => got.push([i.seq, i.message.id]));
    tw.emit(mk("twitch", "t2", 2000));
    yt.emit(mk("youtube", "y1", 1000));
    tw.emit(mk("twitch", "t3", 3000));
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(got).toEqual([[1, "y1"], [2, "t2"], [3, "t3"]]);
  });
  it("dedupes across connectors and replays", async () => {
    const tw = new Fake("twitch");
    const u = new UnifiedChat({ holdMs: 0 }).add(tw);
    const got: string[] = [];
    u.onMessage((i) => got.push(i.message.id));
    tw.emit(mk("twitch", "a", 1)); tw.emit(mk("twitch", "a", 1)); tw.emit(mk("youtube", "a", 1));
    expect(got).toEqual(["a", "a"]); // same id on different platforms are different messages
    expect(u.cursor).toBe(2);
  });
  it("feeds the studio ChatBuffer ring", async () => {
    const tw = new Fake("twitch");
    const u = new UnifiedChat({ holdMs: 0 }).add(tw);
    const ring = new ChatBuffer(10);
    u.pipeTo(ring);
    tw.emit(mk("twitch", "a", 5, "olá", "Ana"));
    expect(ring.get(1)).toMatchObject({ id: 1, ts: 5, platform: "twitch", user: "Ana", text: "olá" });
    expect(ring.since(0).m).toEqual([{ u: "Ana", t: "olá" }]);
    expect(toRingMsg(mk("youtube", "b", 1))).toEqual({ ts: 1, platform: "youtube", user: "u", text: "hi" });
  });
  it("start tolerates a failing platform; stop flushes", async () => {
    const tw = new Fake("twitch"), yt = new Fake("youtube", true);
    const u = new UnifiedChat({ holdMs: 1000 }).add(tw).add(yt);
    expect(await u.start()).toEqual({ twitch: "ok", youtube: "nope" });
    const got: string[] = [];
    u.onMessage((i) => got.push(i.message.id));
    tw.emit(mk("twitch", "a", 1));
    await u.stop();
    expect(got).toEqual(["a"]);
  });
  it("a throwing subscriber does not block others", async () => {
    const tw = new Fake("twitch");
    const u = new UnifiedChat({ holdMs: 0 }).add(tw);
    const got: string[] = [];
    u.onMessage(() => { throw new Error("x"); });
    u.onMessage((i) => got.push(i.message.id));
    tw.emit(mk("twitch", "a", 1));
    expect(got).toEqual(["a"]);
  });
  it("moderation: proposals only until human approval", async () => {
    const tw = new Fake("twitch");
    const u = new UnifiedChat().add(tw);
    const p = u.requestBan("twitch", "7", "spam");
    expect(u.pendingProposals().map((x) => x.id)).toEqual([p.id]);
    await expect(u.execute(p.id)).rejects.toThrow();
    expect(tw.executed).toEqual([]);
    u.approve(p.id);
    await u.execute(p.id);
    expect(tw.executed).toEqual([p.id]);
    await expect(u.execute(p.id)).rejects.toThrow();
  });
  it("forwards events and rejects duplicate platforms", () => {
    const tw = new Fake("twitch");
    const u = new UnifiedChat().add(tw);
    const evs: ConnectorEvent[] = [];
    u.onEvent((e) => evs.push(e));
    tw.evs.forEach((c) => c({ type: "message-deleted", platform: "twitch", id: "x" }));
    expect(evs).toHaveLength(1);
    expect(() => u.add(new Fake("twitch"))).toThrow();
  });
});
