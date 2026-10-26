#!/usr/bin/env node
// Deterministically generates qa/fixtures/*. `--check` verifies the committed files are current.
//
// NORMATIVE SOURCE for the wire layout: daemon/PROTOCOL.md (when it exists) and
// daemon/src/framing.zig. This generator encodes that layout independently (it must NOT import
// daemon or studio code) so both sides are tested against the same bytes.
//
// Layout (browser -> daemon), big-endian, one WebSocket binary message == one frame:
//   0  u8   kind        0x01 start 0x02 stop 0x03 clip 0x10 video_config 0x11 audio_config
//                       0x12 video_chunk 0x13 audio_chunk (0x80 status is daemon->browser)
//   1  u8   flags       bit0 = keyframe
//   2  u32  dts_ms
//   6  i32  cts_offset_ms
//   10 ..   payload
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../lib/prng.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const check = process.argv.includes("--check");
const out = new Map(); // relative path -> string

const hex = (b) => Buffer.from(b).toString("hex");
const KIND = { start: 0x01, stop: 0x02, clip: 0x03, video_config: 0x10, audio_config: 0x11, video_chunk: 0x12, audio_chunk: 0x13 };

function frame(kind, flags, dts, cts, payload) {
  const h = Buffer.alloc(10);
  h[0] = KIND[kind]; h[1] = flags; h.writeUInt32BE(dts, 2); h.writeInt32BE(cts, 6);
  return Buffer.concat([h, Buffer.from(payload)]);
}

const startJson = Buffer.from(JSON.stringify({ destinations: ["twitch", "youtube"], width: 1280, height: 720, fps: 30, video_kbps: 2500, audio_kbps: 128, sample_rate: 48000, channels: 2 }));
const avcC = Buffer.from("014d401fffe100096742401fda014016e4e", "hex"); // shape-valid fake record (version=1)
const asc = Buffer.from("1190", "hex"); // AAC-LC, 48 kHz, stereo
const nal = (n, body) => Buffer.concat([Buffer.from([0, 0, 0, body.length + 1, n]), Buffer.from(body)]);
const idr = nal(0x65, [1, 2, 3, 4, 5, 6, 7, 8]);
const pframe = nal(0x41, [9, 8, 7, 6]);
const aac = (n) => Buffer.from(Array.from({ length: 6 }, (_, i) => (n * 7 + i) & 0xff));

// Ordered canonical session. `flv` is the FLV tag the daemon must emit for that frame.
const session = [
  { name: "start", frame: frame("start", 0, 0, 0, startJson), flv: null },
  { name: "video_config", frame: frame("video_config", 0, 0, 0, avcC), flv: { tag: 9, ts: 0, body: Buffer.concat([Buffer.from("1700000000", "hex"), avcC]) } },
  { name: "audio_config", frame: frame("audio_config", 0, 0, 0, asc), flv: { tag: 8, ts: 0, body: Buffer.concat([Buffer.from("af00", "hex"), asc]) } },
  { name: "video_key", frame: frame("video_chunk", 1, 0, 40, idr), flv: { tag: 9, ts: 0, body: Buffer.concat([Buffer.from("1701000028", "hex"), idr]) } },
  { name: "audio_1", frame: frame("audio_chunk", 0, 0, 0, aac(1)), flv: { tag: 8, ts: 0, body: Buffer.concat([Buffer.from("af01", "hex"), aac(1)]) } },
  { name: "video_p", frame: frame("video_chunk", 0, 33, 40, pframe), flv: { tag: 9, ts: 33, body: Buffer.concat([Buffer.from("2701000028", "hex"), pframe]) } },
  { name: "audio_2", frame: frame("audio_chunk", 0, 21, 0, aac(2)), flv: { tag: 8, ts: 21, body: Buffer.concat([Buffer.from("af01", "hex"), aac(2)]) } },
  { name: "video_p_negcts", frame: frame("video_chunk", 0, 66, -2, pframe), flv: { tag: 9, ts: 66, body: Buffer.concat([Buffer.from("2701fffffe", "hex"), pframe]) } },
  { name: "clip", frame: frame("clip", 0, 80, 0, Buffer.from(JSON.stringify({ seconds_back: 30, title: "t" }))), flv: null },
  { name: "stop", frame: frame("stop", 0, 99, 0, []), flv: null },
];

