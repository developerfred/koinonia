//! Fan-out of encoded media to multiple RTMP destinations.
//!
//! Each destination has a `Sink` with its own bounded queue; `Fanout.push*` copies the chunk
//! into every sink queue and never blocks. Overflowing queues drop non-key video (and wait for
//! the next keyframe) so a slow destination can neither stall the others nor the ingest socket.

const std = @import("std");
const Io = std.Io;
const rtmp = @import("rtmp.zig");
const flv = @import("flv.zig");
const Allocator = std.mem.Allocator;

const log = std.log.scoped(.fanout);

pub const ItemKind = enum { video, audio };

pub const Item = struct {
    kind: ItemKind,
    ts: u32,
    key: bool = false,
    cts: i32 = 0,
    data: []u8,
};

pub const State = enum(u8) { connecting, live, reconnecting, failed, stopped };

pub const Queue = struct {
    gpa: Allocator,
    mutex: Io.Mutex = .init,
    cond: Io.Condition = .init,
    items: std.ArrayList(Item) = .empty,
    bytes: usize = 0,
    max_items: usize,
    max_bytes: usize,
    closed: bool = false,
    /// After dropping video we ignore delta frames until the next keyframe.
    need_key: bool = true,
    dropped: u64 = 0,

    pub fn init(gpa: Allocator, max_items: usize, max_bytes: usize) Queue {
        return .{ .gpa = gpa, .max_items = max_items, .max_bytes = max_bytes };
    }

    pub fn deinit(q: *Queue) void {
        for (q.items.items) |it| q.gpa.free(it.data);
        q.items.deinit(q.gpa);
    }

    fn freeItem(q: *Queue, it: Item) void {
        q.bytes -= it.data.len;
        q.gpa.free(it.data);
    }

    /// Drop every queued delta video frame (keeps audio and keyframes that are already queued
    /// only if no delta precedes them -- simplest safe rule: drop all non-key video).
    fn dropDeltas(q: *Queue) void {
        var w: usize = 0;
        for (q.items.items) |it| {
            if (it.kind == .video and !it.key) {
                q.freeItem(it);
                q.dropped += 1;
            } else {
                q.items.items[w] = it;
                w += 1;
            }
        }
        q.items.shrinkRetainingCapacity(w);
        q.need_key = true;
    }

    /// Takes ownership of `item.data`. Never blocks.
    pub fn push(q: *Queue, io: Io, item: Item) void {
        q.mutex.lockUncancelable(io);
        defer q.mutex.unlock(io);
        if (q.closed or (item.kind == .video and !item.key and q.need_key)) {
            if (!q.closed) q.dropped += 1;
            q.gpa.free(item.data);
            return;
        }
        if (item.kind == .video and item.key) q.need_key = false;
        q.items.append(q.gpa, item) catch {
            q.gpa.free(item.data);
            q.dropped += 1;
            return;
        };
        q.bytes += item.data.len;
        if (q.items.items.len > q.max_items or q.bytes > q.max_bytes) {
            // Keep the new item; shed deltas. If still over limit (all keyframes/audio),
            // shed the oldest items outright.
            const newest = q.items.pop().?;
            q.bytes -= newest.data.len;
            q.dropDeltas();
            if (newest.kind == .video and !newest.key) {
                // its references were just dropped: it is undecodable
                q.gpa.free(newest.data);
                q.dropped += 1;
                return;
            }
            while (q.items.items.len >= q.max_items or q.bytes + newest.data.len > q.max_bytes) {
                if (q.items.items.len == 0) break;
                const old = q.items.orderedRemove(0);
                q.freeItem(old);
                q.dropped += 1;
            }
            q.items.append(q.gpa, newest) catch {
                q.gpa.free(newest.data);
                q.dropped += 1;
                return;
            };
            q.bytes += newest.data.len;
            if (newest.kind == .video and newest.key) q.need_key = false;
        }
        q.cond.signal(io);
    }

    /// Blocks until an item is available. Returns null once closed and drained.
    /// Caller owns `item.data`.
    pub fn pop(q: *Queue, io: Io) ?Item {
        q.mutex.lockUncancelable(io);
        defer q.mutex.unlock(io);
        while (q.items.items.len == 0) {
            if (q.closed) return null;
            q.cond.waitUncancelable(io, &q.mutex);
        }
        const it = q.items.orderedRemove(0);
        q.bytes -= it.data.len;
        return it;
    }

    pub fn close(q: *Queue, io: Io) void {
        q.mutex.lockUncancelable(io);
        q.closed = true;
        q.mutex.unlock(io);
        q.cond.broadcast(io);
    }

    /// Reopen after a reconnect: drop everything queued and wait for a keyframe.
    pub fn reset(q: *Queue, io: Io) void {
        q.mutex.lockUncancelable(io);
        defer q.mutex.unlock(io);
        for (q.items.items) |it| q.freeItem(it);
        q.items.clearRetainingCapacity();
        q.need_key = true;
    }
};

