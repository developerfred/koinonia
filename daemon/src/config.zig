//! Daemon configuration from environment variables and an optional JSON file.
//! Stream keys are wrapped in `Secret`, which always formats as `****`.

const std = @import("std");
const rtmp = @import("rtmp.zig");
const Allocator = std.mem.Allocator;

pub const Secret = struct {
    value: []const u8,

    pub fn format(_: Secret, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.writeAll("****");
    }

    pub fn reveal(s: Secret) []const u8 {
        return s.value;
    }
};

pub const Destination = struct {
    name: []const u8,
    url: []const u8,
    key: Secret,

    /// Safe description for logs: name + host only, never the key.
    pub fn describe(d: Destination, w: *std.Io.Writer) std.Io.Writer.Error!void {
        const u = rtmp.Url.parse(d.url) catch {
            try w.print("{s} (invalid url)", .{d.name});
            return;
        };
        try w.print("{s} ({s}://{s}:{d}/{s}, key {f})", .{ d.name, if (u.tls) "rtmps" else "rtmp", u.host, u.port, u.app, d.key });
    }
};

pub const Config = struct {
    port: u16 = 7878,
    token: ?[]const u8 = null,
    clip_dir: []const u8 = "clips",
    clip_seconds: u32 = 300,
    allow_any_origin: bool = false,
    destinations: []const Destination = &.{},
};

pub const default_twitch_url = "rtmps://live.twitch.tv:443/app";
pub const default_youtube_url = "rtmps://a.rtmps.youtube.com:443/live2";

const FileDest = struct { name: []const u8, url: []const u8, key: []const u8 = "" };
const FileConfig = struct {
    port: ?u16 = null,
    token: ?[]const u8 = null,
    clip_dir: ?[]const u8 = null,
    clip_seconds: ?u32 = null,
    destinations: []const FileDest = &.{},
};

pub const Error = error{ BadConfig, BadDestinationUrl, OutOfMemory };

fn upsert(arena: Allocator, list: *std.ArrayList(Destination), d: Destination) Allocator.Error!void {
    for (list.items) |*e| {
        if (std.mem.eql(u8, e.name, d.name)) {
            e.* = d;
            return;
        }
    }
    try list.append(arena, d);
}

fn addIfKey(arena: Allocator, list: *std.ArrayList(Destination), name: []const u8, url: []const u8, key: ?[]const u8) Error!void {
    const k = key orelse return;
    if (k.len == 0) return; // destination without a key is ignored
    _ = rtmp.Url.parse(url) catch return error.BadDestinationUrl;
    try upsert(arena, list, .{
        .name = try arena.dupe(u8, name),
        .url = try arena.dupe(u8, url),
        .key = .{ .value = try arena.dupe(u8, k) },
    });
}

/// Build the config. All returned slices live in `arena`. `env` is any `std.process.Environ.Map`.
pub fn load(arena: Allocator, env: *const std.process.Environ.Map, file_json: ?[]const u8) Error!Config {
    var cfg: Config = .{};
    var dests: std.ArrayList(Destination) = .empty;

    if (file_json) |text| {
        const parsed = std.json.parseFromSliceLeaky(FileConfig, arena, text, .{ .ignore_unknown_fields = true }) catch return error.BadConfig;
        if (parsed.port) |p| cfg.port = p;
        cfg.token = parsed.token;
        if (parsed.clip_dir) |d| cfg.clip_dir = d;
        if (parsed.clip_seconds) |s| cfg.clip_seconds = s;
        for (parsed.destinations) |d| try addIfKey(arena, &dests, d.name, d.url, d.key);
    }

    if (env.get("KOINONIA_PORT")) |v| cfg.port = std.fmt.parseInt(u16, v, 10) catch return error.BadConfig;
    if (env.get("KOINONIA_TOKEN")) |v| if (v.len > 0) {
        cfg.token = try arena.dupe(u8, v);
    };
    if (env.get("KOINONIA_CLIP_DIR")) |v| cfg.clip_dir = try arena.dupe(u8, v);
    if (env.get("KOINONIA_CLIP_SECONDS")) |v| cfg.clip_seconds = std.fmt.parseInt(u32, v, 10) catch return error.BadConfig;
    if (env.get("KOINONIA_ALLOW_ANY_ORIGIN")) |v| cfg.allow_any_origin = v.len > 0 and !std.mem.eql(u8, v, "0");

    try addIfKey(arena, &dests, "twitch", env.get("KOINONIA_TWITCH_URL") orelse default_twitch_url, env.get("KOINONIA_TWITCH_KEY"));
    try addIfKey(arena, &dests, "youtube", env.get("KOINONIA_YOUTUBE_URL") orelse default_youtube_url, env.get("KOINONIA_YOUTUBE_KEY"));

    // KOINONIA_DEST_<NAME>_KEY with KOINONIA_DEST_<NAME>_URL
    const prefix = "KOINONIA_DEST_";
    var it = env.iterator();
    while (it.next()) |e| {
        const k = e.key_ptr.*;
        if (!std.mem.startsWith(u8, k, prefix) or !std.mem.endsWith(u8, k, "_KEY")) continue;
        const raw_name = k[prefix.len .. k.len - "_KEY".len];
        if (raw_name.len == 0) continue;
        const name = try std.ascii.allocLowerString(arena, raw_name);
        const url_key = try std.fmt.allocPrint(arena, "{s}{s}_URL", .{ prefix, raw_name });
        const url = env.get(url_key) orelse return error.BadDestinationUrl;
        try addIfKey(arena, &dests, name, url, e.value_ptr.*);
    }

    if (cfg.clip_seconds == 0) return error.BadConfig;
    cfg.destinations = try dests.toOwnedSlice(arena);
    return cfg;
}

