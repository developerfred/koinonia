//! One ingest session: WebSocket connection from the studio -> clipper + fan-out to RTMP.

const std = @import("std");
const Io = std.Io;
const net = Io.net;
const framing = @import("framing.zig");
const ws = @import("ws.zig");
const ts = @import("ts.zig");
const flv = @import("flv.zig");
const config = @import("config.zig");
const fanout = @import("fanout.zig");
const destination = @import("destination.zig");

const log = std.log.scoped(.session);

pub const protocol_version = 1;
const max_ws_message = 8 * 1024 * 1024;

pub const App = struct {
    gpa: std.mem.Allocator,
    io: Io,
    cfg: config.Config,
    tls: *destination.TlsCtx,
    busy: std.atomic.Value(bool) = .init(false),
};

const ClipRequest = struct {
    seconds_back: u32 = 30,
    title: []const u8 = "",
};

const Session = struct {
    app: *App,
    w: *Io.Writer,
    wmutex: Io.Mutex = .init,
    clipper: ts.Clipper,
    fan: ?fanout.Fanout = null,
    workers: Io.Group = .init,
    stats: Io.Group = .init,
    stopping: std.atomic.Value(bool) = .init(false),
    in_bytes: std.atomic.Value(u64) = .init(0),
    dest_list: std.ArrayList(config.Destination) = .empty,
    started: bool = false,
    t0: Io.Timestamp,

    fn io(s: *Session) Io {
        return s.app.io;
    }

    fn sendFrameLocked(s: *Session, op: ws.Opcode, payload: []const u8) !void {
        s.wmutex.lockUncancelable(s.io());
        defer s.wmutex.unlock(s.io());
        try ws.writeFrame(s.w, op, payload);
        try s.w.flush();
    }

    /// Send a `status` frame whose JSON payload is `fmt` applied to `args`.
    fn status(s: *Session, comptime fmt: []const u8, args: anytype) void {
        var buf: [2048]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        const h = framing.encodeHeader(.{ .kind = .status, .flags = 0, .dts_ms = 0, .cts_offset_ms = 0, .payload = &.{} });
        w.writeAll(&h) catch return;
        w.print(fmt, args) catch return;
        s.sendFrameLocked(.binary, w.buffered()) catch {};
    }

    fn statusError(s: *Session, msg: []const u8) void {
        s.status("{{\"type\":\"error\",\"message\":{f}}}", .{std.json.fmt(msg, .{})});
    }

    fn onStart(s: *Session, payload: []const u8) !void {
        if (s.started) return s.statusError("already started");
        const gpa = s.app.gpa;
        var parsed = framing.parseStart(gpa, payload) catch return s.statusError("bad start payload");
        defer parsed.deinit();
        const st = parsed.value;

        if (st.destinations.len == 0) {
            try s.dest_list.appendSlice(gpa, s.app.cfg.destinations);
        } else {
            for (st.destinations) |n| {
                const d = config.find(s.app.cfg, n) orelse {
                    s.dest_list.clearRetainingCapacity();
                    var tmp: [128]u8 = undefined;
                    return s.statusError(std.fmt.bufPrint(&tmp, "unknown destination: {s}", .{n}) catch "unknown destination");
                };
                try s.dest_list.append(gpa, d);
            }
        }

        const names = try gpa.alloc([]const u8, s.dest_list.items.len);
        defer gpa.free(names);
        for (s.dest_list.items, names) |d, *n| n.* = d.name;
        s.fan = try fanout.Fanout.init(gpa, s.io(), names, 600, 32 * 1024 * 1024);
        s.fan.?.setMeta(.{
            .width = st.width,
            .height = st.height,
            .fps = st.fps,
            .video_kbps = st.video_kbps,
            .audio_kbps = st.audio_kbps,
            .sample_rate = st.sample_rate,
            .channels = st.channels,
        });
        s.started = true;

        // started status
        {
            var buf: [1024]u8 = undefined;
            var w: Io.Writer = .fixed(&buf);
            w.writeAll("{\"type\":\"started\",\"destinations\":[") catch {};
            for (s.dest_list.items, 0..) |d, i| {
                w.print("{s}{{\"name\":{f},\"state\":\"connecting\"}}", .{ if (i > 0) "," else "", std.json.fmt(d.name, .{}) }) catch {};
            }
            w.writeAll("]}") catch {};
            s.statusRaw(w.buffered());
        }

        const ctx: destination.Ctx = .{ .gpa = gpa, .io = s.io(), .fan = &s.fan.?, .tls = s.app.tls, .stopping = &s.stopping };
        for (s.dest_list.items, 0..) |d, i| {
            s.workers.concurrent(s.io(), destination.run, .{ ctx, &s.fan.?.sinks[i], d }) catch |e| {
                log.err("cannot start worker for {s}: {s}", .{ d.name, @errorName(e) });
            };
        }
        s.stats.concurrent(s.io(), statsLoop, .{s}) catch {};
    }

    fn statusRaw(s: *Session, json: []const u8) void {
        var buf: [2048]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        const h = framing.encodeHeader(.{ .kind = .status, .flags = 0, .dts_ms = 0, .cts_offset_ms = 0, .payload = &.{} });
        w.writeAll(&h) catch return;
        w.writeAll(json) catch return;
        s.sendFrameLocked(.binary, w.buffered()) catch {};
    }

    fn onClip(s: *Session, payload: []const u8) void {
        const gpa = s.app.gpa;
        var parsed = std.json.parseFromSlice(ClipRequest, gpa, payload, .{ .ignore_unknown_fields = true }) catch
            return s.statusError("bad clip payload");
        defer parsed.deinit();
        const req = parsed.value;

        var aw: Io.Writer.Allocating = .init(gpa);
        defer aw.deinit();
        const info = s.clipper.exportClip(&aw.writer, req.seconds_back) catch |e|
            return s.statusError(@errorName(e));

        var title: [48]u8 = undefined;
        var tl: usize = 0;
        for (req.title) |c| {
            if (tl == title.len) break;
            title[tl] = if (std.ascii.isAlphanumeric(c) or c == '-' or c == '_') c else '_';
            tl += 1;
        }
        const unix_s = @divTrunc(Io.Timestamp.now(s.io(), .real).nanoseconds, std.time.ns_per_s);
        var path_buf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}/clip-{d}{s}{s}.ts", .{
            s.app.cfg.clip_dir, unix_s, if (tl > 0) "-" else "", title[0..tl],
        }) catch return s.statusError("clip path too long");

        const cwd = Io.Dir.cwd();
        cwd.createDirPath(s.io(), s.app.cfg.clip_dir) catch |e| return s.statusError(@errorName(e));
        const file = cwd.createFile(s.io(), path, .{}) catch |e| return s.statusError(@errorName(e));
        defer file.close(s.io());
        var fbuf: [4096]u8 = undefined;
        var fw = file.writer(s.io(), &fbuf);
        fw.interface.writeAll(aw.written()) catch return s.statusError("write failed");
        fw.interface.flush() catch return s.statusError("write failed");

        s.status("{{\"type\":\"clip\",\"ok\":true,\"path\":{f},\"seconds\":{d},\"bytes\":{d}}}", .{
            std.json.fmt(path, .{}), (info.end_ms - info.start_ms) / 1000, info.bytes,
        });
    }

    fn statsLoop(s: *Session) Io.Cancelable!void {
        var last_bytes: u64 = 0;
        while (true) {
            try s.io().sleep(.fromSeconds(2), .awake);
            const fan = &(s.fan orelse return);
            const now = s.in_bytes.load(.monotonic);
            const kbps = (now - last_bytes) * 8 / 2 / 1000;
            last_bytes = now;
            const up_ms = @divTrunc(s.t0.durationTo(Io.Timestamp.now(s.io(), .awake)).nanoseconds, std.time.ns_per_ms);
            var buf: [1536]u8 = undefined;
            var w: Io.Writer = .fixed(&buf);
            w.print("{{\"type\":\"stats\",\"uptime_ms\":{d},\"in_kbps\":{d},\"dests\":{{", .{ up_ms, kbps }) catch continue;
            for (fan.sinks, 0..) |*sk, i| {
                w.print("{s}{f}:{{\"state\":\"{s}\",\"dropped\":{d}}}", .{
                    if (i > 0) "," else "", std.json.fmt(sk.name, .{}), @tagName(sk.getState()), fan.dropped(i),
                }) catch break;
            }
            w.writeAll("}}") catch continue;
            s.statusRaw(w.buffered());
        }
    }

    fn handleFrame(s: *Session, f: framing.Frame) !bool {
        switch (f.kind) {
            .start => try s.onStart(f.payload),
            .stop => return false,
            .clip => s.onClip(f.payload),
            .video_config => {
                s.clipper.setVideoConfig(f.payload) catch s.statusError("bad video_config");
                if (s.fan) |*fan| try fan.setVideoConfig(f.payload);
            },
            .audio_config => {
                s.clipper.setAudioConfig(f.payload) catch s.statusError("bad audio_config");
                if (s.fan) |*fan| try fan.setAudioConfig(f.payload);
            },
            .video_chunk => {
                if (!s.started) return s.protoError("video before start");
                s.clipper.pushVideo(f.dts_ms, f.cts_offset_ms, f.isKeyframe(), f.payload) catch {};
                s.fan.?.pushVideo(f.dts_ms, f.isKeyframe(), f.cts_offset_ms, f.payload);
            },
            .audio_chunk => {
                if (!s.started) return s.protoError("audio before start");
                s.clipper.pushAudio(f.dts_ms, f.payload) catch {};
                s.fan.?.pushAudio(f.dts_ms, f.payload);
            },
            else => return s.protoError("unexpected kind"),
        }
        return true;
    }

    fn protoError(s: *Session, msg: []const u8) bool {
        s.statusError(msg);
        return false;
    }

    fn closeWith(s: *Session, code: u16) void {
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, code, .big);
        s.sendFrameLocked(.close, &b) catch {};
    }

    fn shutdown(s: *Session) void {
        s.stopping.store(true, .release);
        if (s.fan) |*fan| {
            fan.closeAll();
            s.workers.await(s.io()) catch {};
        }
        s.stats.cancel(s.io());
        if (s.fan) |*fan| fan.deinit();
        s.dest_list.deinit(s.app.gpa);
        s.clipper.deinit();
    }
};

