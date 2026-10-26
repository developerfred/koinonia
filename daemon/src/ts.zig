//! MPEG-TS muxer (H.264 + AAC/ADTS) and the in-memory ring buffer ("Clipper") used for clip export.
//!
//! Interface summary (see `Clipper`):
//!   init(gpa, .{ .max_ms, .max_bytes }) / deinit
//!   setVideoConfig(avcc) / setAudioConfig(asc)
//!   pushVideo(dts_ms, cts_ms, keyframe, avcc_au) / pushAudio(dts_ms, raw_aac)
//!   exportClip(writer, seconds_back) -> ExportInfo     (output is a standalone .ts stream)

const std = @import("std");
const Writer = std.Io.Writer;
const Allocator = std.mem.Allocator;

pub const packet_len = 188;
pub const pmt_pid: u16 = 0x1000;
pub const video_pid: u16 = 0x100;
pub const audio_pid: u16 = 0x101;
/// Added to every PTS/DTS (90 kHz ticks) so PCR can trail the DTS.
pub const ts_base: u64 = 90_000;

pub fn crc32Mpeg(data: []const u8) u32 {
    var crc: u32 = 0xFFFF_FFFF;
    for (data) |b| {
        crc ^= @as(u32, b) << 24;
        for (0..8) |_| {
            crc = if (crc & 0x8000_0000 != 0) (crc << 1) ^ 0x04C1_1DB7 else crc << 1;
        }
    }
    return crc;
}

/// Continuity counters per PID.
pub const Counters = struct {
    pat: u4 = 0,
    pmt: u4 = 0,
    video: u4 = 0,
    audio: u4 = 0,
};

fn writePsi(w: *Writer, pid: u16, cc: *u4, section: []const u8) Writer.Error!void {
    var pkt: [packet_len]u8 = @splat(0xFF);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | @as(u8, @intCast(pid >> 8));
    pkt[2] = @truncate(pid);
    pkt[3] = 0x10 | @as(u8, cc.*);
    cc.* +%= 1;
    pkt[4] = 0; // pointer_field
    @memcpy(pkt[5..][0..section.len], section);
    try w.writeAll(&pkt);
}

/// Emit one PAT packet and one PMT packet.
pub fn writePatPmt(w: *Writer, cc: *Counters, has_audio: bool) Writer.Error!void {
    var sec: [64]u8 = undefined;
    // PAT
    sec[0] = 0x00;
    sec[1] = 0xB0;
    sec[2] = 13;
    sec[3] = 0;
    sec[4] = 1; // transport_stream_id
    sec[5] = 0xC1;
    sec[6] = 0;
    sec[7] = 0;
    sec[8] = 0;
    sec[9] = 1; // program_number
    sec[10] = 0xE0 | @as(u8, @intCast(pmt_pid >> 8));
    sec[11] = @truncate(pmt_pid);
    std.mem.writeInt(u32, sec[12..16], crc32Mpeg(sec[0..12]), .big);
    try writePsi(w, 0, &cc.pat, sec[0..16]);
    // PMT
    const nstreams: u8 = if (has_audio) 2 else 1;
    const len: u8 = 9 + 5 * nstreams + 4;
    sec[0] = 0x02;
    sec[1] = 0xB0;
    sec[2] = len;
    sec[3] = 0;
    sec[4] = 1; // program_number
    sec[5] = 0xC1;
    sec[6] = 0;
    sec[7] = 0;
    sec[8] = 0xE0 | @as(u8, @intCast(video_pid >> 8));
    sec[9] = @truncate(video_pid); // PCR pid
    sec[10] = 0xF0;
    sec[11] = 0; // program_info_length
    var o: usize = 12;
    sec[o..][0..5].* = .{ 0x1B, 0xE0 | @as(u8, @intCast(video_pid >> 8)), @truncate(video_pid), 0xF0, 0 };
    o += 5;
    if (has_audio) {
        sec[o..][0..5].* = .{ 0x0F, 0xE0 | @as(u8, @intCast(audio_pid >> 8)), @truncate(audio_pid), 0xF0, 0 };
        o += 5;
    }
    std.mem.writeInt(u32, sec[o..][0..4], crc32Mpeg(sec[0..o]), .big);
    o += 4;
    try writePsi(w, pmt_pid, &cc.pmt, sec[0..o]);
}

