const std = @import("std");
const Io = std.Io;
const net = Io.net;
const koinonia = @import("koinonia");
const config = koinonia.config;
const session = koinonia.session;
const destination = koinonia.destination;

const log = std.log.scoped(.main);

const usage =
    \\koinonia-d - WebSocket ingest -> RTMP(S) fan-out daemon
    \\
    \\usage: koinonia-d [--config FILE] [--check-config] [--help]
    \\
    \\Configuration is read from the environment (see PROTOCOL.md) and an optional JSON
    \\file (--config FILE or KOINONIA_CONFIG). Environment values override file values.
    \\
;

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    var config_path: ?[]const u8 = null;
    var check_only = false;
    var args = try init.minimal.args.iterateAllocator(init.arena.allocator());
    _ = args.next();
    while (args.next()) |a| {
        if (std.mem.eql(u8, a, "--help") or std.mem.eql(u8, a, "-h")) {
            try Io.File.stdout().writeStreamingAll(io, usage);
            return;
        } else if (std.mem.eql(u8, a, "--check-config")) {
            check_only = true;
        } else if (std.mem.eql(u8, a, "--config")) {
            config_path = args.next() orelse {
                try Io.File.stderr().writeStreamingAll(io, "--config needs a path\n");
                std.process.exit(2);
            };
        } else {
            try Io.File.stderr().writeStreamingAll(io, usage);
            std.process.exit(2);
        }
    }
    if (config_path == null) config_path = init.environ_map.get("KOINONIA_CONFIG");

    const arena = init.arena.allocator();
    const file_text: ?[]const u8 = if (config_path) |p|
        Io.Dir.cwd().readFileAlloc(io, p, arena, .limited(1 << 20)) catch |e| {
            log.err("cannot read config file: {s}", .{@errorName(e)});
            std.process.exit(1);
        }
    else
        null;

    const cfg = config.load(arena, init.environ_map, file_text) catch |e| {
        log.err("invalid configuration: {s}", .{@errorName(e)});
        std.process.exit(1);
    };

    // Describe configuration (keys are always redacted).
    var out_buf: [2048]u8 = undefined;
    var out = Io.File.stdout().writer(io, &out_buf);
    const w = &out.interface;
    try w.print("koinonia-d: ws://127.0.0.1:{d}/ingest  clip buffer {d}s -> {s}/\n", .{ cfg.port, cfg.clip_seconds, cfg.clip_dir });
    if (cfg.destinations.len == 0) try w.writeAll("  no destinations configured (clipper only)\n");
    for (cfg.destinations) |d| {
        try w.writeAll("  destination: ");
        try d.describe(w);
        try w.writeByte('\n');
    }
    try w.flush();
    if (check_only) return;

    var tls_ctx: destination.TlsCtx = .{};
    defer tls_ctx.deinit(gpa);
    var need_tls = false;
    for (cfg.destinations) |d| {
        if (std.mem.startsWith(u8, d.url, "rtmps://")) need_tls = true;
    }
    if (need_tls) tls_ctx.load(gpa, io) catch |e| log.warn("could not load CA certificates: {s}", .{@errorName(e)});

    var app: session.App = .{ .gpa = gpa, .io = io, .cfg = cfg, .tls = &tls_ctx };

    const addr: net.IpAddress = .{ .ip4 = .loopback(cfg.port) };
    var server = addr.listen(io, .{ .reuse_address = true }) catch |e| {
        log.err("cannot listen on 127.0.0.1:{d}: {s}", .{ cfg.port, @errorName(e) });
        std.process.exit(1);
    };
    defer server.deinit(io);

    var group: Io.Group = .init;
    defer group.cancel(io);
    while (true) {
        const stream = server.accept(io) catch |e| {
            log.err("accept failed: {s}", .{@errorName(e)});
            continue;
        };
        group.concurrent(io, session.serve, .{ &app, stream }) catch {
            stream.close(io);
            log.err("cannot start connection task", .{});
        };
    }
}
