//! Minimal loopback-only HTTP/1.1 static file server (GET/HEAD, Connection: close).
//! DNS-rebinding defence: the Host header must be a loopback name with the server's port.

const std = @import("std");
const Io = std.Io;
const net = Io.net;
const site_mod = @import("site.zig");

const log = std.log.scoped(.httpd);

/// Result of the codec probe page (see site.probe_html), filled in by `GET /__probe/result/...`.
pub const Probe = struct {
    done: std.atomic.Value(bool) = .init(false),
    h264: std.atomic.Value(bool) = .init(false),
    aac: std.atomic.Value(bool) = .init(false),
};

pub const ProbeResult = struct { h264: bool, aac: bool };

/// Parse `/__probe/result/h264-1/aac-0`.
pub fn parseProbeResult(path: []const u8) ?ProbeResult {
    const prefix = "/__probe/result/h264-";
    if (!std.mem.startsWith(u8, path, prefix)) return null;
    const rest = path[prefix.len..];
    if (rest.len != "1/aac-1".len) return null;
    if ((rest[0] != '0' and rest[0] != '1') or rest[1] != '/' or !std.mem.eql(u8, rest[2..6], "aac-")) return null;
    if (rest[6] != '0' and rest[6] != '1') return null;
    return .{ .h264 = rest[0] == '1', .aac = rest[6] == '1' };
}

pub const Server = struct {
    io: Io,
    site: site_mod.Site,
    port: u16,
    probe: ?*Probe = null,
};

pub const Request = struct {
    is_head: bool,
    path: []const u8,
    host: []const u8,
};

pub const ParseError = error{ BadRequest, MethodNotAllowed, HeaderTooLong } || Io.Reader.Error;

/// Read and parse the request head. Slices point into the reader buffer / `scratch`.
pub fn readRequest(r: *Io.Reader, scratch: []u8) ParseError!Request {
    var req: Request = .{ .is_head = false, .path = "", .host = "" };
    var used: usize = 0;
    var first = true;
    var count: usize = 0;
    while (true) {
        const line_raw = r.takeDelimiterInclusive('\n') catch |e| switch (e) {
            error.StreamTooLong => return error.HeaderTooLong,
            else => |x| return x,
        };
        const line = std.mem.trim(u8, line_raw, "\r\n");
        if (first) {
            first = false;
            var parts = std.mem.tokenizeScalar(u8, line, ' ');
            const method = parts.next() orelse return error.BadRequest;
            const target = parts.next() orelse return error.BadRequest;
            if (std.mem.eql(u8, method, "HEAD")) {
                req.is_head = true;
            } else if (!std.mem.eql(u8, method, "GET")) return error.MethodNotAllowed;
            const q = std.mem.indexOfScalar(u8, target, '?') orelse target.len;
            const p = target[0..q];
            if (p.len == 0 or p[0] != '/' or p.len > scratch.len) return error.BadRequest;
            @memcpy(scratch[0..p.len], p);
            req.path = scratch[0..p.len];
            used = p.len;
            continue;
        }
        if (line.len == 0) break;
        count += 1;
        if (count > 64) return error.HeaderTooLong;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        if (std.ascii.eqlIgnoreCase(line[0..colon], "host")) {
            const v = std.mem.trim(u8, line[colon + 1 ..], " \t");
            if (used + v.len > scratch.len) return error.HeaderTooLong;
            @memcpy(scratch[used..][0..v.len], v);
            req.host = scratch[used..][0..v.len];
            used += v.len;
        }
    }
    if (first) return error.BadRequest;
    return req;
}

pub fn hostAllowed(host: []const u8, port: u16) bool {
    var buf: [64]u8 = undefined;
    const names = [_][]const u8{ "127.0.0.1", "localhost", "[::1]" };
    for (names) |n| {
        const want = std.fmt.bufPrint(&buf, "{s}:{d}", .{ n, port }) catch continue;
        if (std.ascii.eqlIgnoreCase(host, want)) return true;
    }
    return false;
}

/// True when the path contains traversal tricks. Lookups are exact-match against the table, so this
/// is defence in depth.
pub fn pathSuspicious(p: []const u8) bool {
    return std.mem.indexOf(u8, p, "..") != null or std.mem.indexOfScalar(u8, p, '\\') != null or std.mem.indexOfScalar(u8, p, 0) != null;
}