fn encodePcr(base: u64) [6]u8 {
    const b = base & 0x1_FFFF_FFFF;
    return .{
        @truncate(b >> 25),
        @truncate(b >> 17),
        @truncate(b >> 9),
        @truncate(b >> 1),
        @as(u8, @truncate(b & 1)) << 7 | 0x7E,
        0,
    };
}

/// Packetize `head ++ data` (a PES packet) into 188-byte TS packets.
pub fn writePackets(
    w: *Writer,
    pid: u16,
    cc: *u4,
    head: []const u8,
    data: []const u8,
    pcr_base: ?u64,
    random_access: bool,
) Writer.Error!void {
    const total = head.len + data.len;
    var pos: usize = 0;
    var first = true;
    while (pos < total) {
        var pkt: [packet_len]u8 = undefined;
        const remaining = total - pos;
        const min_af: usize = if (first and pcr_base != null) 8 else if (first and random_access) 2 else 0;
        const avail = 184 - min_af;
        var n: usize = undefined;
        var af: usize = undefined;
        if (remaining >= avail) {
            n = avail;
            af = min_af;
        } else {
            n = remaining;
            af = 184 - n;
        }
        pkt[0] = 0x47;
        pkt[1] = (if (first) @as(u8, 0x40) else 0) | @as(u8, @intCast(pid >> 8));
        pkt[2] = @truncate(pid);
        pkt[3] = (if (af > 0) @as(u8, 0x30) else 0x10) | @as(u8, cc.*);
        cc.* +%= 1;
        if (af > 0) {
            pkt[4] = @intCast(af - 1);
            if (af > 1) {
                var flags: u8 = 0;
                if (first and random_access) flags |= 0x40;
                if (first and pcr_base != null) flags |= 0x10;
                pkt[5] = flags;
                var o: usize = 6;
                if (first and pcr_base != null) {
                    pkt[6..12].* = encodePcr(pcr_base.?);
                    o = 12;
                }
                @memset(pkt[o .. 4 + af], 0xFF);
            }
        }
        // payload from head ++ data
        var dst: usize = 4 + af;
        var p = pos;
        var left = n;
        if (p < head.len) {
            const k = @min(left, head.len - p);
            @memcpy(pkt[dst..][0..k], head[p..][0..k]);
            dst += k;
            p += k;
            left -= k;
        }
        if (left > 0) @memcpy(pkt[dst..][0..left], data[p - head.len ..][0..left]);
        try w.writeAll(&pkt);
        pos += n;
        first = false;
    }
}

fn encodeTs(marker: u8, ts: u64) [5]u8 {
    const t = ts & 0x1_FFFF_FFFF;
    return .{
        (marker << 4) | @as(u8, @truncate((t >> 30) & 7)) << 1 | 1,
        @truncate(t >> 22),
        @as(u8, @truncate((t >> 15) & 0x7F)) << 1 | 1,
        @truncate(t >> 7),
        @as(u8, @truncate(t & 0x7F)) << 1 | 1,
    };
}

/// Video PES header (14 or 19 bytes). PES length is 0 (unbounded) as allowed for video.
pub fn videoPesHeader(buf: *[19]u8, pts: u64, dts: u64) []const u8 {
    buf[0..4].* = .{ 0, 0, 1, 0xE0 };
    buf[4] = 0;
    buf[5] = 0;
    buf[6] = 0x80;
    if (pts != dts) {
        buf[7] = 0xC0;
        buf[8] = 10;
        buf[9..14].* = encodeTs(3, pts);
        buf[14..19].* = encodeTs(1, dts);
        return buf[0..19];
    }
    buf[7] = 0x80;
    buf[8] = 5;
    buf[9..14].* = encodeTs(2, pts);
    return buf[0..14];
}

