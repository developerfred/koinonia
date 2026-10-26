import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockSocket } from "../src/transport.js";
import { TwitchConnector, parseIrc, toChatMessage } from "../src/twitch.js";
import type { TwitchModerationApi } from "../src/twitch.js";
import { NotApprovedError, ReadOnlyError, UnsupportedError } from "../src/types.js";
import type { ChatMessage, ConnectorEvent } from "../src/types.js";

const PRIV = "@badge-info=subscriber/8;badges=broadcaster/1,subscriber/6;display-name=Ana;emotes=25:0-4,12-16/1902:6-10;id=m1;tmi-sent-ts=1700000000000;user-id=42 :ana!ana@ana.tmi.twitch.tv PRIVMSG #chan :Kappa Keepo Kappa";

function setup(opts: Partial<ConstructorParameters<typeof TwitchConnector>[0]> = {}) {
  const socks: MockSocket[] = [];
  const logs: string[] = [];
  const c = new TwitchConnector({
    channel: "Chan", rng: () => 0.5,
    createSocket: (u) => { const s = new MockSocket(u); socks.push(s); return s; },
    logger: { debug: (m, f) => logs.push(m + JSON.stringify(f ?? {})), info: (m, f) => logs.push(m + JSON.stringify(f ?? {})), warn: (m, f) => logs.push(m + JSON.stringify(f ?? {})), error: (m, f) => logs.push(m + JSON.stringify(f ?? {})) },
    ...opts,
  });
  const msgs: ChatMessage[] = [], evs: ConnectorEvent[] = [];
  c.onMessage((m) => msgs.push(m)); c.onEvent((e) => evs.push(e));
  return { c, socks, msgs, evs, logs };
}
async function welcome(s: MockSocket) { s.serverOpen(); await Promise.resolve(); await Promise.resolve(); s.serverSend(":tmi.twitch.tv 001 nick :Welcome\r\n"); }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("parseIrc", () => {
  it("parses tags, prefix, trailing, and escapes", () => {
    const m = parseIrc("@a=b\\sc;x=;flag :nick!u@h PRIVMSG #c :hello :world")!;
    expect(m.tags).toEqual({ a: "b c", x: "", flag: "" });
    expect(m.prefix).toBe("nick!u@h");
    expect(m.params).toEqual(["#c", "hello :world"]);
    expect(parseIrc("PING :tmi.twitch.tv")!.params).toEqual(["tmi.twitch.tv"]);
    expect(parseIrc("")).toBeNull();
    expect(parseIrc("@only")).toBeNull();
  });
});

describe("normalization", () => {
  it("maps badges, emotes, ts, user", () => {
    const m = toChatMessage(parseIrc(PRIV)!, 1)!;
    expect(m.ts).toBe(1700000000000);
    expect(m.user).toEqual({ id: "42", login: "ana", name: "Ana" });
    expect(m.badges.map((b) => b.kind)).toEqual(["broadcaster", "subscriber"]);
    expect(m.emotes.map((e) => [e.id, e.name, e.start, e.end])).toEqual([["25", "Kappa", 0, 5], ["1902", "Keepo", 6, 11], ["25", "Kappa", 12, 17]]);
  });
  it("handles /me and shifts emote offsets", () => {
    const line = "@id=a1;emotes=25:8-12;user-id=1 :u!u@u PRIVMSG #c :\x01ACTION Kappa hi\x01";
    const m = toChatMessage(parseIrc(line)!, 0)!;
    expect(m.kind).toBe("action");
    expect(m.text).toBe("Kappa hi");
    expect(m.emotes[0]).toMatchObject({ name: "Kappa", start: 0, end: 5 });
  });
  it("drops out-of-range emotes and sanitizes text", () => {
    const m = toChatMessage(parseIrc("@id=z;emotes=9:50-60 :u!u@u PRIVMSG #c :hi‮ there")!, 0)!;
    expect(m.emotes).toEqual([]);
    expect(m.text).toBe("hi  there");
  });
  it("returns null without id or non-PRIVMSG", () => {
    expect(toChatMessage(parseIrc(":u!u@u PRIVMSG #c :x")!, 0)).toBeNull();
    expect(toChatMessage(parseIrc("PING :x")!, 0)).toBeNull();
  });
});