pub fn find(cfg: Config, name: []const u8) ?Destination {
    for (cfg.destinations) |d| if (std.mem.eql(u8, d.name, name)) return d;
    return null;
}

const testing = std.testing;

test "env config with defaults, generic dest, and redaction" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("KOINONIA_PORT", "9000");
    try env.put("KOINONIA_TWITCH_KEY", "live_SECRET123");
    try env.put("KOINONIA_DEST_RESTREAM_KEY", "abc");
    try env.put("KOINONIA_DEST_RESTREAM_URL", "rtmp://example.invalid:1936/in");
    try env.put("KOINONIA_YOUTUBE_URL", "rtmps://a.rtmps.youtube.com:443/live2"); // no key -> ignored

    const cfg = try load(arena, &env, null);
    try testing.expectEqual(@as(u16, 9000), cfg.port);
    try testing.expectEqual(@as(usize, 2), cfg.destinations.len);
    const tw = find(cfg, "twitch").?;
    try testing.expectEqualStrings(default_twitch_url, tw.url);
    try testing.expect(find(cfg, "youtube") == null);
    try testing.expectEqualStrings("rtmp://example.invalid:1936/in", find(cfg, "restream").?.url);

    var buf: [256]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try tw.describe(&w);
    try testing.expect(std.mem.indexOf(u8, w.buffered(), "SECRET") == null);
    try testing.expect(std.mem.indexOf(u8, w.buffered(), "****") != null);
    w = .fixed(&buf);
    try w.print("{f}", .{tw.key});
    try testing.expectEqualStrings("****", w.buffered());
}

test "file config overridden by env" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("KOINONIA_CLIP_SECONDS", "120");
    try env.put("KOINONIA_TWITCH_KEY", "fromenv");
    const json =
        \\{"port":8123,"clip_seconds":600,"clip_dir":"c","unknown":1,
        \\ "destinations":[{"name":"twitch","url":"rtmps://live.twitch.tv:443/app","key":"fromfile"},
        \\                 {"name":"nokey","url":"rtmp://x/y"}]}
    ;
    const cfg = try load(arena, &env, json);
    try testing.expectEqual(@as(u16, 8123), cfg.port);
    try testing.expectEqual(@as(u32, 120), cfg.clip_seconds);
    try testing.expectEqualStrings("c", cfg.clip_dir);
    try testing.expectEqual(@as(usize, 1), cfg.destinations.len);
    try testing.expectEqualStrings("fromenv", cfg.destinations[0].key.reveal());
}

test "bad inputs" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try testing.expectError(error.BadConfig, load(arena, &env, "{nope"));
    try env.put("KOINONIA_PORT", "abc");
    try testing.expectError(error.BadConfig, load(arena, &env, null));
    try env.put("KOINONIA_PORT", "1");
    try env.put("KOINONIA_TWITCH_URL", "http://bad");
    try env.put("KOINONIA_TWITCH_KEY", "k");
    try testing.expectError(error.BadDestinationUrl, load(arena, &env, null));
}