pub fn audioPesHeader(buf: *[14]u8, pts: u64, payload_len: usize) []const u8 {
    const len = 3 + 5 + payload_len;
    buf[0..4].* = .{ 0, 0, 1, 0xC0 };
    std.mem.writeInt(u16, buf[4..6], if (len > 0xFFFF) 0 else @intCast(len), .big);
    buf[6] = 0x80;
    buf[7] = 0x80;
    buf[8] = 5;
    buf[9..14].* = encodeTs(2, pts);
    return buf[0..14];
}

pub const AudioConfig = struct {
    aot: u8,
    freq_index: u8,
    channels: u8,

    pub fn parse(asc: []const u8) error{BadAudioConfig}!AudioConfig {
        if (asc.len < 2) return error.BadAudioConfig;
        const aot = asc[0] >> 3;
        const fi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
        const ch = (asc[1] >> 3) & 0x0F;
        if (aot == 0 or aot >= 31 or fi >= 13 or ch == 0 or ch > 7) return error.BadAudioConfig;
        return .{ .aot = aot, .freq_index = fi, .channels = ch };
    }

    pub fn adtsHeader(c: AudioConfig, payload_len: usize) [7]u8 {
        const fl: u32 = @intCast(payload_len + 7);
        return .{
            0xFF,
            0xF1,
            ((c.aot - 1) << 6) | (c.freq_index << 2) | ((c.channels >> 2) & 1),
            ((c.channels & 3) << 6) | @as(u8, @truncate((fl >> 11) & 3)),
            @truncate(fl >> 3),
            (@as(u8, @truncate(fl & 7)) << 5) | 0x1F,
            0xFC,
        };
    }
};

pub const VideoConfig = struct {
    nal_len_size: u8,
    /// SPS and PPS as Annex B (start-code prefixed).
    annexb_params: []u8,

    pub fn parse(gpa: Allocator, avcc: []const u8) !VideoConfig {
        if (avcc.len < 7 or avcc[0] != 1) return error.BadVideoConfig;
        const nal_len_size = (avcc[4] & 3) + 1;
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(gpa);
        var o: usize = 5;
        const nsps = avcc[o] & 0x1F;
        o += 1;
        for (0..nsps) |_| {
            if (o + 2 > avcc.len) return error.BadVideoConfig;
            const l = std.mem.readInt(u16, avcc[o..][0..2], .big);
            o += 2;
            if (o + l > avcc.len) return error.BadVideoConfig;
            try out.appendSlice(gpa, &.{ 0, 0, 0, 1 });
            try out.appendSlice(gpa, avcc[o..][0..l]);
            o += l;
        }
        if (o >= avcc.len) return error.BadVideoConfig;
        const npps = avcc[o];
        o += 1;
        for (0..npps) |_| {
            if (o + 2 > avcc.len) return error.BadVideoConfig;
            const l = std.mem.readInt(u16, avcc[o..][0..2], .big);
            o += 2;
            if (o + l > avcc.len) return error.BadVideoConfig;
            try out.appendSlice(gpa, &.{ 0, 0, 0, 1 });
            try out.appendSlice(gpa, avcc[o..][0..l]);
            o += l;
        }
        return .{ .nal_len_size = nal_len_size, .annexb_params = try out.toOwnedSlice(gpa) };
    }
};

/// Convert an AVCC access unit to Annex B. Adds an AUD, and on keyframes prepends SPS/PPS
/// (dropping in-band SPS/PPS/AUD NALs to avoid duplicates).
pub fn avccToAnnexB(
    gpa: Allocator,
    out: *std.ArrayList(u8),
    cfg: VideoConfig,
    keyframe: bool,
    au: []const u8,
) !void {
    out.clearRetainingCapacity();
    try out.appendSlice(gpa, &.{ 0, 0, 0, 1, 0x09, 0xF0 });
    if (keyframe) try out.appendSlice(gpa, cfg.annexb_params);
    var o: usize = 0;
    const ls = cfg.nal_len_size;
    while (o + ls <= au.len) {
        var l: usize = 0;
        for (au[o..][0..ls]) |b| l = (l << 8) | b;
        o += ls;
        if (l == 0) continue;
        if (o + l > au.len) return error.BadVideoChunk;
        const t = au[o] & 0x1F;
        if (t != 7 and t != 8 and t != 9) {
            try out.appendSlice(gpa, &.{ 0, 0, 0, 1 });
            try out.appendSlice(gpa, au[o..][0..l]);
        }
        o += l;
    }
}

