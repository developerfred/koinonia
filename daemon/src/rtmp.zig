//! RTMP publisher protocol: URL parsing, simple handshake, chunk stream writer/reader,
//! connect / createStream / publish command flow, and audio/video/data message sending.
//! Transport-agnostic: works over any `std.Io.Reader`/`std.Io.Writer` pair (TCP or TLS).

const std = @import("std");
const amf0 = @import("amf0.zig");
const flv = @import("flv.zig");
const Reader = std.Io.Reader;
const Writer = std.Io.Writer;

pub const MsgType = struct {
    pub const set_chunk_size: u8 = 1;
    pub const abort: u8 = 2;
    pub const ack: u8 = 3;
    pub const user_control: u8 = 4;
    pub const window_ack_size: u8 = 5;
    pub const set_peer_bandwidth: u8 = 6;
    pub const audio: u8 = 8;
    pub const video: u8 = 9;
    pub const data_amf0: u8 = 18;
    pub const command_amf0: u8 = 20;
};

/// Chunk stream ids we use for outgoing messages.
pub const Csid = struct {
    pub const control: u32 = 2;
    pub const command: u32 = 3;
    pub const stream_cmd: u32 = 4;
    pub const audio: u32 = 6;
    pub const video: u32 = 7;
    pub const data: u32 = 8;
};

pub const our_chunk_size: u32 = 4096;
pub const handshake_len = 1536;

// ---------------------------------------------------------------------------------------------
// URL

pub const Url = struct {
    tls: bool,
    host: []const u8,
    port: u16,
    /// Application path without leading slash, e.g. "app" or "live2".
    app: []const u8,

    pub const Error = error{ BadScheme, BadUrl, BadPort };

    /// Parse `rtmp://host[:port]/app[/...]` or `rtmps://...`. Slices alias `s`.
    pub fn parse(s: []const u8) Error!Url {
        var rest: []const u8 = undefined;
        var tls = false;
        if (std.mem.startsWith(u8, s, "rtmps://")) {
            tls = true;
            rest = s["rtmps://".len..];
        } else if (std.mem.startsWith(u8, s, "rtmp://")) {
            rest = s["rtmp://".len..];
        } else return error.BadScheme;
        const slash = std.mem.indexOfScalar(u8, rest, '/') orelse return error.BadUrl;
        const authority = rest[0..slash];
        const app = std.mem.trim(u8, rest[slash + 1 ..], "/");
        if (authority.len == 0 or app.len == 0) return error.BadUrl;
        var host = authority;
        var port: u16 = if (tls) 443 else 1935;
        if (std.mem.lastIndexOfScalar(u8, authority, ':')) |c| {
            if (std.mem.indexOfScalar(u8, authority, ']') == null or c > std.mem.indexOfScalar(u8, authority, ']').?) {
                host = authority[0..c];
                port = std.fmt.parseInt(u16, authority[c + 1 ..], 10) catch return error.BadPort;
            }
        }
        if (host.len == 0) return error.BadUrl;
        return .{ .tls = tls, .host = host, .port = port, .app = app };
    }

    /// tcUrl sent in `connect`, e.g. "rtmps://live.twitch.tv:443/app".
    pub fn tcUrl(u: Url, w: *Writer) Writer.Error!void {
        try w.print("{s}://{s}:{d}/{s}", .{ if (u.tls) "rtmps" else "rtmp", u.host, u.port, u.app });
    }
};

// ---------------------------------------------------------------------------------------------
// Chunk writer

