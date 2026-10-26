//! The studio file set served over HTTP: embedded at build time or read from a directory,
//! with the daemon's ingest URL wired in.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;

pub const Entry = struct {
    path: []const u8, // URL path, leading '/'
    mime: []const u8,
    data: []const u8,
};

/// Default ingest URLs that older studio builds hardcode (studio/src/transport.ts). Current
/// builds read `?daemon=&token=` from the page URL, which is the primary mechanism (see
/// `appQuery`); rewriting these literals in served JS is a fallback for older `dist` folders.
pub const studio_default_ws = [_][]const u8{ "ws://127.0.0.1:7777/ingest", "ws://127.0.0.1:7878/ingest" };

/// Query string that points the studio at the daemon: `?daemon=<ws url>&token=<token>`.
pub fn appQuery(arena: Allocator, ingest_port: u16, token: []const u8) Allocator.Error![]u8 {
    return std.fmt.allocPrint(arena, "?daemon=ws://127.0.0.1:{d}/ingest&token={s}", .{ ingest_port, token });
}

pub const Site = struct {
    entries: []Entry,

    pub fn find(s: Site, url_path: []const u8) ?*const Entry {
        const p = if (std.mem.eql(u8, url_path, "/")) "/index.html" else url_path;
        for (s.entries) |*e| if (std.mem.eql(u8, e.path, p)) return e;
        return null;
    }
};

pub const placeholder_html =
    \\<!doctype html><meta charset="utf-8"><title>Koinonia</title>
    \\<body style="font:16px system-ui;max-width:40em;margin:3em auto;padding:0 1em">
    \\<h1>Koinonia</h1><p>The studio assets were not embedded in this build.</p>
    \\<p>Build them (<code>cd studio &amp;&amp; npm run build</code>) and rebuild the desktop app,
    \\or run <code>koinonia --studio-dir path/to/studio/dist</code>.</p>
;

pub fn mimeFor(path: []const u8) []const u8 {
    const ext = std.fs.path.extension(path);
    const table = [_][2][]const u8{
        .{ ".html", "text/html; charset=utf-8" },
        .{ ".js", "text/javascript; charset=utf-8" },
        .{ ".mjs", "text/javascript; charset=utf-8" },
        .{ ".css", "text/css; charset=utf-8" },
        .{ ".json", "application/json" },
        .{ ".map", "application/json" },
        .{ ".svg", "image/svg+xml" },
        .{ ".png", "image/png" },
        .{ ".jpg", "image/jpeg" },
        .{ ".ico", "image/x-icon" },
        .{ ".webp", "image/webp" },
        .{ ".woff2", "font/woff2" },
        .{ ".woff", "font/woff" },
        .{ ".wasm", "application/wasm" },
        .{ ".txt", "text/plain; charset=utf-8" },
    };
    for (table) |e| if (std.ascii.eqlIgnoreCase(ext, e[0])) return e[1];
    return "application/octet-stream";
}

/// Bootstrap script inserted into index.html. `ws_url` must contain only URL-safe characters.
pub fn bootstrapScript(arena: Allocator, ws_url: []const u8, http_origin: []const u8) Allocator.Error![]u8 {
    return std.fmt.allocPrint(
        arena,
        "<script>window.__KOINONIA__={{\"desktop\":true,\"ws\":\"{s}\",\"origin\":\"{s}\"}};</script>",
        .{ ws_url, http_origin },
    );
}

/// Insert `snippet` right after the first `<head>` (or at the start when there is none).
pub fn injectIntoHtml(arena: Allocator, html: []const u8, snippet: []const u8) Allocator.Error![]u8 {
    const at: usize = if (std.mem.indexOf(u8, html, "<head>")) |i| i + "<head>".len else 0;
    return std.mem.concat(arena, u8, &.{ html[0..at], snippet, html[at..] });
}

/// Prepare entries: inject the bootstrap into index.html, rewrite the studio's default ingest URL
/// in JavaScript files. Everything is allocated in `arena`.
pub fn prepare(arena: Allocator, raw: []const Entry, ws_url: []const u8, http_origin: []const u8) Allocator.Error![]Entry {
    const out = try arena.alloc(Entry, raw.len);
    const boot = try bootstrapScript(arena, ws_url, http_origin);
    for (raw, out) |e, *o| {
        o.* = e;
        if (std.mem.eql(u8, e.path, "/index.html")) {
            o.data = try injectIntoHtml(arena, e.data, boot);
        } else if (std.mem.endsWith(u8, e.path, ".js") or std.mem.endsWith(u8, e.path, ".mjs")) {
            for (studio_default_ws) |needle| {
                if (std.mem.indexOf(u8, o.data, needle) == null) continue;
                const n = std.mem.replacementSize(u8, o.data, needle, ws_url);
                const buf = try arena.alloc(u8, n);
                _ = std.mem.replace(u8, o.data, needle, ws_url, buf);
                o.data = buf;
            }
        }
    }
    return out;
}

/// Read every file under `dir_path` (for --studio-dir).
pub fn loadDir(arena: Allocator, io: Io, dir_path: []const u8) !std.ArrayList(Entry) {
    var list: std.ArrayList(Entry) = .empty;
    var dir = try Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(arena);
    defer walker.deinit();
    while (try walker.next(io)) |entry| {
        if (entry.kind != .file) continue;
        const url_path = try std.fmt.allocPrint(arena, "/{s}", .{entry.path});
        for (url_path) |*c| if (c.* == '\\') {
            c.* = '/';
        };
        const data = try entry.dir.readFileAlloc(io, entry.basename, arena, .limited(64 << 20));
        try list.append(arena, .{ .path = url_path, .mime = mimeFor(url_path), .data = data });
    }
    return list;
}

test "inject goes right after <head>" {
    var a = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer a.deinit();
    const out = try injectIntoHtml(a.allocator(), "<html><head><title>x</title></head>", "<script>1</script>");
    try std.testing.expectEqualStrings("<html><head><script>1</script><title>x</title></head>", out);
}

test "prepare rewrites default ingest url and injects bootstrap" {
    var a = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer a.deinit();
    const raw = [_]Entry{
        .{ .path = "/index.html", .mime = "text/html", .data = "<head></head>" },
        .{ .path = "/assets/a.js", .mime = "text/javascript", .data = "new T(\"ws://127.0.0.1:7878/ingest\")" },
        .{ .path = "/assets/b.css", .mime = "text/css", .data = "ws://127.0.0.1:7777/ingest" },
    };
    const out = try prepare(a.allocator(), &raw, "ws://127.0.0.1:50000/ingest?token=ab", "http://127.0.0.1:50001");
    try std.testing.expect(std.mem.indexOf(u8, out[0].data, "__KOINONIA__") != null);
    try std.testing.expectEqualStrings("new T(\"ws://127.0.0.1:50000/ingest?token=ab\")", out[1].data);
    try std.testing.expectEqualStrings("ws://127.0.0.1:7777/ingest", out[2].data); // css untouched
    try std.testing.expect(out[0].data.len > raw[0].data.len);
}

test "appQuery" {
    var a = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer a.deinit();
    try std.testing.expectEqualStrings("?daemon=ws://127.0.0.1:5000/ingest&token=ab", try appQuery(a.allocator(), 5000, "ab"));
}

test "find maps / to index.html" {
    var es = [_]Entry{.{ .path = "/index.html", .mime = "text/html", .data = "x" }};
    const s: Site = .{ .entries = &es };
    try std.testing.expect(s.find("/") != null);
    try std.testing.expect(s.find("/nope") == null);
}
