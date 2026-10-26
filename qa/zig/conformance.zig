//! Daemon side of the contract: the daemon's real parser/muxer vs qa/fixtures/protocol/golden.txt.
const std = @import("std");
const testing = std.testing;
const koinonia = @import("koinonia");
const framing = koinonia.framing;
const golden = @embedFile("golden");

fn unhex(gpa: std.mem.Allocator, s: []const u8) ![]u8 {
    if (std.mem.eql(u8, s, "-")) return gpa.alloc(u8, 0);
    const out = try gpa.alloc(u8, s.len / 2);
    errdefer gpa.free(out);
    return std.fmt.hexToBytes(out, s) catch unreachable;
}

test "golden: valid frames parse to the expected fields and re-encode the header byte-identically" {
    const gpa = testing.allocator;
    var n: usize = 0;
    var lines = std.mem.tokenizeScalar(u8, golden, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "valid ")) continue;
        var it = std.mem.tokenizeScalar(u8, line, ' ');
        _ = it.next();
        const name = it.next().?;
        const bytes = try unhex(gpa, it.next().?);
        defer gpa.free(bytes);
        const kind = try std.fmt.parseInt(u8, it.next().?, 10);
        const flags = try std.fmt.parseInt(u8, it.next().?, 10);
        const dts = try std.fmt.parseInt(u32, it.next().?, 10);
        const cts = try std.fmt.parseInt(i32, it.next().?, 10);
        const payload = try unhex(gpa, it.next().?);
        defer gpa.free(payload);

        const f = framing.parse(bytes) catch |e| {
            std.debug.print("golden frame '{s}' rejected by daemon: {s}\n", .{ name, @errorName(e) });
            return e;
        };
        try testing.expectEqual(kind, @intFromEnum(f.kind));
        try testing.expectEqual(flags, f.flags);
        try testing.expectEqual(dts, f.dts_ms);
        try testing.expectEqual(cts, f.cts_offset_ms);
        try testing.expectEqualSlices(u8, payload, f.payload);
        const h = framing.encodeHeader(f);
        try testing.expectEqualSlices(u8, bytes[0..framing.header_len], &h);
        n += 1;
    }
    try testing.expect(n >= 10);
}

test "golden: invalid frames are rejected with the documented error" {
    const gpa = testing.allocator;
    var n: usize = 0;
    var lines = std.mem.tokenizeScalar(u8, golden, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "invalid ")) continue;
        var it = std.mem.tokenizeScalar(u8, line, ' ');
        _ = it.next();
        const name = it.next().?;
        const bytes = try unhex(gpa, it.next().?);
        defer gpa.free(bytes);
        const want = it.next().?;
        if (framing.parse(bytes)) |_| {
            std.debug.print("golden invalid frame '{s}' was accepted\n", .{name});
            return error.TestUnexpectedResult;
        } else |e| {
            if (!std.mem.eql(u8, @errorName(e), want)) {
                std.debug.print("'{s}': want {s}, got {s}\n", .{ name, want, @errorName(e) });
                return error.TestUnexpectedResult;
            }
        }
        n += 1;
    }
    try testing.expect(n >= 8);
}

test "golden: header length constant" {
    try testing.expectEqual(@as(usize, 10), framing.header_len);
}

test "golden: FLV tags emitted for each golden frame match the expected bytes" {
    if (!@hasDecl(koinonia, "flv")) return error.SkipZigTest;
    const flv = koinonia.flv;
    const gpa = testing.allocator;
    var checked: usize = 0;

    var valid = std.mem.tokenizeScalar(u8, golden, '\n');
    while (valid.next()) |line| {
        if (!std.mem.startsWith(u8, line, "flv ")) continue;
        var it = std.mem.tokenizeScalar(u8, line, ' ');
        _ = it.next();
        const name = it.next().?;
        const tag_type = try std.fmt.parseInt(u8, it.next().?, 10);
        const ts = try std.fmt.parseInt(u32, it.next().?, 10);
        const want_body = try unhex(gpa, it.next().?);
        defer gpa.free(want_body);

        // find the matching input frame
        var again = std.mem.tokenizeScalar(u8, golden, '\n');
        var frame_bytes: ?[]u8 = null;
        defer if (frame_bytes) |fb| gpa.free(fb);
        while (again.next()) |l2| {
            if (!std.mem.startsWith(u8, l2, "valid ")) continue;
            var it2 = std.mem.tokenizeScalar(u8, l2, ' ');
            _ = it2.next();
            if (std.mem.eql(u8, it2.next().?, name)) {
                frame_bytes = try unhex(gpa, it2.next().?);
                break;
            }
        }
        const fr = try framing.parse(frame_bytes.?);

        var head: [5]u8 = undefined;
        var head_len: usize = 0;
        switch (fr.kind) {
            .video_config => {
                head = flv.videoHeader(true, .sequence_header, 0);
                head_len = 5;
            },
            .video_chunk => {
                head = flv.videoHeader(fr.isKeyframe(), .nalu, fr.cts_offset_ms);
                head_len = 5;
            },
            .audio_config => {
                const a = flv.audioHeader(.sequence_header);
                @memcpy(head[0..2], &a);
                head_len = 2;
            },
            .audio_chunk => {
                const a = flv.audioHeader(.raw);
                @memcpy(head[0..2], &a);
                head_len = 2;
            },
            else => return error.TestUnexpectedResult,
        }
        var buf: [4096]u8 = undefined;
        var w: std.Io.Writer = .fixed(&buf);
        try flv.writeTag(&w, @enumFromInt(tag_type), fr.dts_ms, head[0..head_len], fr.payload);
        const out = w.buffered();
        // 11-byte tag header + body + 4-byte PreviousTagSize
        try testing.expectEqual(tag_type, out[0]);
        try testing.expectEqual(@as(u32, @intCast(want_body.len)), std.mem.readInt(u24, out[1..4], .big));
        try testing.expectEqual(ts, std.mem.readInt(u24, out[4..7], .big) | (@as(u32, out[7]) << 24));
        try testing.expectEqualSlices(u8, want_body, out[11 .. 11 + want_body.len]);
        try testing.expectEqual(@as(u32, @intCast(11 + want_body.len)), std.mem.readInt(u32, out[11 + want_body.len ..][0..4], .big));
        checked += 1;
    }
    try testing.expect(checked >= 6);
}

test "golden: start payload parses into Start with the documented fields" {
    if (!@hasDecl(framing, "parseStart")) return error.SkipZigTest;
    const json =
        \\{"destinations":["twitch","youtube"],"width":1280,"height":720,"fps":30,"video_kbps":2500,"audio_kbps":128,"sample_rate":48000,"channels":2}
    ;
    var p = try framing.parseStart(testing.allocator, json);
    defer p.deinit();
    try testing.expectEqual(@as(usize, 2), p.value.destinations.len);
    try testing.expectEqual(@as(u32, 48000), p.value.sample_rate);
}