/// Latest stream parameters shared by all sinks (replayed on every (re)connect).
pub const Params = struct {
    meta: flv.Meta = .{},
    video_config: ?[]u8 = null,
    audio_config: ?[]u8 = null,
    /// Bumped whenever something changes.
    version: u32 = 0,
};

pub const Sink = struct {
    name: []const u8,
    queue: Queue,
    state: std.atomic.Value(State) = .init(.connecting),

    pub fn setState(s: *Sink, st: State) void {
        s.state.store(st, .release);
    }
    pub fn getState(s: *const Sink) State {
        return s.state.load(.acquire);
    }
};

pub const Fanout = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    params: Params = .{},
    sinks: []Sink,

    pub fn init(gpa: Allocator, io: Io, names: []const []const u8, max_items: usize, max_bytes: usize) !Fanout {
        const sinks = try gpa.alloc(Sink, names.len);
        for (names, sinks) |n, *s| s.* = .{ .name = n, .queue = Queue.init(gpa, max_items, max_bytes) };
        return .{ .gpa = gpa, .io = io, .sinks = sinks };
    }

    pub fn deinit(f: *Fanout) void {
        for (f.sinks) |*s| s.queue.deinit();
        f.gpa.free(f.sinks);
        if (f.params.video_config) |v| f.gpa.free(v);
        if (f.params.audio_config) |a| f.gpa.free(a);
    }

    pub fn setMeta(f: *Fanout, meta: flv.Meta) void {
        f.mutex.lockUncancelable(f.io);
        defer f.mutex.unlock(f.io);
        f.params.meta = meta;
        f.params.version +%= 1;
    }

    pub fn setVideoConfig(f: *Fanout, avcc: []const u8) !void {
        const copy = try f.gpa.dupe(u8, avcc);
        f.mutex.lockUncancelable(f.io);
        defer f.mutex.unlock(f.io);
        if (f.params.video_config) |old| f.gpa.free(old);
        f.params.video_config = copy;
        f.params.version +%= 1;
    }

    pub fn setAudioConfig(f: *Fanout, asc: []const u8) !void {
        const copy = try f.gpa.dupe(u8, asc);
        f.mutex.lockUncancelable(f.io);
        defer f.mutex.unlock(f.io);
        if (f.params.audio_config) |old| f.gpa.free(old);
        f.params.audio_config = copy;
        f.params.version +%= 1;
    }

    pub const ParamsSnapshot = struct { meta: flv.Meta, video_config: ?[]u8, audio_config: ?[]u8, version: u32 };

    /// Copy of the current params; caller frees the config slices with `freeSnapshot`.
    pub fn snapshot(f: *Fanout) !ParamsSnapshot {
        f.mutex.lockUncancelable(f.io);
        defer f.mutex.unlock(f.io);
        const v = if (f.params.video_config) |x| try f.gpa.dupe(u8, x) else null;
        errdefer if (v) |x| f.gpa.free(x);
        const a = if (f.params.audio_config) |x| try f.gpa.dupe(u8, x) else null;
        return .{ .meta = f.params.meta, .video_config = v, .audio_config = a, .version = f.params.version };
    }

    pub fn freeSnapshot(f: *Fanout, s: ParamsSnapshot) void {
        if (s.video_config) |x| f.gpa.free(x);
        if (s.audio_config) |x| f.gpa.free(x);
    }

    pub fn version(f: *Fanout) u32 {
        f.mutex.lockUncancelable(f.io);
        defer f.mutex.unlock(f.io);
        return f.params.version;
    }

    pub fn pushVideo(f: *Fanout, ts: u32, key: bool, cts: i32, data: []const u8) void {
        f.pushItem(.video, ts, key, cts, data);
    }

    pub fn pushAudio(f: *Fanout, ts: u32, data: []const u8) void {
        f.pushItem(.audio, ts, false, 0, data);
    }

    fn pushItem(f: *Fanout, kind: ItemKind, ts: u32, key: bool, cts: i32, data: []const u8) void {
        for (f.sinks) |*s| {
            const copy = f.gpa.dupe(u8, data) catch {
                s.queue.dropped += 1;
                continue;
            };
            s.queue.push(f.io, .{ .kind = kind, .ts = ts, .key = key, .cts = cts, .data = copy });
        }
    }

    pub fn closeAll(f: *Fanout) void {
        for (f.sinks) |*s| s.queue.close(f.io);
    }

    pub fn dropped(f: *Fanout, idx: usize) u64 {
        const q = &f.sinks[idx].queue;
        q.mutex.lockUncancelable(f.io);
        defer q.mutex.unlock(f.io);
        return q.dropped;
    }
};