pub const ChunkWriter = struct {
    out: *Writer,
    chunk_size: u32 = 128,
    states: [64]State = @splat(.{}),

    const State = struct {
        valid: bool = false,
        ts: u32 = 0,
        len: u32 = 0,
        mtype: u8 = 0,
        sid: u32 = 0,
    };

    pub fn init(out: *Writer) ChunkWriter {
        return .{ .out = out };
    }

    /// Send one message whose payload is `head ++ data`. Does not flush.
    pub fn send(
        cw: *ChunkWriter,
        csid: u32,
        mtype: u8,
        stream_id: u32,
        ts: u32,
        head: []const u8,
        data: []const u8,
    ) Writer.Error!void {
        std.debug.assert(csid >= 2 and csid < 64);
        const total: u32 = @intCast(head.len + data.len);
        const st = &cw.states[csid];
        const w = cw.out;

        const use_delta = st.valid and st.sid == stream_id and ts >= st.ts;
        const field: u32 = if (use_delta) ts - st.ts else ts;
        const ext = field >= 0xFFFFFF;
        const fmt: u8 = if (use_delta) 1 else 0;

        try w.writeByte((fmt << 6) | @as(u8, @intCast(csid)));
        try w.writeInt(u24, if (ext) 0xFFFFFF else @intCast(field), .big);
        try w.writeInt(u24, @intCast(total), .big);
        try w.writeByte(mtype);
        if (fmt == 0) try w.writeInt(u32, stream_id, .little);
        if (ext) try w.writeInt(u32, field, .big);

        st.* = .{ .valid = true, .ts = ts, .len = total, .mtype = mtype, .sid = stream_id };

        var pos: usize = 0;
        while (pos < total) {
            if (pos != 0) {
                try w.writeByte((3 << 6) | @as(u8, @intCast(csid)));
                if (ext) try w.writeInt(u32, field, .big);
            }
            const n = @min(cw.chunk_size, total - pos);
            try writeRange(w, head, data, pos, n);
            pos += n;
        }
    }

    fn writeRange(w: *Writer, head: []const u8, data: []const u8, pos: usize, n: usize) Writer.Error!void {
        var p = pos;
        var left = n;
        if (p < head.len) {
            const k = @min(left, head.len - p);
            try w.writeAll(head[p..][0..k]);
            p += k;
            left -= k;
        }
        if (left > 0) try w.writeAll(data[p - head.len ..][0..left]);
    }

    pub fn setChunkSize(cw: *ChunkWriter, size: u32) Writer.Error!void {
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, size, .big);
        try cw.send(Csid.control, MsgType.set_chunk_size, 0, 0, &b, &.{});
        cw.chunk_size = size;
    }
};

// ---------------------------------------------------------------------------------------------
// Chunk reader

pub const Message = struct {
    mtype: u8,
    stream_id: u32,
    ts: u32,
    /// Valid until the next `readMessage` call.
    payload: []const u8,
};