/// Handle one accepted TCP connection to completion. Never returns an error.
pub fn serve(app: *App, stream: net.Stream) void {
    const io = app.io;
    defer stream.close(io);
    var rbuf: [16 * 1024]u8 = undefined;
    var wbuf: [16 * 1024]u8 = undefined;
    var sr = stream.reader(io, &rbuf);
    var sw = stream.writer(io, &wbuf);

    if (app.busy.cmpxchgStrong(false, true, .acq_rel, .monotonic) != null) {
        ws.writeBusy(&sw.interface) catch {};
        return;
    }
    defer app.busy.store(false, .release);

    ws.serverHandshake(&sr.interface, &sw.interface, .{
        .path = "/ingest",
        .token = app.cfg.token,
        .allow_any_origin = app.cfg.allow_any_origin,
    }) catch |e| {
        log.info("handshake rejected: {s}", .{@errorName(e)});
        return;
    };

    var s: Session = .{
        .app = app,
        .w = &sw.interface,
        .clipper = ts.Clipper.init(app.gpa, .{ .max_ms = app.cfg.clip_seconds * 1000 }),
        .t0 = Io.Timestamp.now(io, .awake),
    };
    defer s.shutdown();
    s.status("{{\"type\":\"ready\",\"version\":{d}}}", .{protocol_version});
    log.info("ingest connected", .{});

    var conn = ws.Conn.init(app.gpa, &sr.interface, max_ws_message);
    defer conn.deinit();
    while (true) {
        const m = conn.next() catch |e| {
            log.info("ingest closed: {s}", .{@errorName(e)});
            if (e == error.ProtocolError or e == error.MessageTooLarge) s.closeWith(1002);
            return;
        };
        switch (m.op) {
            .binary => {
                _ = s.in_bytes.fetchAdd(m.payload.len, .monotonic);
                const f = framing.parse(m.payload) catch |e| {
                    var tmp: [64]u8 = undefined;
                    s.statusError(std.fmt.bufPrint(&tmp, "protocol: {s}", .{@errorName(e)}) catch "protocol");
                    s.closeWith(1002);
                    return;
                };
                const keep = s.handleFrame(f) catch |e| {
                    s.statusError(@errorName(e));
                    return;
                };
                if (!keep) {
                    s.closeWith(1000);
                    return;
                }
            },
            .ping => s.sendFrameLocked(.pong, m.payload) catch return,
            .pong => {},
            .close => {
                s.closeWith(1000);
                return;
            },
            else => {
                s.closeWith(1003);
                return;
            },
        }
    }
}