/// After a successful `Publisher.publish`, send metadata and configs, then pump queued media
/// until the queue is closed (returns normally, sending end-of-stream) or an I/O error occurs.
pub fn pump(fan: *Fanout, sink: *Sink, pub_: *rtmp.Publisher) !void {
    // Read the server's control traffic concurrently (window acks, pings, chunk size changes);
    // otherwise long streams get dropped for never acknowledging received bytes.
    pub_.enableLocking(fan.io);
    var ctl_err: std.atomic.Value(bool) = .init(false);
    var ctl: Io.Group = .init;
    defer ctl.cancel(fan.io);
    ctl.concurrent(fan.io, controlLoop, .{ pub_, &ctl_err }) catch |e| {
        log.warn("control reader unavailable ({s}); acks disabled", .{@errorName(e)});
    };

    var snap = try fan.snapshot();
    defer fan.freeSnapshot(snap);
    try pub_.sendMetadata(snap.meta);
    try sendConfigs(pub_, snap, 0, 0);
    sink.setState(.live);

    var base: ?u32 = null;
    var last_ts: u32 = 0;
    var last_v_ts: u32 = 0; // per-track: a header must not be stamped later than that track's next frame
    var last_a_ts: u32 = 0;
    while (sink.queue.pop(fan.io)) |item| {
        defer fan.gpa.free(item.data);
        if (ctl_err.load(.acquire)) return error.ConnectionClosed;
        if (fan.version() != snap.version) {
            fan.freeSnapshot(snap);
            snap = try fan.snapshot();
            // re-sent sequence headers must carry the current stream time, not 0 (timestamps may never go backwards)
            try sendConfigs(pub_, snap, last_v_ts, last_a_ts);
        }
        const b = base orelse blk: {
            base = item.ts;
            break :blk item.ts;
        };
        const ts = if (item.ts >= b) item.ts - b else 0;
        last_ts = ts;
        if (item.kind == .video) last_v_ts = ts else last_a_ts = ts;
        switch (item.kind) {
            .video => try pub_.sendVideo(ts, item.key, item.cts, item.data),
            .audio => try pub_.sendAudio(ts, item.data),
        }
    }
    try pub_.sendEndOfStream(last_ts);
}

fn controlLoop(pub_: *rtmp.Publisher, failed: *std.atomic.Value(bool)) void {
    const err = pub_.serviceControl();
    // Cancellation (pump finished) and a clean close are not flagged here: after a close the
    // next media write fails and the destination loop reconnects. Protocol/IO errors are.
    if (err != error.Canceled and err != error.EndOfStream) failed.store(true, .release);
}

fn sendConfigs(pub_: *rtmp.Publisher, snap: Fanout.ParamsSnapshot, v_ts: u32, a_ts: u32) !void {
    if (snap.video_config) |v| try pub_.sendVideoConfig(v_ts, v);
    if (snap.audio_config) |a| try pub_.sendAudioConfig(a_ts, a);
}

const testing = std.testing;

