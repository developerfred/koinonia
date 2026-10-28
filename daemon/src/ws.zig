//! Minimal WebSocket (RFC 6455) server side: HTTP upgrade handshake + frame reader/writer.
//! Transport-agnostic (std.Io.Reader / std.Io.Writer).

const std = @import("std");
const Reader = std.Io.Reader;
const Writer = std.Io.Writer;
const Allocator = std.mem.Allocator;

pub const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const Opcode = enum(u4) {
    continuation = 0,
    text = 1,
    binary = 2,
    close = 8,
    ping = 9,
    pong = 10,
    _,
};

pub fn acceptKey(out: *[28]u8, client_key: []const u8) void {
    var h = std.crypto.hash.Sha1.init(.{});
    h.update(client_key);
    h.update(guid);
    var digest: [20]u8 = undefined;
    h.final(&digest);
    _ = std.base64.standard.Encoder.encode(out, &digest);
}

pub const HandshakeError = error{ BadRequest, Forbidden, HeaderTooLong } || Reader.Error || Writer.Error;

pub const Upgrade = struct {
    /// Request path and query as received, copied into `path_buf`.
    path: []const u8,
};

pub const HandshakeOptions = struct {
    /// Required path prefix (e.g. "/ingest").
    path: []const u8 = "/ingest",
    /// If non-null the query must contain `token=<value>`.
    token: ?[]const u8 = null,
    allow_any_origin: bool = false,
};

fn originAllowed(origin: []const u8) bool {
    // origin looks like scheme://host[:port]
    const i = std.mem.indexOf(u8, origin, "://") orelse return false;
    const hostport = origin[i + 3 ..];
    const allowed = [_][]const u8{ "localhost", "127.0.0.1", "[::1]" };
    for (allowed) |a| {
        if (std.mem.startsWith(u8, hostport, a)) {
            const rest = hostport[a.len..];
            if (rest.len == 0 or rest[0] == ':') return true;
        }
    }
    return false;
}

fn constEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var acc: u8 = 0;
    for (a, b) |x, y| acc |= x ^ y;
    return acc == 0;
}

fn queryToken(query: []const u8) ?[]const u8 {
    var it = std.mem.splitScalar(u8, query, '&');
    while (it.next()) |kv| {
        if (std.mem.startsWith(u8, kv, "token=")) return kv["token=".len..];
    }
    return null;
}

fn writeHttpError(w: *Writer, code: u16, reason: []const u8) Writer.Error!void {
    try w.print("HTTP/1.1 {d} {s}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", .{ code, reason });
    try w.flush();
}