// ---------------------------------------------------------------------------------------------
// Ring buffer / clipper

pub const ExportInfo = struct {
    start_ms: u32,
    end_ms: u32,
    bytes: usize,
};

pub const Clipper = struct {
    gpa: Allocator,
    max_ms: u32,
    max_bytes: usize,
    segments: std.ArrayList(Segment) = .empty,
    total_bytes: usize = 0,
    latest_ms: u32 = 0,
    vcfg: ?VideoConfig = null,
    acfg: ?AudioConfig = null,
    annexb: std.ArrayList(u8) = .empty,
    cc: Counters = .{},

    const Segment = struct {
        start_ms: u32,
        data: std.ArrayList(u8),
    };

    pub const Options = struct {
        /// Minimum retained history in ms (buffer keeps at least this much, up to one GOP more).
        max_ms: u32 = 300_000,
        /// Hard memory cap; oldest segments are dropped beyond this.
        max_bytes: usize = 256 * 1024 * 1024,
    };

    pub fn init(gpa: Allocator, opts: Options) Clipper {
        return .{ .gpa = gpa, .max_ms = opts.max_ms, .max_bytes = opts.max_bytes };
    }

    pub fn deinit(c: *Clipper) void {
        for (c.segments.items) |*s| s.data.deinit(c.gpa);
        c.segments.deinit(c.gpa);
        if (c.vcfg) |v| c.gpa.free(v.annexb_params);
        c.annexb.deinit(c.gpa);
    }

    pub fn setVideoConfig(c: *Clipper, avcc: []const u8) !void {
        const v = try VideoConfig.parse(c.gpa, avcc);
        if (c.vcfg) |old| c.gpa.free(old.annexb_params);
        c.vcfg = v;
    }

    pub fn setAudioConfig(c: *Clipper, asc: []const u8) !void {
        c.acfg = try AudioConfig.parse(asc);
    }

    pub fn bufferedMs(c: *const Clipper) u32 {
        if (c.segments.items.len == 0) return 0;
        return c.latest_ms - c.segments.items[0].start_ms;
    }

    pub fn segmentCount(c: *const Clipper) usize {
        return c.segments.items.len;
    }

    fn dropOldest(c: *Clipper) void {
        var s = c.segments.orderedRemove(0);
        c.total_bytes -= s.data.items.len;
        s.data.deinit(c.gpa);
    }

    fn trim(c: *Clipper) void {
        while (c.segments.items.len > 1 and
            (c.latest_ms - c.segments.items[1].start_ms >= c.max_ms or c.total_bytes > c.max_bytes))
        {
            c.dropOldest();
        }
    }

    fn current(c: *Clipper) *Segment {
        return &c.segments.items[c.segments.items.len - 1];
    }

    /// Append `n_max` bytes of space, run `f` to fill, then shrink to the bytes actually written.
    fn appendWith(c: *Clipper, seg: *Segment, n_max: usize) ![]u8 {
        return try seg.data.addManyAsSlice(c.gpa, n_max);
    }

    pub fn pushVideo(c: *Clipper, dts_ms: u32, cts_ms: i32, keyframe: bool, au: []const u8) !void {
        const cfg = c.vcfg orelse return error.MissingVideoConfig;
        if (keyframe) {
            try c.segments.append(c.gpa, .{ .start_ms = dts_ms, .data = .empty });
        } else if (c.segments.items.len == 0) {
            return; // wait for first keyframe
        }
        c.latest_ms = @max(c.latest_ms, dts_ms);
        try avccToAnnexB(c.gpa, &c.annexb, cfg, keyframe, au);

        const dts90 = @as(u64, dts_ms) * 90 + ts_base;
        const pts_ms: i64 = @as(i64, dts_ms) + cts_ms;
        const pts90 = @as(u64, @intCast(@max(pts_ms, 0))) * 90 + ts_base;
        var hb: [19]u8 = undefined;
        const head = videoPesHeader(&hb, pts90, dts90);

        const seg = c.current();
        const total = head.len + c.annexb.items.len;
        const max_n = (total / 184 + 2) * packet_len + 2 * packet_len;
        const base_len = seg.data.items.len;
        const slice = try c.appendWith(seg, max_n);
        var w: Writer = .fixed(slice);
        if (keyframe) try writePatPmt(&w, &c.cc, c.acfg != null);
        try writePackets(&w, video_pid, &c.cc.video, head, c.annexb.items, (dts90 - ts_base), keyframe);
        seg.data.shrinkRetainingCapacity(base_len + w.end);
        c.total_bytes += w.end;
        if (keyframe) c.trim();
    }

    pub fn pushAudio(c: *Clipper, dts_ms: u32, raw: []const u8) !void {
        const cfg = c.acfg orelse return error.MissingAudioConfig;
        if (c.segments.items.len == 0) return;
        c.latest_ms = @max(c.latest_ms, dts_ms);
        const adts = cfg.adtsHeader(raw.len);
        var hb: [14]u8 = undefined;
        const pts90 = @as(u64, dts_ms) * 90 + ts_base;
        const head_pes = audioPesHeader(&hb, pts90, raw.len + 7);
        var head: [21]u8 = undefined;
        @memcpy(head[0..14], head_pes);
        @memcpy(head[14..21], &adts);

        const seg = c.current();
        const max_n = ((21 + raw.len) / 184 + 2) * packet_len;
        const base_len = seg.data.items.len;
        const slice = try c.appendWith(seg, max_n);
        var w: Writer = .fixed(slice);
        try writePackets(&w, audio_pid, &c.cc.audio, &head, raw, null, false);
        seg.data.shrinkRetainingCapacity(base_len + w.end);
        c.total_bytes += w.end;
    }

    /// Write the last `seconds_back` seconds (rounded out to the previous keyframe) as a TS stream.
    pub fn exportClip(c: *const Clipper, w: *Writer, seconds_back: u32) !ExportInfo {
        if (c.segments.items.len == 0) return error.EmptyBuffer;
        const back = @as(u64, seconds_back) * 1000;
        const target: u64 = if (back > c.latest_ms) 0 else c.latest_ms - back;
        var idx: usize = 0;
        for (c.segments.items, 0..) |s, i| {
            if (s.start_ms <= target) idx = i else break;
        }
        var bytes: usize = 0;
        for (c.segments.items[idx..]) |s| {
            try w.writeAll(s.data.items);
            bytes += s.data.items.len;
        }
        return .{ .start_ms = c.segments.items[idx].start_ms, .end_ms = c.latest_ms, .bytes = bytes };
    }
};

