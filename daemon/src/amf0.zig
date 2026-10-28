//! Minimal AMF0 encoder (and a tiny scanner) for FLV metadata and RTMP commands.

const std = @import("std");
const Writer = std.Io.Writer;

pub const Marker = struct {
    pub const number: u8 = 0x00;
    pub const boolean: u8 = 0x01;
    pub const string: u8 = 0x02;
    pub const object: u8 = 0x03;
    pub const null_: u8 = 0x05;
    pub const ecma_array: u8 = 0x08;
    pub const object_end: u8 = 0x09;
};

pub fn writeNumber(w: *Writer, v: f64) Writer.Error!void {
    try w.writeByte(Marker.number);
    try w.writeInt(u64, @bitCast(v), .big);
}

pub fn writeBool(w: *Writer, v: bool) Writer.Error!void {
    try w.writeByte(Marker.boolean);
    try w.writeByte(@intFromBool(v));
}

pub fn writeString(w: *Writer, s: []const u8) Writer.Error!void {
    try w.writeByte(Marker.string);
    try w.writeInt(u16, @intCast(s.len), .big);
    try w.writeAll(s);
}

pub fn writeNull(w: *Writer) Writer.Error!void {
    try w.writeByte(Marker.null_);
}

pub fn objectBegin(w: *Writer) Writer.Error!void {
    try w.writeByte(Marker.object);
}

pub fn ecmaArrayBegin(w: *Writer, count: u32) Writer.Error!void {
    try w.writeByte(Marker.ecma_array);
    try w.writeInt(u32, count, .big);
}

/// Property name (no marker) used inside objects / ECMA arrays.
pub fn writeKey(w: *Writer, key: []const u8) Writer.Error!void {
    try w.writeInt(u16, @intCast(key.len), .big);
    try w.writeAll(key);
}

pub fn objectEnd(w: *Writer) Writer.Error!void {
    try w.writeAll(&.{ 0, 0, Marker.object_end });
}

pub fn propNumber(w: *Writer, key: []const u8, v: f64) Writer.Error!void {
    try writeKey(w, key);
    try writeNumber(w, v);
}

pub fn propString(w: *Writer, key: []const u8, v: []const u8) Writer.Error!void {
    try writeKey(w, key);
    try writeString(w, v);
}

pub fn propBool(w: *Writer, key: []const u8, v: bool) Writer.Error!void {
    try writeKey(w, key);
    try writeBool(w, v);
}

/// Find the string value of property `key` anywhere in an AMF0 payload (loosely: looks for the
/// key bytes followed by a string marker). Enough to read `code` from `onStatus` replies.
pub fn findStringProp(payload: []const u8, key: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i + 2 + key.len + 3 <= payload.len) : (i += 1) {
        if (std.mem.readInt(u16, payload[i..][0..2], .big) != key.len) continue;
        if (!std.mem.eql(u8, payload[i + 2 ..][0..key.len], key)) continue;
        const m = i + 2 + key.len;
        if (payload[m] != Marker.string) continue;
        const l: usize = std.mem.readInt(u16, payload[m + 1 ..][0..2], .big);
        if (l > payload.len - (m + 3)) return null;
        return payload[m + 3 ..][0..l];
    }
    return null;
}

/// Read the leading command name (a string) from an AMF0 command payload.
pub fn commandName(payload: []const u8) ?[]const u8 {
    if (payload.len < 3 or payload[0] != Marker.string) return null;
    const l: usize = std.mem.readInt(u16, payload[1..3], .big);
    if (l > payload.len - 3) return null;
    return payload[3..][0..l];
}

test "amf0 number and string encoding" {
    var buf: [64]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try writeString(&w, "connect");
    try writeNumber(&w, 1.0);
    const out = w.buffered();
    try std.testing.expectEqualSlices(u8, &.{ 2, 0, 7, 'c', 'o', 'n', 'n', 'e', 'c', 't', 0, 0x3F, 0xF0, 0, 0, 0, 0, 0, 0 }, out);
}

test "findStringProp reads onStatus code" {
    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try writeString(&w, "onStatus");
    try writeNumber(&w, 0);
    try writeNull(&w);
    try objectBegin(&w);
    try propString(&w, "level", "status");
    try propString(&w, "code", "NetStream.Publish.Start");
    try objectEnd(&w);
    const out = w.buffered();
    try std.testing.expectEqualStrings("onStatus", commandName(out).?);
    try std.testing.expectEqualStrings("NetStream.Publish.Start", findStringProp(out, "code").?);
    try std.testing.expect(findStringProp(out, "nope") == null);
}

test "commandName rejects lengths that would overflow u16 arithmetic" {
    // Regression (fuzz reproducer): name length 0xFFFF used to compute `3 + l` in u16 and panic.
    try std.testing.expect(commandName(&.{ Marker.string, 0xFF, 0xFF }) == null);
    try std.testing.expect(commandName(&.{ Marker.string, 0xFF, 0xFD, 'a' }) == null);
    try std.testing.expect(commandName(&.{ Marker.string, 0xFF, 0xFC }) == null);
    var big: [3 + 65535]u8 = @splat('x');
    big[0] = Marker.string;
    std.mem.writeInt(u16, big[1..3], 65535, .big);
    try std.testing.expectEqual(@as(usize, 65535), commandName(&big).?.len);
    try std.testing.expect(commandName(big[0 .. big.len - 1]) == null);
    try std.testing.expect(commandName(&.{}) == null);
}

test "findStringProp is bounds-safe on truncated and huge lengths" {
    const p = [_]u8{ 0, 4, 'c', 'o', 'd', 'e', Marker.string, 0xFF, 0xFF, 'x' };
    try std.testing.expect(findStringProp(&p, "code") == null);
    try std.testing.expect(findStringProp(p[0..9], "code") == null);
}