pub const ChunkReader = struct {
    gpa: std.mem.Allocator,
    chunk_size: u32 = 128,
    /// Bytes consumed from the peer (for window acknowledgement accounting).
    bytes_in: u64 = 0,
    max_message: u32 = 1 << 20,
    pending_clear: ?u32 = null,
    slots: [64]Slot = @splat(.{}),

    const Slot = struct {
        ts: u32 = 0,
        delta: u32 = 0,
        len: u32 = 0,
        mtype: u8 = 0,
        sid: u32 = 0,
        ext: bool = false,
        buf: std.ArrayList(u8) = .empty,
    };

    pub const Error = error{ ProtocolError, MessageTooLarge, OutOfMemory } || Reader.Error;

    pub fn init(gpa: std.mem.Allocator) ChunkReader {
        return .{ .gpa = gpa };
    }

    pub fn deinit(cr: *ChunkReader) void {
        for (&cr.slots) |*s| s.buf.deinit(cr.gpa);
    }

    /// Read chunks until one full message is assembled. Set Chunk Size is applied internally
    /// and still returned to the caller.
    pub fn readMessage(cr: *ChunkReader, r: *Reader) Error!Message {
        if (cr.pending_clear) |c| {
            cr.slots[c].buf.clearRetainingCapacity();
            cr.pending_clear = null;
        }
        while (true) {
            const b0 = try r.takeByte();
            cr.bytes_in += 1;
            const fmt: u8 = b0 >> 6;
            var csid: u32 = b0 & 0x3F;
            if (csid == 0) {
                csid = 64 + @as(u32, try r.takeByte());
                cr.bytes_in += 1;
            } else if (csid == 1) {
                const lo = try r.takeByte();
                const hi = try r.takeByte();
                csid = 64 + @as(u32, lo) + (@as(u32, hi) << 8);
                cr.bytes_in += 2;
            }
            if (csid >= cr.slots.len) return error.ProtocolError;
            const s = &cr.slots[csid];
            const starting = s.buf.items.len == 0;

            var ts_field: u32 = 0;
            if (fmt <= 2) {
                ts_field = try r.takeInt(u24, .big);
                cr.bytes_in += 3;
            }
            if (fmt <= 1) {
                s.len = try r.takeInt(u24, .big);
                s.mtype = try r.takeByte();
                cr.bytes_in += 4;
            }
            if (fmt == 0) {
                s.sid = try r.takeInt(u32, .little);
                cr.bytes_in += 4;
            }
            if (fmt <= 2) s.ext = ts_field == 0xFFFFFF;
            if (s.ext) {
                ts_field = try r.takeInt(u32, .big);
                cr.bytes_in += 4;
            }
            if (fmt == 0) {
                s.ts = ts_field;
                s.delta = 0;
            } else if (fmt <= 2) {
                s.delta = ts_field;
            }
            if (starting and fmt != 0) s.ts +%= s.delta;

            if (s.len > cr.max_message) return error.MessageTooLarge;
            const have: u32 = @intCast(s.buf.items.len);
            if (have > s.len) return error.ProtocolError;
            const n = @min(cr.chunk_size, s.len - have);
            const dst = try s.buf.addManyAsSlice(cr.gpa, n);
            try r.readSliceAll(dst);
            cr.bytes_in += n;

            if (s.buf.items.len == s.len) {
                const msg: Message = .{ .mtype = s.mtype, .stream_id = s.sid, .ts = s.ts, .payload = s.buf.items };
                if (s.mtype == MsgType.set_chunk_size and s.len >= 4) {
                    cr.chunk_size = std.mem.readInt(u32, s.buf.items[0..4], .big) & 0x7FFFFFFF;
                    if (cr.chunk_size == 0) return error.ProtocolError;
                }
                // `payload` aliases the slot buffer, so it is cleared on the next call.
                cr.pending_clear = csid;
                return msg;
            }
        }
    }
};

// ---------------------------------------------------------------------------------------------
// Publisher

pub const PublishError = error{
    BadHandshake,
    ConnectRejected,
    CreateStreamFailed,
    PublishRejected,
    UnexpectedEnd,
} || ChunkReader.Error || Writer.Error;