describe("TwitchConnector anonymous", () => {
  it("handshakes anonymously, joins, delivers, dedupes, answers PING", async () => {
    const { c, socks, msgs } = setup();
    const p = c.connect();
    const s = socks[0]!;
    expect(s.url).toBe("wss://irc-ws.chat.twitch.tv:443");
    await welcome(s);
    await p;
    expect(s.sent[0]).toMatch(/^CAP REQ :twitch.tv\/tags/);
    expect(s.sent[1]).toBe("PASS SCHMOOPIIE");
    expect(s.sent[2]).toMatch(/^NICK justinfan\d+$/);
    expect(s.sent).toContain("JOIN #chan");
    s.serverSend(PRIV + "\r\n" + PRIV + "\r\n");
    s.serverSend("PING :tmi.twitch.tv\r\n");
    expect(msgs).toHaveLength(1);
    expect(s.sent).toContain("PONG :tmi.twitch.tv");
    expect(c.state).toBe("connected");
  });
  it("is read-only", async () => {
    const { c, socks } = setup();
    const p = c.connect(); await welcome(socks[0]!); await p;
    await expect(c.send("hi")).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(c.deleteMessage("x")).rejects.toBeInstanceOf(ReadOnlyError);
  });
  it("rejects invalid channel names", () => {
    expect(() => setup({ channel: "bad name\r\nJOIN #x" })).toThrow();
  });
});

describe("TwitchConnector authenticated", () => {
  const auth = { login: "Bot", getToken: () => "supersecrettoken" };
  it("uses oauth PASS, never logs the token, rate limits sends", async () => {
    const { c, socks, logs } = setup({ auth, sendLimit: { count: 2, perMs: 30000 } });
    const p = c.connect(); await welcome(socks[0]!); await p;
    const s = socks[0]!;
    expect(s.sent).toContain("PASS oauth:supersecrettoken");
    expect(s.sent).toContain("NICK bot");
    await c.send("hello\r\nPRIVMSG #evil :x");
    expect(s.sent.at(-1)).toBe("PRIVMSG #chan :hello PRIVMSG #evil :x");
    await c.send("two");
    await expect(c.send("three")).rejects.toThrow(/rate limited/);
    vi.advanceTimersByTime(15000);
    await c.send("four");
    expect(logs.join("\n")).not.toContain("supersecrettoken");
  });
  it("fails fatally on auth failure with no reconnect", async () => {
    const { c, socks, evs } = setup({ auth });
    const p = c.connect(); const s = socks[0]!;
    s.serverOpen(); await Promise.resolve(); await Promise.resolve();
    s.serverSend(":tmi.twitch.tv NOTICE * :Login authentication failed\r\n");
    await expect(p).rejects.toThrow(/authentication/);
    await vi.advanceTimersByTimeAsync(120000);
    expect(socks).toHaveLength(1);
    expect(c.state).toBe("failed");
    expect(evs.some((e) => e.type === "error" && e.code === "auth-failed")).toBe(true);
  });
  it("moderation: only proposals; execution needs approval and Helix", async () => {
    const calls: string[] = [];
    const moderation: TwitchModerationApi = {
      deleteMessage: async (id) => { calls.push("del " + id); },
      timeout: async (u, d) => { calls.push(`timeout ${u} ${d}`); },
      ban: async (u) => { calls.push("ban " + u); },
    };
    const { c, socks } = setup({ auth, moderation });
    const p = c.connect(); await welcome(socks[0]!); await p;
    const prop = c.requestTimeout("42", 600, "spam");
    expect(prop.status).toBe("pending");
    expect(calls).toEqual([]);
    await expect(c.executeProposal(prop.id)).rejects.toBeInstanceOf(NotApprovedError);
    c.proposalStore.approve(prop.id);
    await c.executeProposal(prop.id);
    expect(calls).toEqual(["timeout 42 600"]);
    await expect(c.executeProposal(prop.id)).rejects.toBeInstanceOf(NotApprovedError);
    const b = c.requestBan("9");
    c.proposalStore.approve(b.id);
    await c.executeProposal(b.id);
    await c.deleteMessage("m1");
    expect(calls).toEqual(["timeout 42 600", "ban 9", "del m1"]);
  });
  it("moderation without API is unsupported", async () => {
    const { c, socks } = setup({ auth });
    const p = c.connect(); await welcome(socks[0]!); await p;
    await expect(c.deleteMessage("x")).rejects.toBeInstanceOf(UnsupportedError);
  });
});