test "queue drops delta frames on overflow and waits for keyframe" {
    const io = testing.io;
    var q = Queue.init(testing.allocator, 4, 1 << 20);
    defer q.deinit();
    const mk = struct {
        fn f(kind: ItemKind, ts: u32, key: bool) Item {
            return .{ .kind = kind, .ts = ts, .key = key, .data = testing.allocator.dupe(u8, "x") catch unreachable };
        }
    }.f;
    q.push(io, mk(.video, 0, false)); // dropped: need keyframe first
    try testing.expectEqual(@as(usize, 0), q.items.items.len);
    q.push(io, mk(.video, 1, true));
    q.push(io, mk(.audio, 2, false));
    q.push(io, mk(.video, 3, false));
    q.push(io, mk(.video, 4, false));
    try testing.expectEqual(@as(usize, 4), q.items.items.len);
    q.push(io, mk(.video, 5, false)); // overflow -> deltas dropped, new one kept
    try testing.expect(q.dropped >= 3);
    // Remaining: key(1), audio(2); the overflowing delta is undecodable and dropped too
    try testing.expectEqual(@as(usize, 2), q.items.items.len);
    try testing.expectEqual(@as(u32, 1), q.items.items[0].ts);
    try testing.expectEqual(@as(u32, 2), q.items.items[1].ts);
    // Now need_key is set until next keyframe: deltas are ignored
    q.need_key = true;
    q.push(io, mk(.video, 6, false));
    q.push(io, mk(.video, 7, true));
    const first = q.pop(io).?;
    testing.allocator.free(first.data);
    try testing.expectEqual(@as(u32, 1), first.ts);
    q.close(io);
    var n: usize = 0;
    while (q.pop(io)) |it| {
        testing.allocator.free(it.data);
        n += 1;
    }
    try testing.expect(n >= 2);
    try testing.expect(q.pop(io) == null);
}

test "queue: slow sink does not block, pop returns null after close" {
    const io = testing.io;
    var q = Queue.init(testing.allocator, 2, 100);
    defer q.deinit();
    for (0..50) |i| {
        q.push(io, .{ .kind = .audio, .ts = @intCast(i), .data = try testing.allocator.dupe(u8, "abcdef") });
    }
    try testing.expect(q.items.items.len <= 2);
    try testing.expect(q.dropped >= 48);
    q.close(io);
    while (q.pop(io)) |it| testing.allocator.free(it.data);
}

test "fanout pump publishes configs and media, rebasing timestamps" {
    const io = testing.io;
    var fan = try Fanout.init(testing.allocator, io, &.{"t"}, 100, 1 << 20);
    defer fan.deinit();
    try fan.setVideoConfig(&.{ 1, 2, 3 });
    try fan.setAudioConfig(&.{ 0x11, 0x90 });
    fan.pushVideo(1000, true, 0, &.{ 0, 0, 0, 1, 0x65 });
    fan.pushAudio(1010, &.{ 9, 9 });
    fan.pushVideo(1033, false, 0, &.{ 0, 0, 0, 1, 0x41 });
    fan.closeAll();

    var cbuf: [8192]u8 = undefined;
    var cw: Io.Writer = .fixed(&cbuf);
    var empty: Io.Reader = .fixed(&.{});
    var p = rtmp.Publisher.init(testing.allocator, &empty, &cw);
    defer p.deinit();
    p.stream_id = 1;
    try pump(&fan, &fan.sinks[0], &p);
    try testing.expectEqual(State.live, fan.sinks[0].getState());

    // Parse what was written back with a chunk reader.
    var r: Io.Reader = .fixed(cw.buffered());
    var cr = rtmp.ChunkReader.init(testing.allocator);
    defer cr.deinit();
    var kinds: [8]u8 = undefined;
    var tss: [8]u32 = undefined;
    var n: usize = 0;
    while (cr.readMessage(&r)) |m| {
        kinds[n] = m.mtype;
        tss[n] = m.ts;
        n += 1;
    } else |err| try testing.expectEqual(error.EndOfStream, err);
    // meta, vcfg, acfg, video, audio, video, eos
    try testing.expectEqual(@as(usize, 7), n);
    try testing.expectEqual(rtmp.MsgType.data_amf0, kinds[0]);
    try testing.expectEqual(rtmp.MsgType.video, kinds[3]);
    try testing.expectEqual(@as(u32, 0), tss[3]);
    try testing.expectEqual(@as(u32, 10), tss[4]);
    try testing.expectEqual(@as(u32, 33), tss[5]);
}