pub const Publisher = struct {
    r: *Reader,
    w: *Writer,
    cw: ChunkWriter,
    cr: ChunkReader,
    stream_id: u32 = 0,
    /// Window ack accounting.
    peer_window: u32 = 0,
    last_ack: u64 = 0,

    pub fn init(gpa: std.mem.Allocator, r: *Reader, w: *Writer) Publisher {
        return .{ .r = r, .w = w, .cw = ChunkWriter.init(w), .cr = ChunkReader.init(gpa) };
    }

    pub fn deinit(p: *Publisher) void {
        p.cr.deinit();
    }

    /// Plain (unencrypted) RTMP handshake. `rand` supplies the 1528 random bytes of C1.
    pub fn handshake(p: *Publisher, rand: *const [handshake_len - 8]u8) PublishError!void {
        var c1: [handshake_len]u8 = undefined;
        @memset(c1[0..8], 0); // time = 0, zero = 0
        @memcpy(c1[8..], rand);
        try p.w.writeByte(3);
        try p.w.writeAll(&c1);
        try p.w.flush();

        const s0 = try p.r.takeByte();
        if (s0 != 3) return error.BadHandshake;
        var s1: [handshake_len]u8 = undefined;
        try p.r.readSliceAll(&s1);
        try p.w.writeAll(&s1); // C2 echoes S1
        try p.w.flush();
        var s2: [handshake_len]u8 = undefined;
        try p.r.readSliceAll(&s2);
        // S2 must echo C1 random data (bytes 8..).
        if (!std.mem.eql(u8, s2[8..], c1[8..])) return error.BadHandshake;
    }

    fn sendCommand(p: *Publisher, csid: u32, sid: u32, body: []const u8) Writer.Error!void {
        try p.cw.send(csid, MsgType.command_amf0, sid, 0, body, &.{});
        try p.w.flush();
    }

    /// Run handshake + connect + createStream + publish. Returns when the server accepted the
    /// publish (`NetStream.Publish.Start`). `key` is used only as the publish name; it is never
    /// logged or placed into error values.
    pub fn publish(p: *Publisher, url: Url, key: []const u8, rand: *const [handshake_len - 8]u8) PublishError!void {
        try p.handshake(rand);
        try p.cw.setChunkSize(our_chunk_size);

        var buf: [1024]u8 = undefined;
        var bw: Writer = .fixed(&buf);

        // connect
        try amf0.writeString(&bw, "connect");
        try amf0.writeNumber(&bw, 1);
        try amf0.objectBegin(&bw);
        try amf0.propString(&bw, "app", url.app);
        try amf0.propString(&bw, "type", "nonprivate");
        try amf0.propString(&bw, "flashVer", "FMLE/3.0 (compatible; koinonia-d)");
        try amf0.writeKey(&bw, "tcUrl");
        {
            var tmp: [256]u8 = undefined;
            var tw: Writer = .fixed(&tmp);
            try url.tcUrl(&tw);
            try amf0.writeString(&bw, tw.buffered());
        }
        try amf0.objectEnd(&bw);
        try p.sendCommand(Csid.command, 0, bw.buffered());
        _ = try p.waitResult(1, false);

        // releaseStream / FCPublish (fire and forget; Twitch/YouTube like them)
        bw = .fixed(&buf);
        try amf0.writeString(&bw, "releaseStream");
        try amf0.writeNumber(&bw, 2);
        try amf0.writeNull(&bw);
        try amf0.writeString(&bw, key);
        try p.sendCommand(Csid.command, 0, bw.buffered());
        bw = .fixed(&buf);
        try amf0.writeString(&bw, "FCPublish");
        try amf0.writeNumber(&bw, 3);
        try amf0.writeNull(&bw);
        try amf0.writeString(&bw, key);
        try p.sendCommand(Csid.command, 0, bw.buffered());

        // createStream
        bw = .fixed(&buf);
        try amf0.writeString(&bw, "createStream");
        try amf0.writeNumber(&bw, 4);
        try amf0.writeNull(&bw);
        try p.sendCommand(Csid.command, 0, bw.buffered());
        const res = try p.waitResult(4, true);
        p.stream_id = parseCreateStreamResult(res) orelse return error.CreateStreamFailed;

        // publish
        bw = .fixed(&buf);
        try amf0.writeString(&bw, "publish");
        try amf0.writeNumber(&bw, 0);
        try amf0.writeNull(&bw);
        try amf0.writeString(&bw, key);
        try amf0.writeString(&bw, "live");
        try p.sendCommand(Csid.stream_cmd, p.stream_id, bw.buffered());
        try p.waitPublishStart();
    }

    /// Wait for `_result` with the given transaction id. Returns the payload (valid until the
    /// next read). `_error` => `on_err`.
    fn waitResult(p: *Publisher, txn: u32, is_create: bool) PublishError![]const u8 {
        while (true) {
            const m = try p.nextMessage();
            if (m.mtype != MsgType.command_amf0) continue;
            const name = amf0.commandName(m.payload) orelse continue;
            const tx = commandTxn(m.payload) orelse continue;
            if (tx != @as(f64, @floatFromInt(txn))) continue;
            if (std.mem.eql(u8, name, "_result")) return m.payload;
            if (std.mem.eql(u8, name, "_error")) return if (is_create) error.CreateStreamFailed else error.ConnectRejected;
        }
    }

    fn waitPublishStart(p: *Publisher) PublishError!void {
        while (true) {
            const m = try p.nextMessage();
            if (m.mtype != MsgType.command_amf0) continue;
            const name = amf0.commandName(m.payload) orelse continue;
            if (!std.mem.eql(u8, name, "onStatus")) continue;
            const code = amf0.findStringProp(m.payload, "code") orelse continue;
            if (std.mem.eql(u8, code, "NetStream.Publish.Start")) return;
            if (std.mem.startsWith(u8, code, "NetStream.Publish.") or std.mem.startsWith(u8, code, "NetStream.Failed"))
                return error.PublishRejected;
        }
    }

    /// Read one message and handle protocol control messages (window ack size, ping).
    fn nextMessage(p: *Publisher) PublishError!Message {
        const m = try p.cr.readMessage(p.r);
        switch (m.mtype) {
            MsgType.window_ack_size => if (m.payload.len >= 4) {
                p.peer_window = std.mem.readInt(u32, m.payload[0..4], .big);
            },
            MsgType.user_control => {
                // PingRequest (6) -> PingResponse (7)
                if (m.payload.len >= 6 and std.mem.readInt(u16, m.payload[0..2], .big) == 6) {
                    var b: [6]u8 = undefined;
                    std.mem.writeInt(u16, b[0..2], 7, .big);
                    @memcpy(b[2..6], m.payload[2..6]);
                    try p.cw.send(Csid.control, MsgType.user_control, 0, 0, &b, &.{});
                    try p.w.flush();
                }
            },
            else => {},
        }
        return m;
    }

    /// Drain any control traffic already readable and ack if the peer window is exceeded.
    /// Call occasionally (only when a non-blocking read is possible) -- currently unused by the
    /// daemon; see PROTOCOL notes (stubbed).
    pub fn maybeAck(p: *Publisher) Writer.Error!void {
        if (p.peer_window == 0) return;
        if (p.cr.bytes_in - p.last_ack < p.peer_window / 2) return;
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @truncate(p.cr.bytes_in), .big);
        try p.cw.send(Csid.control, MsgType.ack, 0, 0, &b, &.{});
        try p.w.flush();
        p.last_ack = p.cr.bytes_in;
    }

    pub fn sendMetadata(p: *Publisher, meta: flv.Meta) Writer.Error!void {
        var buf: [512]u8 = undefined;
        var bw: Writer = .fixed(&buf);
        try amf0.writeString(&bw, "@setDataFrame");
        try flv.writeMetadataBody(&bw, meta);
        try p.cw.send(Csid.data, MsgType.data_amf0, p.stream_id, 0, bw.buffered(), &.{});
        try p.w.flush();
    }

    pub fn sendVideoConfig(p: *Publisher, ts: u32, avcc: []const u8) Writer.Error!void {
        const h = flv.videoHeader(true, .sequence_header, 0);
        try p.cw.send(Csid.video, MsgType.video, p.stream_id, ts, &h, avcc);
        try p.w.flush();
    }

    pub fn sendAudioConfig(p: *Publisher, ts: u32, asc: []const u8) Writer.Error!void {
        const h = flv.audioHeader(.sequence_header);
        try p.cw.send(Csid.audio, MsgType.audio, p.stream_id, ts, &h, asc);
        try p.w.flush();
    }

    pub fn sendVideo(p: *Publisher, ts: u32, keyframe: bool, cts: i32, avcc_nalus: []const u8) Writer.Error!void {
        const h = flv.videoHeader(keyframe, .nalu, cts);
        try p.cw.send(Csid.video, MsgType.video, p.stream_id, ts, &h, avcc_nalus);
        try p.w.flush();
    }

    pub fn sendAudio(p: *Publisher, ts: u32, raw_aac: []const u8) Writer.Error!void {
        const h = flv.audioHeader(.raw);
        try p.cw.send(Csid.audio, MsgType.audio, p.stream_id, ts, &h, raw_aac);
        try p.w.flush();
    }

    pub fn sendEndOfStream(p: *Publisher, ts: u32) Writer.Error!void {
        const h = flv.videoHeader(false, .end_of_sequence, 0);
        try p.cw.send(Csid.video, MsgType.video, p.stream_id, ts, &h, &.{});
        try p.w.flush();
    }
};