describe("TwitchConnector reconnection", () => {
  it("reconnects with growing jittered backoff after drops, resets after success", async () => {
    const { c, socks, evs } = setup();
    const p = c.connect(); await welcome(socks[0]!); await p;
    socks[0]!.serverClose();
    expect(c.state).toBe("reconnecting");
    // rng .5, base 1000: attempt0 delay = 500 + .5*500 = 750
    await vi.advanceTimersByTimeAsync(749);
    expect(socks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(socks).toHaveLength(2);
    // fail again before welcome: attempt1 => 500 + .5*1500 = 1250
    socks[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(1249);
    expect(socks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(socks).toHaveLength(3);
    await welcome(socks[2]!);
    expect(c.state).toBe("connected");
    socks[2]!.serverClose();
    await vi.advanceTimersByTimeAsync(751); // reset to attempt 0
    expect(socks).toHaveLength(4);
    expect(evs.filter((e) => e.type === "state" && e.state === "reconnecting").length).toBeGreaterThanOrEqual(2);
  });
  it("honors RECONNECT immediately and re-JOINs", async () => {
    const { c, socks, msgs } = setup();
    const p = c.connect(); await welcome(socks[0]!); await p;
    socks[0]!.serverSend(":tmi.twitch.tv RECONNECT\r\n");
    expect(socks).toHaveLength(2);
    expect(socks[0]!.closed).toBe(true);
    await welcome(socks[1]!);
    expect(socks[1]!.sent).toContain("JOIN #chan");
    socks[1]!.serverSend(PRIV + "\r\n");
    expect(msgs).toHaveLength(1);
    // late events from the old socket are ignored
    socks[0]!.serverSend(PRIV.replace("id=m1", "id=m2") + "\r\n");
    expect(msgs).toHaveLength(1);
  });
  it("dedupes replayed messages across reconnects", async () => {
    const { c, socks, msgs } = setup();
    const p = c.connect(); await welcome(socks[0]!); await p;
    socks[0]!.serverSend(PRIV + "\r\n");
    socks[0]!.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    await welcome(socks[1]!);
    socks[1]!.serverSend(PRIV + "\r\n");
    expect(msgs).toHaveLength(1);
  });
  it("disconnect cancels pending reconnect", async () => {
    const { c, socks } = setup();
    const p = c.connect(); await welcome(socks[0]!); await p;
    socks[0]!.serverClose();
    await c.disconnect();
    await vi.advanceTimersByTimeAsync(100000);
    expect(socks).toHaveLength(1);
    expect(c.state).toBe("disconnected");
  });
  it("retries when the socket factory throws", async () => {
    let n = 0; const socks: MockSocket[] = [];
    const c = new TwitchConnector({ channel: "chan", rng: () => 0, createSocket: (u) => { if (n++ === 0) throw new Error("dns"); const s = new MockSocket(u); socks.push(s); return s; } });
    const p = c.connect();
    await vi.advanceTimersByTimeAsync(600);
    await welcome(socks[0]!);
    await p;
    expect(c.state).toBe("connected");
  });
});

describe("events", () => {
  it("emits deletions and clears", async () => {
    const { c, socks, evs } = setup();
    const p = c.connect(); await welcome(socks[0]!); await p;
    socks[0]!.serverSend("@login=x;target-msg-id=m9 :tmi.twitch.tv CLEARMSG #chan :gone\r\n");
    socks[0]!.serverSend("@ban-duration=600;target-user-id=7 :tmi.twitch.tv CLEARCHAT #chan :u\r\n");
    socks[0]!.serverSend("@target-user-id=8 :tmi.twitch.tv CLEARCHAT #chan :u\r\n");
    expect(evs).toContainEqual({ type: "message-deleted", platform: "twitch", id: "m9" });
    expect(evs).toContainEqual({ type: "user-cleared", platform: "twitch", userId: "7", durationSec: 600 });
    expect(evs).toContainEqual({ type: "user-cleared", platform: "twitch", userId: "8", durationSec: undefined });
  });
  it("a throwing subscriber does not break delivery", async () => {
    const { c, socks, msgs } = setup();
    c.onMessage(() => { throw new Error("boom"); });
    const p = c.connect(); await welcome(socks[0]!); await p;
    socks[0]!.serverSend(PRIV + "\r\n");
    expect(msgs).toHaveLength(1);
  });
});
