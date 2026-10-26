//! FLV muxer. The same tag bodies are used as RTMP audio/video message payloads.

const std = @import("std");
const amf0 = @import("amf0.zig");
const Writer = std.Io.Writer;

pub const TagType = enum(u8) { audio = 8, video = 9, script = 18 };

pub const file_header = [_]u8{ 'F', 'L', 'V', 1, 0x05, 0, 0, 0, 9, 0, 0, 0, 0 };

pub const AvcPacketType = enum(u8) { sequence_header = 0, nalu = 1, end_of_sequence = 2 };
pub const AacPacketType = enum(u8) { sequence_header = 0, raw = 1 };

/// 5-byte video tag body header: frame type/codec, AVC packet type, composition time (24-bit signed).
pub fn videoHeader(keyframe: bool, ptype: AvcPacketType, cts_ms: i32) [5]u8 {
    const c: u32 = @bitCast(cts_ms);
    return .{
        (@as(u8, if (keyframe) 1 else 2) << 4) | 7,
        @intFromEnum(ptype),
        @truncate(c >> 16),
        @truncate(c >> 8),
        @truncate(c),
    };
}

/// 2-byte audio tag body header: AAC, 44kHz (as required for AAC), 16 bit, stereo.
pub fn audioHeader(ptype: AacPacketType) [2]u8 {
    return .{ 0xAF, @intFromEnum(ptype) };
}

/// Write an FLV tag (11 byte header, body = `head ++ data`, PreviousTagSize trailer).
pub fn writeTag(w: *Writer, ttype: TagType, ts_ms: u32, head: []const u8, data: []const u8) Writer.Error!void {
    const size: u32 = @intCast(head.len + data.len);
    try w.writeByte(@intFromEnum(ttype));
    try w.writeInt(u24, @intCast(size), .big);
    try w.writeInt(u24, @truncate(ts_ms), .big);
    try w.writeByte(@truncate(ts_ms >> 24));
    try w.writeInt(u24, 0, .big);
    try w.writeAll(head);
    try w.writeAll(data);
    try w.writeInt(u32, 11 + size, .big);
}

pub const Meta = struct {
    width: u32 = 1280,
    height: u32 = 720,
    fps: u32 = 30,
    video_kbps: u32 = 2500,
    audio_kbps: u32 = 128,
    sample_rate: u32 = 48000,
    channels: u32 = 2,
};

/// AMF0 body of the `onMetaData` script tag (also used as the RTMP data message payload).
pub fn writeMetadataBody(w: *Writer, m: Meta) Writer.Error!void {
    try amf0.writeString(w, "onMetaData");
    try amf0.ecmaArrayBegin(w, 9);
    try amf0.propNumber(w, "width", @floatFromInt(m.width));
    try amf0.propNumber(w, "height", @floatFromInt(m.height));
    try amf0.propNumber(w, "framerate", @floatFromInt(m.fps));
    try amf0.propNumber(w, "videodatarate", @floatFromInt(m.video_kbps));
    try amf0.propNumber(w, "videocodecid", 7);
    try amf0.propNumber(w, "audiodatarate", @floatFromInt(m.audio_kbps));
    try amf0.propNumber(w, "audiosamplerate", @floatFromInt(m.sample_rate));
    try amf0.propNumber(w, "audiocodecid", 10);
    try amf0.propBool(w, "stereo", m.channels >= 2);
    try amf0.objectEnd(w);
}

/// Streaming FLV file writer (e.g. for debug dumps).
pub fn writeFileHeader(w: *Writer) Writer.Error!void {
    try w.writeAll(&file_header);
}

const testing = std.testing;

test "flv file header" {
    try testing.expectEqualSlices(u8, "FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00", &file_header);
}

test "video header keyframe/inter and negative cts" {
    try testing.expectEqualSlices(u8, &.{ 0x17, 0x01, 0, 0, 40 }, &videoHeader(true, .nalu, 40));
    try testing.expectEqualSlices(u8, &.{ 0x27, 0x01, 0xFF, 0xFF, 0xFE }, &videoHeader(false, .nalu, -2));
    try testing.expectEqualSlices(u8, &.{ 0x17, 0x00, 0, 0, 0 }, &videoHeader(true, .sequence_header, 0));
}

test "flv video tag bytes" {
    var buf: [64]u8 = undefined;
    var w: Writer = .fixed(&buf);
    const h = videoHeader(true, .nalu, 0);
    try writeTag(&w, .video, 0x01020304, &h, &.{ 0xDE, 0xAD });
    const expect = [_]u8{
        9, 0, 0, 7, // type, size=5+2
        0x02, 0x03, 0x04, 0x01, // ts lower 24 then ext
        0, 0, 0, // stream id
        0x17, 0x01, 0, 0, 0, 0xDE, 0xAD,
        0, 0, 0, 18, // prev tag size = 11 + 7
    };
    try testing.expectEqualSlices(u8, &expect, w.buffered());
}

test "flv audio tag bytes" {
    var buf: [64]u8 = undefined;
    var w: Writer = .fixed(&buf);
    const h = audioHeader(.sequence_header);
    try writeTag(&w, .audio, 5, &h, &.{ 0x11, 0x90 });
    const expect = [_]u8{ 8, 0, 0, 4, 0, 0, 5, 0, 0, 0, 0, 0xAF, 0, 0x11, 0x90, 0, 0, 0, 15 };
    try testing.expectEqualSlices(u8, &expect, w.buffered());
}

test "metadata body starts with onMetaData ecma array" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try writeMetadataBody(&w, .{});
    const b = w.buffered();
    try testing.expectEqualStrings("onMetaData", amf0.commandName(b).?);
    try testing.expectEqual(amf0.Marker.ecma_array, b[13]);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 9 }, b[b.len - 3 ..]);
}