const valid = session.map((s) => {
  const b = s.frame;
  return {
    name: s.name, bytes: hex(b), kind: b[0], flags: b[1], dts_ms: b.readUInt32BE(2), cts_offset_ms: b.readInt32BE(6),
    payload: hex(b.subarray(10)),
    flv: s.flv && { tag_type: s.flv.tag, timestamp_ms: s.flv.ts, body: hex(s.flv.body) },
  };
});
// Edge values
const edge = [
  { name: "dts_max", b: frame("audio_chunk", 0, 0xffffffff, 0, [1]) },
  { name: "cts_min", b: frame("video_chunk", 1, 1, -0x80000000, [1]) },
  { name: "cts_max", b: frame("video_chunk", 1, 1, 0x7fffffff, [1]) },
  { name: "flags_unknown_bits", b: frame("audio_chunk", 0xfe, 5, 0, [1]) },
  { name: "stop_with_payload", b: frame("stop", 0, 0, 0, [1, 2]) },
];
for (const e of edge) valid.push({ name: e.name, bytes: hex(e.b), kind: e.b[0], flags: e.b[1], dts_ms: e.b.readUInt32BE(2), cts_offset_ms: e.b.readInt32BE(6), payload: hex(e.b.subarray(10)), flv: null });

const invalid = [
  { name: "empty", bytes: "", error: "Truncated" },
  { name: "one_byte", bytes: "12", error: "Truncated" },
  { name: "nine_bytes", bytes: "120000000000000000", error: "Truncated" },
  { name: "unknown_kind_0x77", bytes: hex(Buffer.concat([Buffer.from("77", "hex"), Buffer.alloc(9), Buffer.from([1])])), error: "UnknownKind" },
  { name: "kind_status_from_browser", bytes: hex(Buffer.concat([Buffer.from("80", "hex"), Buffer.alloc(9), Buffer.from([1])])), error: "UnknownKind" },
  { name: "kind_zero", bytes: hex(Buffer.concat([Buffer.alloc(10), Buffer.from([1])])), error: "UnknownKind" },
  { name: "video_chunk_empty_payload", bytes: hex(frame("video_chunk", 1, 0, 0, [])), error: "BadPayload" },
  { name: "audio_chunk_empty_payload", bytes: hex(frame("audio_chunk", 0, 0, 0, [])), error: "BadPayload" },
  { name: "video_config_empty_payload", bytes: hex(frame("video_config", 0, 0, 0, [])), error: "BadPayload" },
  { name: "audio_config_empty_payload", bytes: hex(frame("audio_config", 0, 0, 0, [])), error: "BadPayload" },
  { name: "clip_empty_payload", bytes: hex(frame("clip", 0, 0, 0, [])), error: "BadPayload" },
  { name: "start_empty_payload", bytes: hex(frame("start", 0, 0, 0, [])), error: "BadPayload" },
];

const golden = {
  _doc: "GENERATED by qa/tools/gen-fixtures.mjs. Do not edit. Layout: see header of that script and daemon/PROTOCOL.md.",
  header_len: 10,
  kinds: { ...KIND, status: 0x80 },
  flag_keyframe: 1,
  valid, invalid,
  start_json: JSON.parse(startJson.toString()),
};
out.set("protocol/golden.json", JSON.stringify(golden, null, 2) + "\n");
// line format for the Zig conformance tests
const lines = ["# generated; see golden.json"];
for (const v of valid) lines.push(`valid ${v.name} ${v.bytes} ${v.kind} ${v.flags} ${v.dts_ms} ${v.cts_offset_ms} ${v.payload || "-"}`);
for (const v of valid) if (v.flv) lines.push(`flv ${v.name} ${v.flv.tag_type} ${v.flv.timestamp_ms} ${v.flv.body}`);
for (const v of invalid) lines.push(`invalid ${v.name} ${v.bytes || "-"} ${v.error}`);
out.set("protocol/golden.txt", lines.join("\n") + "\n");