// ---------------------------------------------------------------------------------------------
// Tests

const testing = std.testing;

test "crc32 mpeg matches the well-known PAT" {
    try testing.expectEqual(@as(u32, 0x2AB104B2), crc32Mpeg(&.{ 0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00 }));
}

test "PAT packet bytes" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cc: Counters = .{};
    try writePatPmt(&w, &cc, true);
    const out = w.buffered();
    try testing.expectEqual(@as(usize, 376), out.len);
    try testing.expectEqualSlices(u8, &.{ 0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00, 0x2A, 0xB1, 0x04, 0xB2 }, out[0..21]);
    try testing.expectEqual(@as(u8, 0xFF), out[21]);
    // PMT packet on pid 0x1000
    try testing.expectEqual(@as(u8, 0x47), out[188]);
    try testing.expectEqual(@as(u8, 0x50), out[189]);
    try testing.expectEqual(@as(u8, 0x00), out[190]);
    // section CRC verifies: crc over the whole section including CRC == 0
    const sec_len = @as(usize, out[188 + 6] & 0x0F) << 8 | out[188 + 7];
    try testing.expectEqual(@as(u32, 0), crc32Mpeg(out[188 + 5 ..][0 .. 3 + sec_len]));
}

test "packetizer: sizes, sync, continuity, stuffing, reassembly" {
    var buf: [4096]u8 = undefined;
    var w: Writer = .fixed(&buf);
    var cc: u4 = 14; // wraps
    var data: [400]u8 = undefined;
    for (&data, 0..) |*b, i| b.* = @truncate(i);
    try writePackets(&w, 0x100, &cc, &.{ 1, 2, 3 }, &data, 123456, true);
    const out = w.buffered();
    try testing.expectEqual(@as(usize, 0), out.len % 188);
    try testing.expectEqual(@as(usize, 3 * 188), out.len); // 403 bytes: 176 + 184 + 43
    var rebuilt: [403]u8 = undefined;
    var n: usize = 0;
    for (0..3) |i| {
        const p = out[i * 188 ..][0..188];
        try testing.expectEqual(@as(u8, 0x47), p[0]);
        try testing.expectEqual(@as(u8, @intCast((14 + i) & 15)), p[3] & 0x0F);
        try testing.expectEqual(i == 0, p[1] & 0x40 != 0);
        var off: usize = 4;
        if (p[3] & 0x20 != 0) off += 1 + p[4];
        if (i == 0) {
            try testing.expectEqual(@as(u8, 0x50), p[5]); // RAI + PCR
            try testing.expectEqual(@as(usize, 12), off);
        }
        @memcpy(rebuilt[n..][0 .. 188 - off], p[off..]);
        n += 188 - off;
    }
    try testing.expectEqual(@as(usize, 403), n);
    try testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, rebuilt[0..3]);
    try testing.expectEqualSlices(u8, &data, rebuilt[3..]);
}

