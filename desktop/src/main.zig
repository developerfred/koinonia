//! koinonia - desktop launcher.
//!
//! One process: embedded ingest daemon (daemon/src modules) + loopback static server for the
//! studio + a Chromium-family browser in --app mode with a dedicated profile. When the browser
//! window closes, everything shuts down; Ctrl-C / SIGTERM closes the browser first.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const net = Io.net;
const koinonia = @import("koinonia");
const assets = @import("assets");
const browser = @import("browser.zig");
const site_mod = @import("site.zig");
const httpd = @import("httpd.zig");

const config = koinonia.config;
const session = koinonia.session;
const destination = koinonia.destination;

const log = std.log.scoped(.desktop);

pub const version = "0.1.0";

const usage =
    \\koinonia - desktop studio (embedded daemon + studio + browser app window)
    \\
    \\usage: koinonia [options]
    \\
    \\  --browser PATH      use this Chromium-family browser (or set KOINONIA_BROWSER)
    \\  --no-browser        only serve; print the URL to open yourself
    \\  --studio-dir DIR    serve the studio from DIR instead of the embedded copy
    \\  --profile-dir DIR   browser profile directory (default: per-user Koinonia dir)
    \\  --port N            HTTP port for the studio (default: a free port)
    \\  --config FILE       daemon JSON config (destinations, clip dir), see daemon/PROTOCOL.md
    \\  --list-browsers     show the browsers that were found, then exit
    \\  --check-config      validate the daemon configuration, then exit
    \\  --version, --help
    \\
    \\Destinations (Twitch/YouTube keys) come from the same environment variables and config
    \\file as koinonia-d (see daemon/PROTOCOL.md). Stream keys are never printed.
    \\
;

// ---- shutdown plumbing ---------------------------------------------------------------------
// The signal/console handler terminates the browser; the main thread is blocked in Child.wait
// and then unwinds normally (cancels servers).
var g_child: std.atomic.Value(usize) = .init(0);

const win = struct {
    extern "kernel32" fn SetConsoleCtrlHandler(handler: ?*const fn (u32) callconv(.winapi) i32, add: i32) callconv(.winapi) i32;
    extern "kernel32" fn TerminateProcess(h: ?*anyopaque, code: u32) callconv(.winapi) i32;
};

fn winCtrl(_: u32) callconv(.winapi) i32 {
    const h = g_child.load(.acquire);
    if (h != 0) _ = win.TerminateProcess(@ptrFromInt(h), 0);
    return 1;
}

fn posixSignal(_: std.posix.SIG) callconv(.c) void {
    const pid = g_child.load(.acquire);
    if (pid != 0) std.posix.kill(@intCast(pid), .TERM) catch {};
}

fn installShutdownHandlers(child_id: std.process.Child.Id) void {
    if (builtin.os.tag == .windows) {
        g_child.store(@intFromPtr(child_id), .release);
        _ = win.SetConsoleCtrlHandler(winCtrl, 1);
    } else if (builtin.os.tag != .wasi) {
        g_child.store(@intCast(child_id), .release);
        const act: std.posix.Sigaction = .{
            .handler = .{ .handler = posixSignal },
            .mask = std.posix.sigemptyset(),
            .flags = 0,
        };
        std.posix.sigaction(.INT, &act, null);
        std.posix.sigaction(.TERM, &act, null);
        std.posix.sigaction(.HUP, &act, null);
    }
}

// ---- helpers ------------------------------------------------------------------------------------

fn out(io: Io, comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    var w = Io.File.stdout().writerStreaming(io, &buf);
    w.interface.print(fmt, args) catch {};
    w.interface.flush() catch {};
}

fn err(io: Io, comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    var w = Io.File.stderr().writerStreaming(io, &buf);
    w.interface.print(fmt, args) catch {};
    w.interface.flush() catch {};
}

/// Listen on 127.0.0.1 on `fixed` or on a random port from the IANA dynamic range.
fn listenFree(io: Io, fixed: ?u16) !struct { server: net.Server, port: u16 } {
    if (fixed) |p| {
        const addr: net.IpAddress = .{ .ip4 = .loopback(p) };
        return .{ .server = try addr.listen(io, .{ .reuse_address = false }), .port = p };
    }
    var tries: usize = 0;
    while (tries < 64) : (tries += 1) {
        var rnd: [2]u8 = undefined;
        io.random(&rnd);
        const span: u32 = 65535 - 49152;
        const p: u16 = @intCast(49152 + (@as(u32, std.mem.readInt(u16, &rnd, .little)) % span));
        const addr: net.IpAddress = .{ .ip4 = .loopback(p) };
        if (addr.listen(io, .{ .reuse_address = false })) |s| {
            return .{ .server = s, .port = p };
        } else |_| continue;
    }
    return error.NoFreePort;
}