// ---------- chat fixtures (recorded-style, deterministic) ----------
const EMOTES = ["KEKW", "LUL", "Pog", "PogChamp", "GG", "F", "W", "o7", "OMEGALUL", "<3"];
const PT = ["que jogada!", "primeira vez aqui, salve", "qual o seu setup?", "manda o link do discord", "ta lagando aqui", "boa noite chat", "faz o clip disso", "mutou o mic?", "hoje tem sorteio?", "audio ta baixo"];
const EN = ["first time here", "what's your keyboard?", "nice play", "audio is too low", "can you do a giveaway", "clip that", "stream is lagging", "hello from Brazil", "what song is this?", "how long have you been streaming"];
const NAMES = Array.from({ length: 60 }, (_, i) => `viewer${String(i).padStart(2, "0")}`);

function makeChat(seed, n, mix) {
  const r = mulberry32(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const msgs = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    ts += Math.floor(r() * 2500);
    const roll = r();
    let text;
    if (roll < mix.emote) text = pick(EMOTES) + (r() < 0.3 ? ` ${pick(EMOTES)}` : "");
    else if (roll < mix.emote + mix.repeat) text = pick(r() < 0.5 ? PT : EN);
    else text = `${pick(r() < 0.5 ? PT : EN)} #${Math.floor(r() * 1000)} ${"!".repeat(Math.floor(r() * 4))}`.trim();
    msgs.push({ id: String(i + 1), ts, platform: r() < 0.6 ? "twitch" : "youtube", user: pick(NAMES), text });
  }
  return msgs;
}
const chats = {
  hype: makeChat(101, 600, { emote: 0.6, repeat: 0.25 }),
  qna: makeChat(202, 400, { emote: 0.1, repeat: 0.3 }),
  quiet: makeChat(303, 60, { emote: 0.15, repeat: 0.1 }),
};
for (const [k, v] of Object.entries(chats)) out.set(`chat/${k}.json`, JSON.stringify(v) + "\n");

// Tool-output style payloads (what the agent *consumes*): stream-health snapshots.
const r2 = mulberry32(404);
const health = Array.from({ length: 120 }, (_, i) => ({
  id: `s${i % 6}`, name: `source-${i % 6}`, kbps: 2400 + Math.floor(r2() * 200), dropped: Math.floor(r2() * 3), fps: 30,
  state: "live", description: "", tags: [], extra: null,
}));
out.set("chat/health.json", JSON.stringify(health) + "\n");

// Router workload: recorded-style agent requests (text + context size + tools).
{
  const r = mulberry32(505);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const simple = ["oi", "obrigado!", "hello", "ok", "sim", "classify this message as spam or not: buy followers now", "translate to english: boa noite chat", "extract the username from: @viewer12 said hi", "thanks"];
  const medium = ["reply to the chat question about the keyboard", "write a short shoutout for the new follower viewer07", "what is the current scene and who is on camera right now, in two sentences", "suggest a poll about the next game, 3 options"];
  const complex = ["analyze why the bitrate dropped during the last ten minutes and plan a fix", "plan the schedule for tomorrow's stream and compare the three sponsor offers", "debug why the youtube destination keeps reconnecting and explain the cause", "design an overlay layout strategy for the charity event"];
  const reqs = Array.from({ length: 300 }, () => {
    const roll = r();
    if (roll < 0.62) return { text: pick(simple), toolCount: 0, contextTokens: 300 + Math.floor(r() * 1500) };
    if (roll < 0.9) return { text: pick(medium) + " " + "context ".repeat(Math.floor(r() * 40)), toolCount: Math.floor(r() * 3), contextTokens: 2000 + Math.floor(r() * 6000) };
    return { text: pick(complex) + " " + "details ".repeat(Math.floor(r() * 80)), toolCount: 3 + Math.floor(r() * 3), contextTokens: 8000 + Math.floor(r() * 20000) };
  });
  out.set("chat/router_requests.json", JSON.stringify(reqs) + "\n");
}

let bad = 0;
for (const [rel, content] of out) {
  const p = join(root, rel);
  if (check) {
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) { console.error(`STALE fixture: ${rel} (run: make fixtures)`); bad++; }
  } else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); }
}
if (bad) process.exit(1);
console.log(check ? `fixtures up to date (${out.size} files)` : `wrote ${out.size} fixture files`);
