//! Discovery and launch arguments for a Chromium-family browser in --app mode.
//!
//! Only Chromium-family browsers qualify (WebCodecs H.264/AAC encode, getDisplayMedia, background
//! throttling flags). Order of preference: Chrome (has the proprietary codecs), Edge, Brave,
//! Chromium (distro builds often lack AAC/H.264 encoding, so it is last).

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Environ = std.process.Environ;

pub const Kind = enum { chrome, edge, brave, chromium };

pub const Found = struct {
    kind: Kind,
    /// Absolute path of the executable.
    path: []const u8,
};

pub fn kindName(k: Kind) []const u8 {
    return switch (k) {
        .chrome => "Google Chrome",
        .edge => "Microsoft Edge",
        .brave => "Brave",
        .chromium => "Chromium",
    };
}

pub const Candidate = struct {
    kind: Kind,
    /// Absolute path, or (Linux only, `on_path`) a bare executable name looked up in PATH.
    path: []const u8,
    on_path: bool = false,
};

/// Candidate executables for `os`, most preferred first. Memory lives in `arena`.
pub fn candidates(arena: Allocator, os: std.Target.Os.Tag, env: *const Environ.Map) Allocator.Error![]Candidate {
    var list: std.ArrayList(Candidate) = .empty;
    switch (os) {
        .macos => {
            const apps = [_]struct { k: Kind, p: []const u8 }{
                .{ .k = .chrome, .p = "Google Chrome.app/Contents/MacOS/Google Chrome" },
                .{ .k = .edge, .p = "Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
                .{ .k = .brave, .p = "Brave Browser.app/Contents/MacOS/Brave Browser" },
                .{ .k = .chromium, .p = "Chromium.app/Contents/MacOS/Chromium" },
            };
            for (apps) |a| try list.append(arena, .{ .kind = a.k, .path = try std.fmt.allocPrint(arena, "/Applications/{s}", .{a.p}) });
            if (env.get("HOME")) |home| {
                for (apps) |a| try list.append(arena, .{ .kind = a.k, .path = try std.fmt.allocPrint(arena, "{s}/Applications/{s}", .{ home, a.p }) });
            }
        },
        .windows => {
            const roots = [_][]const u8{ "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "ProgramW6432" };
            const rels = [_]struct { k: Kind, p: []const u8 }{
                .{ .k = .chrome, .p = "Google\\Chrome\\Application\\chrome.exe" },
                .{ .k = .edge, .p = "Microsoft\\Edge\\Application\\msedge.exe" },
                .{ .k = .brave, .p = "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
                .{ .k = .chromium, .p = "Chromium\\Application\\chrome.exe" },
            };
            for (rels) |r| {
                for (roots) |root_name| {
                    const root = env.get(root_name) orelse continue;
                    if (root.len == 0) continue;
                    try list.append(arena, .{ .kind = r.k, .path = try std.fmt.allocPrint(arena, "{s}\\{s}", .{ std.mem.trimEnd(u8, root, "\\"), r.p }) });
                }
            }
        },
        else => {
            const names = [_]struct { k: Kind, n: []const u8 }{
                .{ .k = .chrome, .n = "google-chrome-stable" },
                .{ .k = .chrome, .n = "google-chrome" },
                .{ .k = .edge, .n = "microsoft-edge-stable" },
                .{ .k = .edge, .n = "microsoft-edge" },
                .{ .k = .brave, .n = "brave-browser" },
                .{ .k = .brave, .n = "brave" },
                .{ .k = .chromium, .n = "chromium" },
                .{ .k = .chromium, .n = "chromium-browser" },
            };
            for (names) |n| try list.append(arena, .{ .kind = n.k, .path = n.n, .on_path = true });
            try list.append(arena, .{ .kind = .chrome, .path = "/opt/google/chrome/chrome" });
            try list.append(arena, .{ .kind = .chromium, .path = "/snap/bin/chromium" });
            try list.append(arena, .{ .kind = .chrome, .path = "/var/lib/flatpak/exports/bin/com.google.Chrome" });
            try list.append(arena, .{ .kind = .chromium, .path = "/var/lib/flatpak/exports/bin/org.chromium.Chromium" });
        },
    }
    return list.items;
}

fn isExecutable(io: Io, path: []const u8) bool {
    Io.Dir.accessAbsolute(io, path, .{ .execute = true }) catch return false;
    return true;
}

fn searchPath(arena: Allocator, io: Io, env: *const Environ.Map, name: []const u8) ?[]const u8 {
    const path_var = env.get("PATH") orelse return null;
    var it = std.mem.tokenizeScalar(u8, path_var, std.fs.path.delimiter);
    while (it.next()) |dir| {
        if (!std.fs.path.isAbsolute(dir)) continue;
        const full = std.fs.path.join(arena, &.{ dir, name }) catch return null;
        if (isExecutable(io, full)) return full;
    }
    return null;
}

/// First installed candidate for the host OS, or null.
pub fn find(arena: Allocator, io: Io, env: *const Environ.Map) ?Found {
    const cs = candidates(arena, builtin.os.tag, env) catch return null;
    for (cs) |c| {
        if (c.on_path) {
            if (searchPath(arena, io, env, c.path)) |p| return .{ .kind = c.kind, .path = p };
        } else if (isExecutable(io, c.path)) {
            return .{ .kind = c.kind, .path = c.path };
        }
    }
    return null;
}

/// Every installed candidate (for --list-browsers).
pub fn findAll(arena: Allocator, io: Io, env: *const Environ.Map) []Found {
    var out: std.ArrayList(Found) = .empty;
    const cs = candidates(arena, builtin.os.tag, env) catch return out.items;
    for (cs) |c| {
        const p: ?[]const u8 = if (c.on_path) searchPath(arena, io, env, c.path) else if (isExecutable(io, c.path)) c.path else null;
        if (p) |path| out.append(arena, .{ .kind = c.kind, .path = path }) catch break;
    }
    return out.items;
}

/// Per-user profile directory dedicated to Koinonia (never the user's everyday browser profile).
pub fn defaultProfileDir(arena: Allocator, os: std.Target.Os.Tag, env: *const Environ.Map) ?[]const u8 {
    switch (os) {
        .windows => {
            const base = env.get("LOCALAPPDATA") orelse return null;
            return std.fmt.allocPrint(arena, "{s}\\Koinonia\\browser-profile", .{std.mem.trimEnd(u8, base, "\\")}) catch null;
        },
        .macos => {
            const home = env.get("HOME") orelse return null;
            return std.fmt.allocPrint(arena, "{s}/Library/Application Support/Koinonia/browser-profile", .{home}) catch null;
        },
        else => {
            if (env.get("XDG_DATA_HOME")) |x| {
                if (x.len > 0 and std.fs.path.isAbsolute(x)) return std.fmt.allocPrint(arena, "{s}/koinonia/browser-profile", .{x}) catch null;
            }
            const home = env.get("HOME") orelse return null;
            return std.fmt.allocPrint(arena, "{s}/.local/share/koinonia/browser-profile", .{home}) catch null;
        },
    }
}

/// Flags that keep the studio alive when its window is hidden or covered. Rationale in DESIGN.md.
pub const anti_throttle_flags = [_][]const u8{
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-ipc-flooding-protection",
    // CalculateNativeWinOcclusion: Windows marks covered windows as hidden otherwise.
    // IntensiveWakeUpThrottling: Chromium throttles timers of pages hidden for > 5 min.
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
    // Best effort, unverified on stable channels: WebMCP (navigator.modelContext) is behind a
    // feature flag in early Chrome builds. Unknown feature names are ignored by Chromium.
    "--enable-features=WebMCP,WebMCPTesting",
    "--autoplay-policy=no-user-gesture-required",
};

/// Build the full argv: exe + flags + --app=url. Memory lives in `arena`.
pub fn buildArgv(arena: Allocator, exe: []const u8, url: []const u8, profile_dir: []const u8, extra: []const []const u8) Allocator.Error![]const []const u8 {
    var a: std.ArrayList([]const u8) = .empty;
    try a.append(arena, exe);
    try a.append(arena, try std.fmt.allocPrint(arena, "--app={s}", .{url}));
    try a.append(arena, try std.fmt.allocPrint(arena, "--user-data-dir={s}", .{profile_dir}));
    try a.append(arena, "--no-first-run");
    try a.append(arena, "--no-default-browser-check");
    try a.append(arena, "--hide-crash-restore-bubble");
    try a.append(arena, "--window-size=1440,900");
    try a.appendSlice(arena, &anti_throttle_flags);
    try a.appendSlice(arena, extra);
    return a.items;
}

pub const install_help =
    \\No suitable browser found.
    \\
    \\Koinonia's studio needs a Chromium-based browser (WebCodecs H.264/AAC, screen capture).
    \\Install one of:
    \\  - Google Chrome   https://www.google.com/chrome/        (recommended: ships H.264/AAC)
    \\  - Microsoft Edge  https://www.microsoft.com/edge        (preinstalled on Windows 10/11)
    \\  - Brave           https://brave.com/download/
    \\  - Chromium        (Linux: your package manager; some builds lack AAC encoding)
    \\
    \\Linux examples:
    \\  Debian/Ubuntu: download the .deb from the Chrome site, then `sudo apt install ./google-chrome-stable_current_amd64.deb`
    \\  Fedora:        `sudo dnf install fedora-workstation-repositories && sudo dnf config-manager setopt google-chrome.enabled=1 && sudo dnf install google-chrome-stable`
    \\  Arch:          `yay -S google-chrome` (AUR) or `sudo pacman -S chromium`
    \\
    \\Already installed somewhere unusual? Run:  koinonia --browser /path/to/browser
    \\(or set KOINONIA_BROWSER). Without a browser you can still run `koinonia --no-browser`
    \\and open the printed URL yourself in a Chromium-based browser.
    \\
;

test "macos candidates prefer chrome and expand HOME" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env = Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("HOME", "/Users/x");
    const cs = try candidates(arena, .macos, &env);
    try std.testing.expectEqual(Kind.chrome, cs[0].kind);
    try std.testing.expectEqualStrings("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", cs[0].path);
    try std.testing.expectEqualStrings("/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", cs[4].path);
}

test "windows candidates use program files env vars" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env = Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("ProgramFiles", "C:\\Program Files");
    try env.put("LOCALAPPDATA", "C:\\Users\\x\\AppData\\Local\\");
    const cs = try candidates(arena, .windows, &env);
    try std.testing.expectEqualStrings("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", cs[0].path);
    try std.testing.expectEqualStrings("C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", cs[1].path);
}

test "linux candidates are PATH names" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var env = Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    const cs = try candidates(arena_state.allocator(), .linux, &env);
    try std.testing.expect(cs[0].on_path);
    try std.testing.expectEqualStrings("google-chrome-stable", cs[0].path);
}

test "argv has app url, dedicated profile and anti-throttle flags" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const argv = try buildArgv(arena_state.allocator(), "/bin/chrome", "http://127.0.0.1:5000/", "/p", &.{"--x"});
    try std.testing.expectEqualStrings("--app=http://127.0.0.1:5000/", argv[1]);
    try std.testing.expectEqualStrings("--user-data-dir=/p", argv[2]);
    var has_bg = false;
    for (argv) |a| if (std.mem.eql(u8, a, "--disable-renderer-backgrounding")) {
        has_bg = true;
    };
    try std.testing.expect(has_bg);
    try std.testing.expectEqualStrings("--x", argv[argv.len - 1]);
}

test "profile dir per os" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env = Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("HOME", "/home/u");
    try std.testing.expectEqualStrings("/home/u/.local/share/koinonia/browser-profile", defaultProfileDir(arena, .linux, &env).?);
    try env.put("XDG_DATA_HOME", "/data");
    try std.testing.expectEqualStrings("/data/koinonia/browser-profile", defaultProfileDir(arena, .linux, &env).?);
}
