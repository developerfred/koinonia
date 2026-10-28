//! Browser -> daemon binary framing. One WebSocket binary message == one frame.
//! See PROTOCOL.md for the normative description.

const std = @import("std");

pub const header_len = 10;

pub const Kind = enum(u8) {
    /// Control: JSON payload (`Start`). Must be the first frame of a session.
    start = 0x01,
    /// Control: stop the session (empty payload).
    stop = 0x02,
    /// Control: JSON `{"seconds_back":30,"title":"x"}` -> export a clip from the ring buffer.
    clip = 0x03,
    /// Video decoder config: AVCDecoderConfigurationRecord (WebCodecs `description`).
    video_config = 0x10,
    /// Audio decoder config: AudioSpecificConfig (WebCodecs `description`).
    audio_config = 0x11,
    /// One H.264 access unit in AVCC (length-prefixed NAL) form.
    video_chunk = 0x12,
    /// One raw AAC-LC access unit (no ADTS).
    audio_chunk = 0x13,
    /// Daemon -> browser status (JSON). Never sent by the browser.
    status = 0x80,
    _,
};

pub const flag_keyframe: u8 = 0x01;

pub const Frame = struct {
    kind: Kind,
    flags: u8,
    /// Decode timestamp in milliseconds since session start.
    dts_ms: u32,
    /// Composition offset (pts - dts) in ms; 0 for audio and for B-frame-less video.
    cts_offset_ms: i32,
    payload: []const u8,

    pub fn isKeyframe(f: Frame) bool {
        return f.flags & flag_keyframe != 0;
    }
};

pub const ParseError = error{ Truncated, UnknownKind, BadPayload };

/// Parse a frame; `payload` aliases `bytes`.
pub fn parse(bytes: []const u8) ParseError!Frame {
    if (bytes.len < header_len) return error.Truncated;
    const kind: Kind = @fromBackingInt(@intCast(bytes[0]));
    switch (kind) {
        .start, .stop, .clip, .video_config, .audio_config, .video_chunk, .audio_chunk => {},
        else => return error.UnknownKind,
    }
    const f: Frame = .{
        .kind = kind,
        .flags = bytes[1],
        .dts_ms = std.mem.readInt(u32, bytes[2..6], .big),
        .cts_offset_ms = std.mem.readInt(i32, bytes[6..10], .big),
        .payload = bytes[header_len..],
    };
    switch (kind) {
        .video_config, .audio_config, .video_chunk, .audio_chunk, .start, .clip => {
            if (f.payload.len == 0) return error.BadPayload;
        },
        else => {},
    }
    return f;
}

pub fn encodeHeader(f: Frame) [header_len]u8 {
    var h: [header_len]u8 = undefined;
    h[0] = @backingInt(f.kind);
    h[1] = f.flags;
    std.mem.writeInt(u32, h[2..6], f.dts_ms, .big);
    std.mem.writeInt(i32, h[6..10], f.cts_offset_ms, .big);
    return h;
}

/// Payload of a `start` frame.
pub const Start = struct {
    /// Destination names to publish to (must match configured names), e.g. "twitch".
    /// Empty/absent = all configured destinations.
    destinations: []const []const u8 = &.{},
    width: u32 = 1280,
    height: u32 = 720,
    fps: u32 = 30,
    video_kbps: u32 = 2500,
    audio_kbps: u32 = 128,
    sample_rate: u32 = 48000,
    channels: u32 = 2,
};

pub fn parseStart(gpa: std.mem.Allocator, payload: []const u8) !std.json.Parsed(Start) {
    return std.json.parseFromSlice(Start, gpa, payload, .{ .ignore_unknown_fields = true });
}

const testing = std.testing;

test "parse video chunk frame" {
    const bytes = [_]u8{ 0x12, 0x01, 0, 0, 0x03, 0xE8, 0, 0, 0, 0x28, 0xAA, 0xBB };
    const f = try parse(&bytes);
    try testing.expectEqual(Kind.video_chunk, f.kind);
    try testing.expect(f.isKeyframe());
    try testing.expectEqual(@as(u32, 1000), f.dts_ms);
    try testing.expectEqual(@as(i32, 40), f.cts_offset_ms);
    try testing.expectEqualSlices(u8, &.{ 0xAA, 0xBB }, f.payload);
}

test "negative composition offset and round trip header" {
    const f: Frame = .{ .kind = .video_chunk, .flags = 0, .dts_ms = 7, .cts_offset_ms = -2, .payload = &.{1} };
    const h = encodeHeader(f);
    var buf: [11]u8 = undefined;
    @memcpy(buf[0..10], &h);
    buf[10] = 1;
    const g = try parse(&buf);
    try testing.expectEqual(@as(i32, -2), g.cts_offset_ms);
    try testing.expectEqual(@as(u32, 7), g.dts_ms);
    try testing.expect(!g.isKeyframe());
}

test "parse errors" {
    try testing.expectError(error.Truncated, parse(&.{ 0x12, 0, 0 }));
    try testing.expectError(error.UnknownKind, parse(&[_]u8{ 0x77, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 }));
    try testing.expectError(error.BadPayload, parse(&[_]u8{ 0x13, 0, 0, 0, 0, 0, 0, 0, 0, 0 }));
    // stop may be empty
    _ = try parse(&[_]u8{ 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0 });
}

test "parse start json" {
    const json =
        \\{"destinations":["twitch","youtube"],"fps":60,"extra":1}
    ;
    var p = try parseStart(testing.allocator, json);
    defer p.deinit();
    try testing.expectEqual(@as(usize, 2), p.value.destinations.len);
    try testing.expectEqualStrings("youtube", p.value.destinations[1]);
    try testing.expectEqual(@as(u32, 60), p.value.fps);
    try testing.expectEqual(@as(u32, 1280), p.value.width);
}
