//! Fuzz + property tests for the daemon's untrusted-input parsers: browser framing, Start JSON,
//! AMF0 scanners and the RTMP chunk reader (server replies are untrusted too).
//!
//! Two modes:
//!  * `zig build test`            -> corpus replay + bounded deterministic random runner (`-Dfuzz-iters`)
//!  * `zig build test --fuzz`     -> coverage-guided via std.testing.fuzz (same properties)
const std = @import("std");
const testing = std.testing;
const koinonia = @import("koinonia");
const opts = @import("qa_options");
const framing = koinonia.framing;
const golden = @embedFile("golden");

/// Properties for any input: must never crash/UB; error set closed; accepted frames round-trip.
fn checkFraming(input: []const u8) !void {
    const f = framing.parse(input) catch |e| {
        switch (e) {
            error.Truncated, error.UnknownKind, error.BadPayload => {},
        }
        return;
    };
    // payload aliases input past the header, header re-encodes identically
    try testing.expectEqual(input.len - framing.header_len, f.payload.len);
    const h = framing.encodeHeader(f);
    try testing.expectEqualSlices(u8, input[0..framing.header_len], &h);
    // Truncating an accepted frame below the header must be rejected as Truncated.
    if (framing.parse(input[0 .. framing.header_len - 1])) |_| return error.TestUnexpectedResult else |e| try testing.expectEqual(error.Truncated, e);
}

fn checkStart(input: []const u8) !void {
    if (!@hasDecl(framing, "parseStart")) return;
    var p = framing.parseStart(testing.allocator, input) catch return; // leak-checked by testing.allocator
    p.deinit();
}

fn knownGap(comptime id: []const u8) bool {
    return std.mem.indexOf(u8, opts.known_gaps, id) != null;
}

fn checkAmf(input: []const u8) !void {
    // daemon/src/amf0.zig commandName: `3 + l` is evaluated in u16 (l is u16) => integer overflow panic for l >= 65533
    // (UB / out-of-bounds read in ReleaseFast). Reachable from any RTMP server reply. See qa/known-gaps.json.
    if (@hasDecl(koinonia.amf0, "commandName") and !knownGap("amf0-commandName-u16-overflow")) {
        if (koinonia.amf0.commandName(input)) |n| try testing.expect(n.len <= input.len);
    }
    if (@hasDecl(koinonia.amf0, "findStringProp")) {
        if (koinonia.amf0.findStringProp(input, "code")) |s| try testing.expect(s.len <= input.len);
    }
}

fn checkChunks(input: []const u8) !void {
    if (!@hasDecl(koinonia.rtmp, "ChunkReader")) return;
    var cr = koinonia.rtmp.ChunkReader.init(testing.allocator);
    defer cr.deinit();
    var r: std.Io.Reader = .fixed(input);
    var guard: usize = 0;
    while (guard < 64) : (guard += 1) {
        const m = cr.readMessage(&r) catch return; // any error is fine; crashes and leaks are not
        try testing.expect(m.payload.len <= 16 * 1024 * 1024);
    }
}

fn checkAll(input: []const u8) !void {
    try checkFraming(input);
    try checkStart(input);
    try checkAmf(input);
    try checkChunks(input);
}

fn fuzzOne(_: void, smith: *testing.Smith) !void {
    var buf: [2048]u8 = undefined;
    const n = smith.slice(&buf);
    try checkAll(buf[0..n]);
}

test "fuzz: coverage-guided entry (std.testing.fuzz); replays corpus without --fuzz" {
    try testing.fuzz({}, fuzzOne, .{ .corpus = &.{ "", "\x12", "\x12\x01\x00\x00\x00\x00\x00\x00\x00\x28\xaa", "\x02\x00\x00\x00\x00\x00\x00\x00\x00\x00" } });
}

test "corpus: every golden frame (valid and invalid) and all single-byte mutations of it" {
    var lines = std.mem.tokenizeScalar(u8, golden, '\n');
    var buf: [512]u8 = undefined;
    var count: usize = 0;
    while (lines.next()) |line| {
        if (!(std.mem.startsWith(u8, line, "valid ") or std.mem.startsWith(u8, line, "invalid "))) continue;
        var it = std.mem.tokenizeScalar(u8, line, ' ');
        _ = it.next();
        _ = it.next();
        const hex = it.next().?;
        if (std.mem.eql(u8, hex, "-") or hex.len / 2 > buf.len) continue;
        const bytes = try std.fmt.hexToBytes(&buf, hex);
        try checkAll(bytes);
        for (0..bytes.len) |i| {
            const orig = bytes[i];
            for ([_]u8{ 0x00, 0xff, orig ^ 0x01, orig ^ 0x80 }) |b| {
                bytes[i] = b;
                try checkAll(bytes);
            }
            bytes[i] = orig;
        }
        // every prefix
        for (0..bytes.len) |l| try checkAll(bytes[0..l]);
        count += 1;
    }
    try testing.expect(count > 10);
}

test "random: bounded deterministic runner (-Dfuzz-iters)" {
    var prng = std.Random.DefaultPrng.init(0xC0FFEE);
    const rnd = prng.random();
    var buf: [1024]u8 = undefined;
    var i: u32 = 0;
    while (i < opts.fuzz_iters) : (i += 1) {
        const n = rnd.uintLessThan(usize, buf.len);
        rnd.bytes(buf[0..n]);
        // bias toward plausible headers so we get past the first check
        if (n >= framing.header_len and rnd.boolean()) buf[0] = rnd.uintLessThan(u8, 0x14);
        try checkAll(buf[0..n]);
    }
}

test "property: any in-range header round-trips through encodeHeader/parse" {
    var prng = std.Random.DefaultPrng.init(42);
    const rnd = prng.random();
    const kinds = [_]framing.Kind{ .start, .stop, .clip, .video_config, .audio_config, .video_chunk, .audio_chunk };
    var i: usize = 0;
    while (i < 5000) : (i += 1) {
        const f: framing.Frame = .{
            .kind = kinds[rnd.uintLessThan(usize, kinds.len)],
            .flags = rnd.int(u8),
            .dts_ms = rnd.int(u32),
            .cts_offset_ms = rnd.int(i32),
            .payload = &.{},
        };
        var msg: [framing.header_len + 1]u8 = undefined;
        const h = framing.encodeHeader(f);
        @memcpy(msg[0..framing.header_len], &h);
        msg[framing.header_len] = 0xEE; // non-empty so BadPayload cannot trigger
        const g = try framing.parse(&msg);
        try testing.expectEqual(f.kind, g.kind);
        try testing.expectEqual(f.flags, g.flags);
        try testing.expectEqual(f.dts_ms, g.dts_ms);
        try testing.expectEqual(f.cts_offset_ms, g.cts_offset_ms);
    }
}