test "pes timestamps encode" {
    var hb: [19]u8 = undefined;
    const h = videoPesHeader(&hb, 90_000, 90_000);
    try testing.expectEqual(@as(usize, 14), h.len);
    // PTS=90000 => 0x00015F90
    try testing.expectEqualSlices(u8, &.{ 0x21, 0x00, 0x05, 0xBF, 0x21 }, h[9..14]);
    const h2 = videoPesHeader(&hb, 93_600, 90_000);
    try testing.expectEqual(@as(usize, 19), h2.len);
    try testing.expectEqual(@as(u8, 0x31), h2[9]);
    try testing.expectEqual(@as(u8, 0x11), h2[14]);
}

test "adts header" {
    // AAC-LC 48kHz stereo: ASC 0x11 0x90
    const c = try AudioConfig.parse(&.{ 0x11, 0x90 });
    try testing.expectEqual(@as(u8, 2), c.aot);
    try testing.expectEqual(@as(u8, 3), c.freq_index);
    try testing.expectEqual(@as(u8, 2), c.channels);
    const h = c.adtsHeader(100);
    try testing.expectEqualSlices(u8, &.{ 0xFF, 0xF1, 0x4C, 0x80, 0x0D, 0x7F, 0xFC }, &h);
    try testing.expectError(error.BadAudioConfig, AudioConfig.parse(&.{0x11}));
}

const test_avcc = [_]u8{ 1, 0x42, 0xC0, 0x1F, 0xFF, 0xE1, 0, 3, 0x67, 1, 2, 1, 0, 2, 0x68, 9 };

test "avcc -> annexb with param sets on keyframes" {
    const cfg = try VideoConfig.parse(testing.allocator, &test_avcc);
    defer testing.allocator.free(cfg.annexb_params);
    try testing.expectEqual(@as(u8, 4), cfg.nal_len_size);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 9 }, cfg.annexb_params);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(testing.allocator);
    // AU: in-band SPS (dropped), IDR slice (len 3)
    const au = [_]u8{ 0, 0, 0, 2, 0x67, 7, 0, 0, 0, 3, 0x65, 0xAA, 0xBB };
    try avccToAnnexB(testing.allocator, &out, cfg, true, &au);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0, 1, 9, 0xF0, 0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 9, 0, 0, 0, 1, 0x65, 0xAA, 0xBB }, out.items);
    try avccToAnnexB(testing.allocator, &out, cfg, false, &.{ 0, 0, 0, 2, 0x41, 5 });
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0, 1, 9, 0xF0, 0, 0, 0, 1, 0x41, 5 }, out.items);
    try testing.expectError(error.BadVideoChunk, avccToAnnexB(testing.allocator, &out, cfg, false, &.{ 0, 0, 0, 9, 0x41 }));
}