/// Transaction id (number following the command name), if present.
fn commandTxn(payload: []const u8) ?f64 {
    const l = std.mem.readInt(u16, payload[1..3], .big);
    const off = 3 + @as(usize, l);
    if (payload.len < off + 9 or payload[off] != amf0.Marker.number) return null;
    return @bitCast(std.mem.readInt(u64, payload[off + 1 ..][0..8], .big));
}

/// `_result`, txn, null, streamId
fn parseCreateStreamResult(payload: []const u8) ?u32 {
    const l = std.mem.readInt(u16, payload[1..3], .big);
    var off = 3 + @as(usize, l) + 9;
    if (payload.len < off + 1 or payload[off] != amf0.Marker.null_) return null;
    off += 1;
    if (payload.len < off + 9 or payload[off] != amf0.Marker.number) return null;
    const v: f64 = @bitCast(std.mem.readInt(u64, payload[off + 1 ..][0..8], .big));
    if (v < 0 or v > 1e9) return null;
    return @intFromFloat(v);
}

// ---------------------------------------------------------------------------------------------
// Tests

const testing = std.testing;

test "url parse" {
    const u = try Url.parse("rtmps://live.twitch.tv:443/app");
    try testing.expect(u.tls);
    try testing.expectEqualStrings("live.twitch.tv", u.host);
    try testing.expectEqual(@as(u16, 443), u.port);
    try testing.expectEqualStrings("app", u.app);
    const v = try Url.parse("rtmp://localhost/live/");
    try testing.expect(!v.tls);
    try testing.expectEqual(@as(u16, 1935), v.port);
    try testing.expectEqualStrings("live", v.app);
    const x = try Url.parse("rtmps://a.rtmps.youtube.com/live2");
    try testing.expectEqual(@as(u16, 443), x.port);
    try testing.expectError(error.BadScheme, Url.parse("http://x/y"));
    try testing.expectError(error.BadUrl, Url.parse("rtmp://x"));
    try testing.expectError(error.BadPort, Url.parse("rtmp://x:99999/a"));
    var buf: [64]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try x.tcUrl(&w);
    try testing.expectEqualStrings("rtmps://a.rtmps.youtube.com:443/live2", w.buffered());
}

