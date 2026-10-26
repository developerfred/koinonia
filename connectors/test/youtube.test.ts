import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QuotaTracker, YouTubeApiError, YouTubeConnector, createFetchYouTubeApi, extractShortcodes, nextQuotaReset, ytToChatMessage } from "../src/youtube.js";
import type { YouTubeApi, YtLiveChatMessage, YtPage } from "../src/youtube.js";
import { NotApprovedError, ReadOnlyError } from "../src/types.js";
import type { ChatMessage, ConnectorEvent } from "../src/types.js";

const txt = (id: string, text: string, extra: Partial<YtLiveChatMessage["authorDetails"]> = {}): YtLiveChatMessage => ({
  id, snippet: { type: "textMessageEvent", publishedAt: "2024-01-01T00:00:00Z", textMessageDetails: { messageText: text } },
  authorDetails: { channelId: "UC1", displayName: "Bia", ...extra },
});

class MockApi implements YouTubeApi {
  script: (YtPage | Error)[] = [];
  calls: { pageToken?: string }[] = [];
  streamList?: YouTubeApi["streamList"];
  inserts: string[] = []; removes: string[] = []; bans: unknown[][] = [];
  async list(a: { pageToken?: string }) {
    this.calls.push({ pageToken: a.pageToken });
    const n = this.script.shift();
    if (!n) return { items: [], pollingIntervalMillis: 5000, nextPageToken: "t" };
    if (n instanceof Error) throw n;
    return n;
  }
  async insert(_: string, t: string) { this.inserts.push(t); }
  async remove(id: string) { this.removes.push(id); }
  async ban(...a: unknown[]) { this.bans.push(a); }
}

function setup(o: Partial<ConstructorParameters<typeof YouTubeConnector>[0]> = {}) {
  const api = (o.api as MockApi) ?? new MockApi();
  const c = new YouTubeConnector({ api, liveChatId: "LC", rng: () => 0.5, quota: new QuotaTracker(1e9), ...o });
  const msgs: ChatMessage[] = [], evs: ConnectorEvent[] = [];
  c.onMessage((m) => msgs.push(m)); c.onEvent((e) => evs.push(e));
  return { c, api, msgs, evs };
}

beforeEach(() => { vi.useFakeTimers({ now: new Date("2024-06-01T12:00:00Z") }); });
afterEach(() => { vi.useRealTimers(); });

describe("normalization", () => {
  it("maps fields, badges, shortcodes", () => {
    const m = ytToChatMessage(txt("a", "hi :face-blue-smiling: and 12:30:45", { isChatModerator: true, isChatSponsor: true }), "LC", 0)!;
    expect(m.user).toEqual({ id: "UC1", login: "UC1", name: "Bia" });
    expect(m.badges.map((b) => b.kind)).toEqual(["moderator", "subscriber"]);
    expect(m.emotes).toEqual([{ name: ":face-blue-smiling:", start: 3, end: 22 }]);
    expect(m.ts).toBe(Date.parse("2024-01-01T00:00:00Z"));
  });
  it("super chats are paid; other types ignored", () => {
    const sc: YtLiveChatMessage = { id: "s", snippet: { type: "superChatEvent", superChatDetails: { userComment: "wow", amountDisplayString: "R$5" } }, authorDetails: { channelId: "U" } };
    expect(ytToChatMessage(sc, "LC", 0)).toMatchObject({ kind: "paid", paid: "R$5", text: "wow" });
    expect(ytToChatMessage({ id: "x", snippet: { type: "newSponsorEvent" } }, "LC", 0)).toBeNull();
  });
  it("shortcode offsets are code points after astral chars", () => {
    expect(extractShortcodes("😀 :wave:")[0]).toMatchObject({ start: 2, end: 8 });
  });
});

describe("quota", () => {
  it("computes Pacific midnight reset", () => {
    // 2024-06-01 12:00Z = 05:00 PDT -> reset at 2024-06-02 07:00Z
    expect(new Date(nextQuotaReset(Date.parse("2024-06-01T12:00:00Z"))).toISOString()).toBe("2024-06-02T07:00:00.000Z");
  });
  it("tracks, rolls over, stretches", () => {
    let t = Date.parse("2024-06-01T12:00:00Z");
    const q = new QuotaTracker(100, () => t);
    q.spend(60);
    expect(q.remaining).toBe(40);
    expect(q.stretchIntervalMs(5)).toBe(Math.ceil((q.resetsAt - t) / 8));
    q.exhaust();
    expect(q.stretchIntervalMs(5)).toBe(Infinity);
    t = q.resetsAt + 1;
    expect(q.remaining).toBe(100);
  });
});