fn fillClipper(c: *Clipper, seconds: u32, gop_ms: u32) !void {
    const au_key = [_]u8{ 0, 0, 0, 3, 0x65, 0xAA, 0xBB };
    const au_p = [_]u8{ 0, 0, 0, 2, 0x41, 5 };
    var t: u32 = 0;
    while (t < seconds * 1000) : (t += 33) {
        const key = t % gop_ms < 33;
        try c.pushVideo(t, 0, key, if (key) &au_key else &au_p);
        if (t % 21 < 33) try c.pushAudio(t, &.{ 1, 2, 3, 4 });
    }
}

test "clipper: ring trims old segments and keeps at least max_ms" {
    var c = Clipper.init(testing.allocator, .{ .max_ms = 10_000 });
    defer c.deinit();
    try c.setVideoConfig(&test_avcc);
    try c.setAudioConfig(&.{ 0x11, 0x90 });
    try fillClipper(&c, 60, 2000);
    try testing.expect(c.bufferedMs() >= 10_000);
    try testing.expect(c.bufferedMs() < 10_000 + 2 * 2000 + 100);
    try testing.expect(c.segmentCount() <= 7);
}

test "clipper: export starts at keyframe segment with PAT/PMT and valid packets" {
    var c = Clipper.init(testing.allocator, .{ .max_ms = 60_000 });
    defer c.deinit();
    try c.setVideoConfig(&test_avcc);
    try c.setAudioConfig(&.{ 0x11, 0x90 });
    try fillClipper(&c, 20, 2000);
    var aw: Writer.Allocating = .init(testing.allocator);
    defer aw.deinit();
    const info = try c.exportClip(&aw.writer, 5);
    const out = aw.written();
    try testing.expectEqual(info.bytes, out.len);
    try testing.expectEqual(@as(usize, 0), out.len % 188);
    try testing.expect(info.start_ms <= 20_000 - 5_000);
    try testing.expect(info.start_ms >= 20_000 - 5_000 - 2_000);
    // First packet is PAT, second PMT, third a video packet with random access.
    try testing.expectEqual(@as(u16, 0), (@as(u16, out[1] & 0x1F) << 8) | out[2]);
    try testing.expectEqual(@as(u16, pmt_pid), (@as(u16, out[189] & 0x1F) << 8) | out[190]);
    try testing.expectEqual(@as(u16, video_pid), (@as(u16, out[377] & 0x1F) << 8) | out[378]);
    try testing.expectEqual(@as(u8, 0x40), out[376 + 5] & 0x40);
    var i: usize = 0;
    while (i < out.len) : (i += 188) try testing.expectEqual(@as(u8, 0x47), out[i]);
    // Asking for more than buffered returns everything from the first segment.
    var aw2: Writer.Allocating = .init(testing.allocator);
    defer aw2.deinit();
    const all = try c.exportClip(&aw2.writer, 1000);
    try testing.expectEqual(@as(u32, 0), all.start_ms);
}

test "clipper: empty / pre-keyframe behaviour and memory cap" {
    var c = Clipper.init(testing.allocator, .{ .max_ms = 1_000_000, .max_bytes = 4000 });
    defer c.deinit();
    var aw: Writer.Allocating = .init(testing.allocator);
    defer aw.deinit();
    try testing.expectError(error.EmptyBuffer, c.exportClip(&aw.writer, 5));
    try testing.expectError(error.MissingVideoConfig, c.pushVideo(0, 0, true, &.{ 0, 0, 0, 1, 0x65 }));
    try c.setVideoConfig(&test_avcc);
    try c.setAudioConfig(&.{ 0x11, 0x90 });
    try c.pushVideo(0, 0, false, &.{ 0, 0, 0, 2, 0x41, 5 }); // dropped: no keyframe yet
    try testing.expectEqual(@as(usize, 0), c.segmentCount());
    try fillClipper(&c, 30, 1000);
    try testing.expectEqual(@as(usize, 1), c.segmentCount()); // cap forces newest segment only
}