test "chunk writer: fmt0 header bytes and payload" {
    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cw = ChunkWriter.init(&w);
    try cw.send(6, MsgType.audio, 1, 0x10, &.{0xAF}, &.{ 1, 2, 3 });
    const expect = [_]u8{
        0x06, // fmt0 csid 6
        0, 0, 0x10, // ts
        0, 0, 4, // len
        8, // type
        1, 0, 0, 0, // stream id LE
        0xAF, 1, 2, 3,
    };
    try testing.expectEqualSlices(u8, &expect, w.buffered());
}

test "chunk writer: second message uses fmt1 with delta" {
    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cw = ChunkWriter.init(&w);
    try cw.send(6, 8, 1, 100, &.{}, &.{9});
    const n = w.buffered().len;
    try cw.send(6, 8, 1, 123, &.{}, &.{ 7, 7 });
    const second = w.buffered()[n..];
    try testing.expectEqualSlices(u8, &.{ 0x46, 0, 0, 23, 0, 0, 2, 8, 7, 7 }, second);
}

test "chunk writer: splits at chunk size with fmt3 continuation" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cw = ChunkWriter.init(&w);
    var data: [300]u8 = undefined;
    for (&data, 0..) |*b, i| b.* = @truncate(i);
    try cw.send(7, MsgType.video, 1, 0, &.{}, &data);
    const out = w.buffered();
    // 12 byte header + 128 + 1 byte fmt3 header + 128 + 1 + 44
    try testing.expectEqual(@as(usize, 12 + 128 + 1 + 128 + 1 + 44), out.len);
    try testing.expectEqual(@as(u8, 0xC7), out[12 + 128]);
    try testing.expectEqual(@as(u8, 0xC7), out[12 + 128 + 1 + 128]);
    try testing.expectEqualSlices(u8, data[128..256], out[12 + 128 + 1 ..][0..128]);
}

