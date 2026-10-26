//! Network side of a destination: connect (TCP, TLS for rtmps), publish, pump, reconnect loop.
//! The stream key is only passed to `Publisher.publish`; it is never logged.

const std = @import("std");
const Io = std.Io;
const net = Io.net;
const tls = std.crypto.tls;
const Certificate = std.crypto.Certificate;
const rtmp = @import("rtmp.zig");
const fanout = @import("fanout.zig");
const config = @import("config.zig");

const log = std.log.scoped(.dest);

/// Shared CA bundle for rtmps destinations.
pub const TlsCtx = struct {
    bundle: Certificate.Bundle = .empty,
    lock: Io.RwLock = .init,
    loaded: bool = false,

    pub fn load(t: *TlsCtx, gpa: std.mem.Allocator, io: Io) !void {
        t.lock.lockUncancelable(io);
        defer t.lock.unlock(io);
        try t.bundle.rescan(gpa, io, Io.Timestamp.now(io, .real));
        t.loaded = true;
    }

    pub fn deinit(t: *TlsCtx, gpa: std.mem.Allocator) void {
        t.bundle.deinit(gpa);
    }
};

pub const Ctx = struct {
    gpa: std.mem.Allocator,
    io: Io,
    fan: *fanout.Fanout,
    tls: *TlsCtx,
    /// Set when the session ends; stops the reconnect loop.
    stopping: *std.atomic.Value(bool),
};

fn attempt(ctx: Ctx, sink: *fanout.Sink, dest: config.Destination) !void {
    const gpa = ctx.gpa;
    const io = ctx.io;
    const url = try rtmp.Url.parse(dest.url);
    const host = try net.HostName.init(url.host);
    const stream = try host.connect(io, url.port, .{ .mode = .stream });
    defer stream.close(io);

    var rand: [rtmp.handshake_len - 8]u8 = undefined;
    io.random(&rand);

    if (url.tls) {
        const buf_len = tls.Client.min_buffer_len;
        const bufs = try gpa.alloc(u8, buf_len * 4);
        defer gpa.free(bufs);
        var sr = stream.reader(io, bufs[0..buf_len]);
        var sw = stream.writer(io, bufs[buf_len .. 2 * buf_len]);
        var entropy: [tls.Client.Options.entropy_len]u8 = undefined;
        try io.randomSecure(&entropy);
        var client = try tls.Client.init(&sr.interface, &sw.interface, .{
            .host = .{ .explicit = url.host },
            .ca = .{ .bundle = .{ .gpa = gpa, .io = io, .lock = &ctx.tls.lock, .bundle = &ctx.tls.bundle } },
            .write_buffer = bufs[2 * buf_len .. 3 * buf_len],
            .read_buffer = bufs[3 * buf_len ..],
            .entropy = &entropy,
            .realtime_now = Io.Timestamp.now(io, .real),
        });
        var p = rtmp.Publisher.init(gpa, &client.reader, &client.writer);
        defer p.deinit();
        try p.publish(url, dest.key.reveal(), &rand);
        try fanout.pump(ctx.fan, sink, &p);
        client.end() catch {};
    } else {
        var rbuf: [16 * 1024]u8 = undefined;
        var wbuf: [16 * 1024]u8 = undefined;
        var sr = stream.reader(io, &rbuf);
        var sw = stream.writer(io, &wbuf);
        var p = rtmp.Publisher.init(gpa, &sr.interface, &sw.interface);
        defer p.deinit();
        try p.publish(url, dest.key.reveal(), &rand);
        try fanout.pump(ctx.fan, sink, &p);
    }
}

/// Runs until the sink queue is closed. Reconnects with exponential backoff.
pub fn run(ctx: Ctx, sink: *fanout.Sink, dest: config.Destination) void {
    var backoff_s: i64 = 1;
    var first = true;
    while (!ctx.stopping.load(.acquire)) {
        sink.setState(if (first) .connecting else .reconnecting);
        first = false;
        const res = attempt(ctx, sink, dest);
        if (ctx.stopping.load(.acquire)) break;
        if (res) |_| {
            break; // queue closed and drained: finished cleanly
        } else |err| {
            // Only the destination name and error tag are logged -- never URL or key.
            log.warn("destination {s}: {s}; retrying in {d}s", .{ sink.name, @errorName(err), backoff_s });
            sink.setState(.reconnecting);
        }
        sink.queue.reset(ctx.io);
        ctx.io.sleep(.fromSeconds(backoff_s), .awake) catch break;
        backoff_s = @min(backoff_s * 2, 15);
    }
    sink.setState(.stopped);
}