describe("polling", () => {
  it("discards backlog by default, then streams new messages with page token, honoring server interval", async () => {
    const { c, api, msgs } = setup();
    api.script = [
      { items: [txt("old", "old")], nextPageToken: "p1", pollingIntervalMillis: 3000 },
      { items: [txt("n1", "new"), txt("n1", "new")], nextPageToken: "p2", pollingIntervalMillis: 3000 },
    ];
    const p = c.connect();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(msgs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2997);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(api.calls[1]!.pageToken).toBe("p1");
    expect(msgs.map((m) => m.id)).toEqual(["n1"]);
  });
  it("replayBacklog emits first page", async () => {
    const { c, api, msgs } = setup({ replayBacklog: true });
    api.script = [{ items: [txt("old", "old")], nextPageToken: "p1" }];
    c.connect(); await vi.advanceTimersByTimeAsync(1);
    expect(msgs).toHaveLength(1);
  });
  it("emits delete/ban events", async () => {
    const { c, api, evs } = setup();
    api.script = [
      { items: [], nextPageToken: "a", pollingIntervalMillis: 1000 },
      { items: [
        { id: "d", snippet: { type: "messageDeletedEvent", messageDeletedDetails: { deletedMessageId: "zz" } } },
        { id: "b", snippet: { type: "userBannedEvent", userBannedDetails: { bannedUserDetails: { channelId: "UCx" }, banDurationSeconds: "300" } } },
      ], nextPageToken: "b" },
    ];
    c.connect(); await vi.advanceTimersByTimeAsync(1500);
    expect(evs).toContainEqual({ type: "message-deleted", platform: "youtube", id: "zz" });
    expect(evs).toContainEqual({ type: "user-cleared", platform: "youtube", userId: "UCx", durationSec: 300 });
  });
  it("ends when the stream goes offline", async () => {
    const { c, api } = setup();
    api.script = [{ items: [], offlineAt: "2024-06-01T12:00:00Z" }];
    c.connect(); await vi.advanceTimersByTimeAsync(1);
    expect(c.state).toBe("ended");
    await vi.advanceTimersByTimeAsync(60000);
    expect(api.calls).toHaveLength(1);
  });
  it("liveChatEnded error ends and rejects connect", async () => {
    const { c, api } = setup();
    api.script = [new YouTubeApiError(403, "liveChatEnded")];
    const p = c.connect(); const r = expect(p).rejects.toThrow("liveChatEnded");
    await vi.advanceTimersByTimeAsync(1); await r;
    expect(c.state).toBe("ended");
  });
  it("auth errors are fatal", async () => {
    const { c, api, evs } = setup();
    api.script = [new YouTubeApiError(401, "authError")];
    const p = c.connect(); const r = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1); await r;
    expect(c.state).toBe("failed");
    expect(evs.some((e) => e.type === "error" && e.code === "auth")).toBe(true);
  });
});

describe("error backoff", () => {
  it("transient errors back off with jitter and recover", async () => {
    const { c, api, msgs } = setup({ replayBacklog: true });
    api.script = [new Error("net"), new YouTubeApiError(503, "backendError"), { items: [txt("a", "ok")], nextPageToken: "x", pollingIntervalMillis: 1000 }];
    const p = c.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(c.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(748); expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3); expect(api.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1251);
    expect(api.calls).toHaveLength(3);
    await p;
    expect(c.state).toBe("connected");
    expect(msgs).toHaveLength(1);
  });
  it("rateLimitExceeded backs off harder (>=2.5s base)", async () => {
    const { c, api } = setup();
    api.script = [new YouTubeApiError(403, "rateLimitExceeded")];
    c.connect(); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(api.calls.length).toBeGreaterThan(1);
  });
});