test "chunk writer: extended timestamp repeated in continuation chunks" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cw = ChunkWriter.init(&w);
    const data: [200]u8 = @splat(0x55);
    try cw.send(7, MsgType.video, 1, 0x01000000, &.{}, &data);
    const out = w.buffered();
    try testing.expectEqualSlices(u8, &.{ 0xFF, 0xFF, 0xFF }, out[1..4]);
    try testing.expectEqualSlices(u8, &.{ 1, 0, 0, 0 }, out[12..16]);
    // after first chunk: 16 header + 128 data, then fmt3 byte + ext ts
    try testing.expectEqual(@as(u8, 0xC7), out[16 + 128]);
    try testing.expectEqualSlices(u8, &.{ 1, 0, 0, 0 }, out[16 + 128 + 1 ..][0..4]);
}

test "chunk reader round trip with chunk size change and interleaving" {
    var buf: [2048]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cw = ChunkWriter.init(&w);
    try cw.setChunkSize(64);
    var data: [200]u8 = undefined;
    for (&data, 0..) |*b, i| b.* = @truncate(i * 3);
    try cw.send(6, MsgType.audio, 1, 40, &.{0xAF}, &data);
    try cw.send(6, MsgType.audio, 1, 63, &.{0xAF}, data[0..10]);

    var r: Reader = .fixed(w.buffered());
    var cr = ChunkReader.init(testing.allocator);
    defer cr.deinit();
    const m0 = try cr.readMessage(&r);
    try testing.expectEqual(MsgType.set_chunk_size, m0.mtype);
    try testing.expectEqual(@as(u32, 64), cr.chunk_size);
    const m1 = try cr.readMessage(&r);
    try testing.expectEqual(MsgType.audio, m1.mtype);
    try testing.expectEqual(@as(u32, 1), m1.stream_id);
    try testing.expectEqual(@as(u32, 40), m1.ts);
    try testing.expectEqual(@as(usize, 201), m1.payload.len);
    try testing.expectEqualSlices(u8, &data, m1.payload[1..]);
    const m2 = try cr.readMessage(&r);
    try testing.expectEqual(@as(u32, 63), m2.ts);
    try testing.expectEqual(@as(usize, 11), m2.payload.len);
    try testing.expectError(error.EndOfStream, cr.readMessage(&r));
}

/// Build a scripted server transcript for the publish flow.
fn scriptedServer(out: *Writer, c1_rand: *const [handshake_len - 8]u8, reject: bool) !void {
    // S0 S1 S2
    try out.writeByte(3);
    var s1: [handshake_len]u8 = undefined;
    @memset(&s1, 0x11);
    try out.writeAll(&s1);
    var s2: [handshake_len]u8 = @splat(0);
    @memcpy(s2[8..], c1_rand);
    try out.writeAll(&s2);

    var cw = ChunkWriter.init(out);
    var tmp: [256]u8 = undefined;
    // window ack size + chunk size
    try cw.send(2, MsgType.window_ack_size, 0, 0, &.{ 0, 0x26, 0x25, 0xA0 }, &.{});
    try cw.send(2, MsgType.set_chunk_size, 0, 0, &.{ 0, 0, 0x10, 0 }, &.{});
    // _result for connect
    var bw: Writer = .fixed(&tmp);
    try amf0.writeString(&bw, "_result");
    try amf0.writeNumber(&bw, 1);
    try amf0.writeNull(&bw);
    try cw.send(3, MsgType.command_amf0, 0, 0, bw.buffered(), &.{});
    // _result for createStream => stream id 1
    bw = .fixed(&tmp);
    try amf0.writeString(&bw, "_result");
    try amf0.writeNumber(&bw, 4);
    try amf0.writeNull(&bw);
    try amf0.writeNumber(&bw, 1);
    try cw.send(3, MsgType.command_amf0, 0, 0, bw.buffered(), &.{});
    // onStatus
    bw = .fixed(&tmp);
    try amf0.writeString(&bw, "onStatus");
    try amf0.writeNumber(&bw, 0);
    try amf0.writeNull(&bw);
    try amf0.objectBegin(&bw);
    try amf0.propString(&bw, "level", "status");
    try amf0.propString(&bw, "code", if (reject) "NetStream.Publish.BadName" else "NetStream.Publish.Start");
    try amf0.objectEnd(&bw);
    try cw.send(5, MsgType.command_amf0, 1, 0, bw.buffered(), &.{});
}