/// Read the HTTP upgrade request, validate it and reply `101` (or an HTTP error).
pub fn serverHandshake(r: *Reader, w: *Writer, opts: HandshakeOptions) HandshakeError!void {
    const req_line = r.takeDelimiterInclusive('\n') catch |e| switch (e) {
        error.StreamTooLong => return error.HeaderTooLong,
        else => |x| return x,
    };
    var parts = std.mem.tokenizeAny(u8, std.mem.trim(u8, req_line, "\r\n"), " ");
    const method = parts.next() orelse return error.BadRequest;
    const target = parts.next() orelse return error.BadRequest;
    if (!std.mem.eql(u8, method, "GET")) {
        try writeHttpError(w, 405, "Method Not Allowed");
        return error.BadRequest;
    }
    var key_buf: [64]u8 = undefined;
    var key_len: usize = 0;
    var upgrade_ok = false;
    var origin_ok = true;
    var header_count: usize = 0;
    while (true) {
        const line_raw = r.takeDelimiterInclusive('\n') catch |e| switch (e) {
            error.StreamTooLong => return error.HeaderTooLong,
            else => |x| return x,
        };
        const line = std.mem.trim(u8, line_raw, "\r\n");
        if (line.len == 0) break;
        header_count += 1;
        if (header_count > 64) return error.HeaderTooLong;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = line[0..colon];
        const val = std.mem.trim(u8, line[colon + 1 ..], " \t");
        if (std.ascii.eqlIgnoreCase(name, "sec-websocket-key")) {
            if (val.len > key_buf.len) return error.BadRequest;
            @memcpy(key_buf[0..val.len], val);
            key_len = val.len;
        } else if (std.ascii.eqlIgnoreCase(name, "upgrade")) {
            upgrade_ok = std.ascii.eqlIgnoreCase(val, "websocket");
        } else if (std.ascii.eqlIgnoreCase(name, "origin")) {
            origin_ok = opts.allow_any_origin or originAllowed(val);
        }
    }
    if (!upgrade_ok or key_len == 0) {
        try writeHttpError(w, 400, "Bad Request");
        return error.BadRequest;
    }
    const qpos = std.mem.indexOfScalar(u8, target, '?');
    const path = if (qpos) |q| target[0..q] else target;
    if (!std.mem.eql(u8, path, opts.path)) {
        try writeHttpError(w, 404, "Not Found");
        return error.BadRequest;
    }
    if (!origin_ok) {
        try writeHttpError(w, 403, "Forbidden");
        return error.Forbidden;
    }
    if (opts.token) |want| {
        const got = if (qpos) |q| queryToken(target[q + 1 ..]) else null;
        if (got == null or !constEql(got.?, want)) {
            try writeHttpError(w, 403, "Forbidden");
            return error.Forbidden;
        }
    }
    var accept: [28]u8 = undefined;
    acceptKey(&accept, key_buf[0..key_len]);
    try w.print("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{accept});
    try w.flush();
}

pub fn writeBusy(w: *Writer) Writer.Error!void {
    try writeHttpError(w, 409, "Conflict");
}

// ---------------------------------------------------------------------------------------------
// Frames

/// Write one unfragmented, unmasked server frame. Does not flush.
pub fn writeFrame(w: *Writer, op: Opcode, payload: []const u8) Writer.Error!void {
    try w.writeByte(0x80 | @as(u8, @backingInt(op)));
    if (payload.len < 126) {
        try w.writeByte(@intCast(payload.len));
    } else if (payload.len <= 0xFFFF) {
        try w.writeByte(126);
        try w.writeInt(u16, @intCast(payload.len), .big);
    } else {
        try w.writeByte(127);
        try w.writeInt(u64, payload.len, .big);
    }
    try w.writeAll(payload);
}

pub const Message = struct {
    op: Opcode,
    /// Valid until the next `Conn.next` call.
    payload: []const u8,
};

pub const Conn = struct {
    gpa: Allocator,
    r: *Reader,
    max_message: usize,
    buf: std.ArrayList(u8) = .empty,

    pub const Error = error{ ProtocolError, MessageTooLarge, OutOfMemory } || Reader.Error;

    pub fn init(gpa: Allocator, r: *Reader, max_message: usize) Conn {
        return .{ .gpa = gpa, .r = r, .max_message = max_message };
    }

    pub fn deinit(c: *Conn) void {
        c.buf.deinit(c.gpa);
    }

    /// Next complete message (data messages are reassembled from fragments; control frames may
    /// arrive between fragments and are returned immediately). Client frames must be masked.
    pub fn next(c: *Conn) Error!Message {
        c.buf.clearRetainingCapacity();
        var msg_op: ?Opcode = null;
        while (true) {
            const b0 = try c.r.takeByte();
            const b1 = try c.r.takeByte();
            const fin = b0 & 0x80 != 0;
            if (b0 & 0x70 != 0) return error.ProtocolError; // RSV bits, no extensions
            const op: Opcode = @fromBackingInt(@intCast(@as(u4, @truncate(b0))));
            if (b1 & 0x80 == 0) return error.ProtocolError; // unmasked client frame
            var len: u64 = b1 & 0x7F;
            if (len == 126) len = try c.r.takeInt(u16, .big) else if (len == 127) len = try c.r.takeInt(u64, .big);
            var mask: [4]u8 = undefined;
            try c.r.readSliceAll(&mask);
            const is_control = @backingInt(op) >= 8;
            if (is_control and (len > 125 or !fin)) return error.ProtocolError;
            if (len + c.buf.items.len > c.max_message) return error.MessageTooLarge;
            const n: usize = @intCast(len);
            const start = c.buf.items.len;
            const dst = try c.buf.addManyAsSlice(c.gpa, n);
            try c.r.readSliceAll(dst);
            for (dst, 0..) |*b, i| b.* ^= mask[i & 3];

            if (is_control) {
                switch (op) {
                    .close, .ping, .pong => {},
                    else => return error.ProtocolError,
                }
                // Return control payload (copy to front so data fragments in progress are kept
                // out of the way: control frames mid-fragment are rare; we drop partial data).
                const ctl = c.buf.items[start..];
                return .{ .op = op, .payload = ctl };
            }
            switch (op) {
                .continuation => if (msg_op == null) return error.ProtocolError,
                .text, .binary => {
                    if (msg_op != null) return error.ProtocolError;
                    msg_op = op;
                },
                else => return error.ProtocolError,
            }
            if (fin) return .{ .op = msg_op.?, .payload = c.buf.items };
        }
    }
};

const testing = std.testing;

fn maskedFrame(out: *Writer, fin: bool, op: u4, payload: []const u8) !void {
    try out.writeByte((if (fin) @as(u8, 0x80) else 0) | op);
    const mask = [4]u8{ 0x37, 0xFA, 0x21, 0x3D };
    if (payload.len < 126) {
        try out.writeByte(0x80 | @as(u8, @intCast(payload.len)));
    } else {
        try out.writeByte(0x80 | 126);
        try out.writeInt(u16, @intCast(payload.len), .big);
    }
    try out.writeAll(&mask);
    for (payload, 0..) |b, i| try out.writeByte(b ^ mask[i & 3]);
}

test "accept key matches RFC 6455 example" {
    var out: [28]u8 = undefined;
    acceptKey(&out, "dGhlIHNhbXBsZSBub25jZQ==");
    try testing.expectEqualStrings("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", &out);
}

test "server handshake ok" {
    const req = "GET /ingest?x=1 HTTP/1.1\r\nHost: 127.0.0.1:7878\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://localhost:3000\r\n\r\n";
    var r: Reader = .fixed(req);
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try serverHandshake(&r, &w, .{});
    try testing.expect(std.mem.startsWith(u8, w.buffered(), "HTTP/1.1 101 Switching Protocols\r\n"));
    try testing.expect(std.mem.indexOf(u8, w.buffered(), "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") != null);
}

test "server handshake rejects bad origin, wrong path, bad token" {
    const mk = struct {
        fn req(comptime target: []const u8, comptime origin: []const u8) []const u8 {
            return "GET " ++ target ++ " HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\n" ++ origin ++ "\r\n";
        }
    };
    var buf: [512]u8 = undefined;
    {
        var r: Reader = .fixed(mk.req("/ingest", "Origin: https://evil.example\r\n"));
        var w: Writer = .fixed(&buf);
        try testing.expectError(error.Forbidden, serverHandshake(&r, &w, .{}));
        try testing.expect(std.mem.startsWith(u8, w.buffered(), "HTTP/1.1 403"));
    }
    {
        var r: Reader = .fixed(mk.req("/other", ""));
        var w: Writer = .fixed(&buf);
        try testing.expectError(error.BadRequest, serverHandshake(&r, &w, .{}));
    }
    {
        var r: Reader = .fixed(mk.req("/ingest?token=nope", ""));
        var w: Writer = .fixed(&buf);
        try testing.expectError(error.Forbidden, serverHandshake(&r, &w, .{ .token = "secret" }));
    }
    {
        var r: Reader = .fixed(mk.req("/ingest?a=b&token=secret", ""));
        var w: Writer = .fixed(&buf);
        try serverHandshake(&r, &w, .{ .token = "secret" });
    }
    try testing.expect(originAllowed("http://localhost"));
    try testing.expect(originAllowed("http://127.0.0.1:5173"));
    try testing.expect(!originAllowed("http://localhost.evil.com"));
}

test "server frame encode" {
    var buf: [400]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try writeFrame(&w, .binary, "hi");
    try testing.expectEqualSlices(u8, &.{ 0x82, 2, 'h', 'i' }, w.buffered());
    var big: [300]u8 = @splat(7);
    w = .fixed(&buf);
    try writeFrame(&w, .text, &big);
    try testing.expectEqualSlices(u8, &.{ 0x81, 126, 0x01, 0x2C }, w.buffered()[0..4]);
}

test "client frames: masked decode, 16-bit length, fragments, ping interleave" {
    var sb: [2048]u8 = undefined;
    var w: Writer = .fixed(&sb);
    try maskedFrame(&w, true, 2, "hello");
    var long: [200]u8 = undefined;
    for (&long, 0..) |*b, i| b.* = @truncate(i);
    try maskedFrame(&w, true, 2, &long);
    try maskedFrame(&w, false, 2, "ab");
    try maskedFrame(&w, true, 0, "cd");
    try maskedFrame(&w, true, 9, "p");
    try maskedFrame(&w, true, 8, &.{ 0x03, 0xE8 });

    var r: Reader = .fixed(w.buffered());
    var c = Conn.init(testing.allocator, &r, 1 << 20);
    defer c.deinit();
    var m = try c.next();
    try testing.expectEqual(Opcode.binary, m.op);
    try testing.expectEqualStrings("hello", m.payload);
    m = try c.next();
    try testing.expectEqualSlices(u8, &long, m.payload);
    m = try c.next();
    try testing.expectEqualStrings("abcd", m.payload);
    m = try c.next();
    try testing.expectEqual(Opcode.ping, m.op);
    try testing.expectEqualStrings("p", m.payload);
    m = try c.next();
    try testing.expectEqual(Opcode.close, m.op);
}

test "client frames: unmasked and oversize rejected" {
    var r: Reader = .fixed(&[_]u8{ 0x82, 0x01, 0xAA });
    var c = Conn.init(testing.allocator, &r, 1024);
    defer c.deinit();
    try testing.expectError(error.ProtocolError, c.next());

    var sb: [512]u8 = undefined;
    var w: Writer = .fixed(&sb);
    const zeros: [200]u8 = @splat(0);
    try maskedFrame(&w, true, 2, &zeros);
    var r2: Reader = .fixed(w.buffered());
    var c2 = Conn.init(testing.allocator, &r2, 100);
    defer c2.deinit();
    try testing.expectError(error.MessageTooLarge, c2.next());
}