fn writeSimple(w: *Io.Writer, code: u16, reason: []const u8, body: []const u8) !void {
    try w.print("HTTP/1.1 {d} {s}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {d}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n{s}", .{ code, reason, body.len, body });
    try w.flush();
}

pub fn serve(srv: *const Server, stream: net.Stream) void {
    const io = srv.io;
    defer stream.close(io);
    var rbuf: [8 * 1024]u8 = undefined;
    var wbuf: [16 * 1024]u8 = undefined;
    var sr = stream.reader(io, &rbuf);
    var sw = stream.writer(io, &wbuf);
    const w = &sw.interface;

    var scratch: [2048]u8 = undefined;
    const req = readRequest(&sr.interface, &scratch) catch |e| {
        switch (e) {
            error.MethodNotAllowed => writeSimple(w, 405, "Method Not Allowed", "method not allowed\n") catch {},
            error.BadRequest, error.HeaderTooLong => writeSimple(w, 400, "Bad Request", "bad request\n") catch {},
            else => {},
        }
        return;
    };
    if (!hostAllowed(req.host, srv.port)) {
        writeSimple(w, 403, "Forbidden", "forbidden host\n") catch {};
        return;
    }
    if (pathSuspicious(req.path)) {
        writeSimple(w, 400, "Bad Request", "bad path\n") catch {};
        return;
    }
    if (parseProbeResult(req.path)) |res| {
        if (srv.probe) |pr| {
            pr.h264.store(res.h264, .release);
            pr.aac.store(res.aac, .release);
            pr.done.store(true, .release);
        }
        writeSimple(w, 200, "OK", "ok\n") catch {};
        return;
    }
    const entry = srv.site.find(req.path) orelse {
        writeSimple(w, 404, "Not Found", "not found\n") catch {};
        return;
    };
    w.print("HTTP/1.1 200 OK\r\nContent-Type: {s}\r\nContent-Length: {d}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\n\r\n", .{ entry.mime, entry.data.len }) catch return;
    if (!req.is_head) w.writeAll(entry.data) catch return;
    w.flush() catch {};
}

/// Accept loop; returns when cancelled.
pub fn run(srv: *const Server, server: *net.Server) void {
    const io = srv.io;
    var conns: Io.Group = .init;
    defer conns.cancel(io);
    while (true) {
        const stream = server.accept(io) catch |e| switch (e) {
            error.Canceled => return,
            else => {
                log.err("accept failed: {s}", .{@errorName(e)});
                continue;
            },
        };
        conns.concurrent(io, serve, .{ srv, stream }) catch {
            stream.close(io);
        };
    }
}

test "parse GET request, strip query, capture host" {
    var scratch: [256]u8 = undefined;
    var r: Io.Reader = .fixed("GET /assets/a.js?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nAccept: */*\r\n\r\n");
    const q = try readRequest(&r, &scratch);
    try std.testing.expectEqualStrings("/assets/a.js", q.path);
    try std.testing.expectEqualStrings("127.0.0.1:5000", q.host);
    try std.testing.expect(!q.is_head);
}

test "POST is rejected" {
    var scratch: [256]u8 = undefined;
    var r: Io.Reader = .fixed("POST / HTTP/1.1\r\nHost: x\r\n\r\n");
    try std.testing.expectError(error.MethodNotAllowed, readRequest(&r, &scratch));
}

test "host allow-list" {
    try std.testing.expect(hostAllowed("127.0.0.1:5000", 5000));
    try std.testing.expect(hostAllowed("localhost:5000", 5000));
    try std.testing.expect(!hostAllowed("evil.example:5000", 5000));
    try std.testing.expect(!hostAllowed("127.0.0.1:5001", 5000));
    try std.testing.expect(!hostAllowed("", 5000));
}

test "path guard" {
    try std.testing.expect(pathSuspicious("/../etc/passwd"));
    try std.testing.expect(!pathSuspicious("/assets/a.js"));
}

test "probe result parsing" {
    const r = parseProbeResult("/__probe/result/h264-1/aac-0").?;
    try std.testing.expect(r.h264 and !r.aac);
    try std.testing.expect(parseProbeResult("/__probe/result/h264-2/aac-0") == null);
    try std.testing.expect(parseProbeResult("/__probe/result/h264-1/aac-01") == null);
    try std.testing.expect(parseProbeResult("/index.html") == null);
}
