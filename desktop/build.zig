const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const io = b.graph.io;

    const studio_dist = b.option(
        []const u8,
        "studio-dist",
        "Directory with the built studio (default ../studio/dist; run `npm run build` in studio/ first)",
    ) orelse "../studio/dist";

    const daemon = b.dependency("koinonia_d", .{ .target = target, .optimize = optimize });
    const daemon_mod = daemon.module("koinonia");

    // ---- embedded studio assets -------------------------------------------------
    // A host tool (tools/gen_assets.zig) copies studio_dist into the build output and writes a
    // module with one @embedFile per file. It runs as a build step with the directory as an input,
    // so editing/rebuilding the studio re-embeds it (no stale cache).
    const gen_exe = b.addExecutable(.{
        .name = "gen_assets",
        .root_module = b.createModule(.{
            .root_source_file = b.path("tools/gen_assets.zig"),
            .target = b.graph.host,
            .optimize = .Debug,
        }),
    });
    const gen = b.addRunArtifact(gen_exe);
    const dist_exists = if (std.Io.Dir.cwd().openDir(io, studio_dist, .{})) |d| blk: {
        d.close(io);
        break :blk true;
    } else |_| false;
    if (dist_exists) {
        gen.addDirectoryArg(if (std.fs.path.isAbsolute(studio_dist)) b.graph.cwdRelativePath(studio_dist) else b.path(studio_dist));
    } else {
        std.log.warn("studio dist not found at {s}; embedding nothing (build the studio: cd studio && npm run build)", .{studio_dist});
        const empty = b.addWriteFiles();
        _ = empty.add(".empty", "");
        gen.addDirectoryArg(empty.getDirectory());
    }
    const gen_out = gen.addOutputDirectoryArg("assets");
    const assets_mod = b.createModule(.{
        .root_source_file = gen_out.path(b, "assets.zig"),
        .target = target,
        .optimize = optimize,
    });

    // ---- executable --------------------------------------------------------------
    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "koinonia", .module = daemon_mod },
            .{ .name = "assets", .module = assets_mod },
        },
    });
    const exe = b.addExecutable(.{ .name = "koinonia", .root_module = root });
    b.installArtifact(exe);

    const run_step = b.step("run", "Run koinonia (desktop)");
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    run_cmd.addPassthruArgs();
    run_step.dependOn(&run_cmd.step);

    const tests = b.addTest(.{ .root_module = root });
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