fn ingestLoop(app: *session.App, server: *net.Server) void {
    const io = app.io;
    var conns: Io.Group = .init;
    defer conns.cancel(io);
    while (true) {
        const stream = server.accept(io) catch |e| switch (e) {
            error.Canceled => return,
            else => {
                log.err("ingest accept failed: {s}", .{@errorName(e)});
                continue;
            },
        };
        conns.concurrent(io, session.serve, .{ app, stream }) catch {
            stream.close(io);
        };
    }
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();
    const env = init.environ_map;

    var browser_override: ?[]const u8 = env.get("KOINONIA_BROWSER");
    var no_browser = false;
    var studio_dir: ?[]const u8 = null;
    var profile_dir: ?[]const u8 = null;
    var http_port: ?u16 = null;
    var config_path: ?[]const u8 = env.get("KOINONIA_CONFIG");
    var check_only = false;
    var list_only = false;

    var args = try init.minimal.args.iterateAllocator(arena);
    _ = args.next();
    while (args.next()) |a| {
        if (std.mem.eql(u8, a, "--help") or std.mem.eql(u8, a, "-h")) {
            out(io, "{s}", .{usage});
            return;
        } else if (std.mem.eql(u8, a, "--version")) {
            out(io, "koinonia {s}\n", .{version});
            return;
        } else if (std.mem.eql(u8, a, "--no-browser")) {
            no_browser = true;
        } else if (std.mem.eql(u8, a, "--check-config")) {
            check_only = true;
        } else if (std.mem.eql(u8, a, "--list-browsers")) {
            list_only = true;
        } else if (std.mem.eql(u8, a, "--browser")) {
            browser_override = args.next() orelse return usageError(io, "--browser needs a path");
        } else if (std.mem.eql(u8, a, "--studio-dir")) {
            studio_dir = args.next() orelse return usageError(io, "--studio-dir needs a path");
        } else if (std.mem.eql(u8, a, "--profile-dir")) {
            profile_dir = args.next() orelse return usageError(io, "--profile-dir needs a path");
        } else if (std.mem.eql(u8, a, "--config")) {
            config_path = args.next() orelse return usageError(io, "--config needs a path");
        } else if (std.mem.eql(u8, a, "--port")) {
            const v = args.next() orelse return usageError(io, "--port needs a number");
            http_port = std.fmt.parseInt(u16, v, 10) catch return usageError(io, "--port: not a valid port");
        } else {
            return usageError(io, "unknown option");
        }
    }

    if (list_only) {
        const all = browser.findAll(arena, io, env);
        if (all.len == 0) out(io, "{s}", .{browser.install_help});
        for (all) |f| out(io, "{s}: {s}\n", .{ browser.kindName(f.kind), f.path });
        return;
    }

    // ---- daemon configuration ----
    const file_text: ?[]const u8 = if (config_path) |p|
        Io.Dir.cwd().readFileAlloc(io, p, arena, .limited(1 << 20)) catch |e| {
            err(io, "cannot read config file {s}: {s}\n", .{ p, @errorName(e) });
            std.process.exit(1);
        }
    else
        null;
    var cfg = config.load(arena, env, file_text) catch |e| {
        err(io, "invalid configuration: {s}\n", .{@errorName(e)});
        std.process.exit(1);
    };
    if (check_only) {
        out(io, "configuration ok: {d} destination(s)\n", .{cfg.destinations.len});
        return;
    }

    // ---- browser (resolve early so a missing browser fails before binding anything) ----
    var chosen: ?browser.Found = null;
    if (!no_browser) {
        if (browser_override) |p| {
            Io.Dir.accessAbsolute(io, p, .{ .execute = true }) catch {
                err(io, "the browser given by --browser/KOINONIA_BROWSER is not an executable file: {s}\n", .{p});
                std.process.exit(1);
            };
            chosen = .{ .kind = .chromium, .path = p };
        } else {
            chosen = browser.find(arena, io, env);
        }
        if (chosen == null) {
            err(io, "{s}", .{browser.install_help});
            std.process.exit(3);
        }
    }

    // ---- listeners ----
    var ingest_l = listenFree(io, null) catch |e| {
        err(io, "cannot open an ingest port on 127.0.0.1: {s}\n", .{@errorName(e)});
        std.process.exit(1);
    };
    defer ingest_l.server.deinit(io);
    var http_l = listenFree(io, http_port) catch |e| {
        err(io, "cannot open the studio port on 127.0.0.1: {s}\n", .{@errorName(e)});
        std.process.exit(1);
    };
    defer http_l.server.deinit(io);

    // Random per-run token: only a page that was served by us knows it.
    var tok_raw: [16]u8 = undefined;
    io.random(&tok_raw);
    const token = try std.fmt.allocPrint(arena, "{x}", .{&tok_raw});
    cfg.port = ingest_l.port;
    cfg.token = token;

    const ws_url = try std.fmt.allocPrint(arena, "ws://127.0.0.1:{d}/ingest?token={s}", .{ ingest_l.port, token });
    const origin = try std.fmt.allocPrint(arena, "http://127.0.0.1:{d}", .{http_l.port});
    // The studio reads ?daemon=&token= from its own URL (studio/src/main.ts).
    const app_url = try std.fmt.allocPrint(arena, "{s}/{s}", .{ origin, try site_mod.appQuery(arena, ingest_l.port, token) });

    // ---- studio files ----
    var raw: std.ArrayList(site_mod.Entry) = .empty;
    if (studio_dir) |d| {
        raw = site_mod.loadDir(arena, io, d) catch |e| {
            err(io, "cannot read --studio-dir {s}: {s}\n", .{ d, @errorName(e) });
            std.process.exit(1);
        };
    } else {
        for (assets.files) |f| try raw.append(arena, .{ .path = f.path, .mime = f.mime, .data = f.data });
    }
    if (raw.items.len == 0) try raw.append(arena, .{ .path = "/index.html", .mime = "text/html; charset=utf-8", .data = site_mod.placeholder_html });
    const site: site_mod.Site = .{ .entries = try site_mod.prepare(arena, raw.items, ws_url, origin) };

    // ---- daemon state ----
    var tls_ctx: destination.TlsCtx = .{};
    defer tls_ctx.deinit(gpa);
    for (cfg.destinations) |d| {
        if (std.mem.startsWith(u8, d.url, "rtmps://")) {
            tls_ctx.load(gpa, io) catch |e| log.warn("could not load CA certificates: {s}", .{@errorName(e)});
            break;
        }
    }
    var app: session.App = .{ .gpa = gpa, .io = io, .cfg = cfg, .tls = &tls_ctx };
    const http_srv: httpd.Server = .{ .io = io, .site = site, .port = http_l.port };

    var group: Io.Group = .init;
    defer group.cancel(io);
    try group.concurrent(io, ingestLoop, .{ &app, &ingest_l.server });
    try group.concurrent(io, httpd.run, .{ &http_srv, &http_l.server });

    out(io, "koinonia {s}\n  studio:  {s}/\n  ingest:  ws://127.0.0.1:{d}/ingest (token hidden)\n  clips:   {s}/ ({d}s buffer)\n", .{ version, origin, ingest_l.port, cfg.clip_dir, cfg.clip_seconds });
    if (cfg.destinations.len == 0) out(io, "  no destinations configured (clipper only); see daemon/PROTOCOL.md\n", .{});
    for (cfg.destinations) |d| {
        var buf: [512]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        d.describe(&w) catch {};
        out(io, "  destination: {s}\n", .{w.buffered()});
    }

    if (no_browser) {
        out(io, "serving without a browser. Open this in a Chromium-based browser (it contains this run's ingest token):\n  {s}\nCtrl-C to quit.\n", .{app_url});
        group.await(io) catch {};
        return;
    }

    // ---- launch the browser ----
    const found = chosen.?;
    const prof = profile_dir orelse browser.defaultProfileDir(arena, builtin.os.tag, env) orelse {
        err(io, "cannot determine a profile directory (HOME / LOCALAPPDATA unset); pass --profile-dir\n", .{});
        std.process.exit(1);
    };
    Io.Dir.cwd().createDirPath(io, prof) catch |e| {
        err(io, "cannot create browser profile directory {s}: {s}\n", .{ prof, @errorName(e) });
        std.process.exit(1);
    };
    const argv = try browser.buildArgv(arena, found.path, app_url, prof, &.{});
    out(io, "  browser: {s} ({s})\n  profile: {s}\n", .{ browser.kindName(found.kind), found.path, prof });

    var child = std.process.spawn(io, .{
        .argv = argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch |e| {
        err(io, "failed to start {s}: {s}\n", .{ found.path, @errorName(e) });
        std.process.exit(1);
    };
    installShutdownHandlers(child.id.?);
    const t0 = Io.Timestamp.now(io, .awake);
    const term = child.wait(io) catch |e| blk: {
        log.warn("waiting for the browser failed: {s}", .{@errorName(e)});
        break :blk std.process.Child.Term{ .unknown = 0 };
    };
    g_child.store(0, .release);
    const secs = @divTrunc(Io.Timestamp.now(io, .awake).nanoseconds - t0.nanoseconds, std.time.ns_per_s);
    if (secs < 3) {
        err(io, "the browser exited after {d}s ({f}). If it handed the window to an already running instance, close all of its windows and retry; try --browser to pick another one.\n", .{ secs, term });
        std.process.exit(4);
    }
    out(io, "browser closed, shutting down\n", .{});
    // `defer group.cancel(io)` stops both servers; in-flight ingest sessions are torn down by
    // their own task cancellation (RTMP connections are closed by the session shutdown path).
}

fn usageError(io: Io, msg: []const u8) noreturn {
    err(io, "{s}\n\n{s}", .{ msg, usage });
    std.process.exit(2);
}

test {
    _ = browser;
    _ = site_mod;
    _ = httpd;
}