test "publisher flow against scripted server, then A/V messages" {
    const rand: [handshake_len - 8]u8 = @splat(0x42);
    var sbuf: [8192]u8 = undefined;
    var sw: Writer = .fixed(&sbuf);
    try scriptedServer(&sw, &rand, false);

    var cbuf: [16384]u8 = undefined;
    var cw: Writer = .fixed(&cbuf);
    var r: Reader = .fixed(sw.buffered());
    var p = Publisher.init(testing.allocator, &r, &cw);
    defer p.deinit();
    const url = try Url.parse("rtmp://example.invalid/app");
    try p.publish(url, "SECRETKEY", &rand);
    try testing.expectEqual(@as(u32, 1), p.stream_id);
    try testing.expectEqual(@as(u32, 0x2625A0), p.peer_window);
    // C0 + C1
    const out = cw.buffered();
    try testing.expectEqual(@as(u8, 3), out[0]);
    try testing.expectEqualSlices(u8, &rand, out[1 + 8 .. 1 + handshake_len]);
    // C2 echoes S1 (0x11 bytes)
    try testing.expectEqual(@as(u8, 0x11), out[1 + handshake_len]);

    const before = cw.buffered().len;
    try p.sendVideo(33, true, 0, &.{ 0, 0, 0, 1, 0x65 });
    try p.sendAudio(40, &.{ 0x21, 0x10 });
    const media = cw.buffered()[before..];
    // video: fmt0 csid7, ts 33, len 5+5, type 9, sid 1, body 0x17 01 000000 + nal
    try testing.expectEqualSlices(u8, &.{ 0x07, 0, 0, 33, 0, 0, 10, 9, 1, 0, 0, 0, 0x17, 1, 0, 0, 0, 0, 0, 0, 1, 0x65 }, media[0..22]);
    // audio: csid 6
    try testing.expectEqual(@as(u8, 0x06), media[22]);
    try testing.expectEqual(@as(u8, 0xAF), media[22 + 12]);
}

test "publisher: rejected publish and key never in error" {
    const rand: [handshake_len - 8]u8 = @splat(0x42);
    var sbuf: [8192]u8 = undefined;
    var sw: Writer = .fixed(&sbuf);
    try scriptedServer(&sw, &rand, true);
    var cbuf: [16384]u8 = undefined;
    var cw: Writer = .fixed(&cbuf);
    var r: Reader = .fixed(sw.buffered());
    var p = Publisher.init(testing.allocator, &r, &cw);
    defer p.deinit();
    const url = try Url.parse("rtmp://example.invalid/app");
    try testing.expectError(error.PublishRejected, p.publish(url, "k", &rand));
}

test "publisher: bad handshake" {
    const rand: [handshake_len - 8]u8 = @splat(0x42);
    var sbuf: [1 + 2 * handshake_len]u8 = @splat(0);
    sbuf[0] = 4;
    var cbuf: [4096]u8 = undefined;
    var cw: Writer = .fixed(&cbuf);
    var r: Reader = .fixed(&sbuf);
    var p = Publisher.init(testing.allocator, &r, &cw);
    defer p.deinit();
    try testing.expectError(error.BadHandshake, p.handshake(&rand));
}
