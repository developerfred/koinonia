//! Build-time helper: gen_assets <input-dir> <output-dir>
//! Copies every file of <input-dir> to <output-dir>/files/N and writes <output-dir>/assets.zig with
//! one @embedFile per file. Running it as a build step makes the embedded studio track the content
//! of the directory (a configure-time directory walk would be cached stale).

const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena = init.arena.allocator();
    var args = try init.minimal.args.iterateAllocator(arena);
    _ = args.next();
    const in_path = args.next() orelse return error.MissingInputDir;
    const out_path = args.next() orelse return error.MissingOutputDir;

    var out_dir = try Io.Dir.cwd().openDir(io, out_path, .{});
    defer out_dir.close(io);
    try out_dir.createDirPath(io, "files");

    var src: std.ArrayList(u8) = .empty;
    try src.appendSlice(arena, "pub const File = struct { path: []const u8, mime: []const u8, data: []const u8 };\npub const files = [_]File{\n");

    var count: usize = 0;
    var dir = try Io.Dir.cwd().openDir(io, in_path, .{ .iterate = true });
    defer dir.close(io);
    var walker = try dir.walk(arena);
    defer walker.deinit();
    while (try walker.next(io)) |entry| {
        if (entry.kind != .file) continue;
        const url_path = try arena.dupe(u8, entry.path);
        for (url_path) |*c| if (c.* == '\\') {
            c.* = '/';
        };
        const data = try entry.dir.readFileAlloc(io, entry.basename, arena, .limited(64 << 20));
        const name = try std.fmt.allocPrint(arena, "files/{d}", .{count});
        try out_dir.writeFile(io, .{ .sub_path = name, .data = data });
        const line = try std.fmt.allocPrint(arena, "    .{{ .path = \"/{s}\", .mime = \"{s}\", .data = @embedFile(\"{s}\") }},\n", .{ url_path, mimeFor(url_path), name });
        try src.appendSlice(arena, line);
        count += 1;
    }
    try src.appendSlice(arena, "};\n");
    try out_dir.writeFile(io, .{ .sub_path = "assets.zig", .data = src.items });
}

fn mimeFor(path: []const u8) []const u8 {
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