describe("quota scenarios", () => {
  it("paces polling to the quota horizon, pauses when spent, resumes after reset", async () => {
    const quota = new QuotaTracker(10, () => Date.now());
    const { c, api, evs } = setup({ quota, minPollMs: 1000 });
    c.connect();
    await vi.advanceTimersByTimeAsync(1);              // call 1 (5 units), 1 call left
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(api.calls).toHaveLength(1);                 // stretched: last call held back
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(api.calls).toHaveLength(2);                 // budget now 0
    await vi.advanceTimersByTimeAsync(6000);
    expect(c.state).toBe("paused");
    expect(evs.some((e) => e.type === "error" && e.code === "quota")).toBe(true);
    const before = api.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(quota.resetsAt - Date.now() + 10);
    expect(api.calls.length).toBeGreaterThan(before);
  });
  it("server quotaExceeded pauses until reset", async () => {
    const { c, api } = setup();
    api.script = [new YouTubeApiError(403, "quotaExceeded")];
    c.connect(); await vi.advanceTimersByTimeAsync(1);
    expect(c.state).toBe("paused");
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(api.calls.length).toBeGreaterThan(1);
  });
  it("adaptive interval: low remaining quota stretches polling beyond server interval", async () => {
    const quota = new QuotaTracker(1000, () => Date.now());
    quota.spend(990); // 2 calls left
    const { c, api } = setup({ quota });
    api.script = [{ items: [], nextPageToken: "a", pollingIntervalMillis: 1000 }];
    c.connect(); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls).toHaveLength(1);
  });
  it("writes consume quota and fail when exhausted", async () => {
    const quota = new QuotaTracker(25, () => Date.now());
    const { c, api } = setup({ quota, canWrite: true });
    await c.send("hello");
    expect(api.inserts).toEqual(["hello"]);
    await expect(c.send("again")).rejects.toThrow(/quota/);
  });
});

describe("stream mode", () => {
  it("consumes streamList pages, falls back to polling on failure", async () => {
    const api = new MockApi();
    let streamCalls = 0;
    api.streamList = async function* () {
      streamCalls++;
      yield { items: [txt("s1", "via stream")], nextPageToken: "z" };
      throw new Error("stream broke");
    };
    const { c, msgs } = setup({ api, preferStream: true, replayBacklog: true });
    api.script = [{ items: [txt("p1", "via poll")], nextPageToken: "q", pollingIntervalMillis: 1000 }];
    c.connect(); await vi.advanceTimersByTimeAsync(1);
    expect(msgs.map((m) => m.id)).toEqual(["s1"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(streamCalls).toBe(1);
    expect(msgs.map((m) => m.id)).toContain("p1");
  });
});

describe("write side", () => {
  it("read-only without canWrite", async () => {
    const { c } = setup();
    await expect(c.send("x")).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(c.deleteMessage("x")).rejects.toBeInstanceOf(ReadOnlyError);
  });
  it("bans/timeouts need approval", async () => {
    const { c, api } = setup({ canWrite: true });
    const t = c.requestTimeout("UCx", 300);
    const b = c.requestBan("UCy");
    await expect(c.executeProposal(t.id)).rejects.toBeInstanceOf(NotApprovedError);
    expect(api.bans).toHaveLength(0);
    c.proposalStore.approve(t.id); c.proposalStore.approve(b.id);
    await c.executeProposal(t.id); await c.executeProposal(b.id);
    expect(api.bans).toEqual([["LC", "UCx", 300], ["LC", "UCy", undefined]]);
    await c.deleteMessage("m");
    expect(api.removes).toEqual(["m"]);
  });
  it("rate limits sends", async () => {
    const { c } = setup({ canWrite: true, sendLimit: { count: 1, perMs: 30000 } });
    await c.send("a");
    await expect(c.send("b")).rejects.toThrow(/rate limited/);
  });
});

describe("fetch api", () => {
  it("sends bearer token, maps errors, never puts token in URL", async () => {
    const seen: { url: string; init: any }[] = [];
    const f = (async (url: string, init: any) => {
      seen.push({ url, init });
      if (seen.length === 2) return new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), { status: 403 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createFetchYouTubeApi({ fetch: f, getAccessToken: () => "TOK" });
    await api.list({ liveChatId: "LC", pageToken: "pp" });
    expect(seen[0]!.url).toContain("liveChatId=LC");
    expect(seen[0]!.url).not.toContain("TOK");
    expect(seen[0]!.init.headers.authorization).toBe("Bearer TOK");
    await expect(api.list({ liveChatId: "LC" })).rejects.toMatchObject({ reason: "quotaExceeded", status: 403 });
  });
});
