// QA build for the Zig daemon: golden conformance + fuzz/property tests against daemon/src/root.zig.
// Nothing here modifies daemon/. Run: `zig build test` (from qa/zig) or `make qa-zig`.
//   zig build test --fuzz        # coverage-guided fuzzing (long-running, see qa/README.md)
//   zig build test -Dfuzz-iters=200000   # bounded pseudo-random runner (deterministic seed), used in CI
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const daemon_root = b.option([]const u8, "daemon-root", "path to daemon/src/root.zig") orelse "../../daemon/src/root.zig";
    const iters = b.option(u32, "fuzz-iters", "iterations for the bounded random runner") orelse 20000;

    const koinonia = b.createModule(.{ .root_source_file = b.path(daemon_root), .target = target, .optimize = optimize });
    // Comma-separated ids of documented daemon bugs whose fuzz checks are skipped (they would abort the whole test binary).
    // Mirror of qa/known-gaps.json "zig.*" entries. Run with -Dknown-gaps=none to see them crash.
    const known = b.option([]const u8, "known-gaps", "known gaps to skip, comma separated, or 'none'") orelse "amf0-commandName-u16-overflow";
    const opts = b.addOptions();
    opts.addOption([]const u8, "known_gaps", known);
    opts.addOption(u32, "fuzz_iters", iters);

    const t = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("qa_zig.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "koinonia", .module = koinonia },
            .{ .name = "qa_options", .module = opts.createModule() },
        },
    }) });
    t.root_module.addAnonymousImport("golden", .{ .root_source_file = b.path("../fixtures/protocol/golden.txt") });

    const run = b.addRunArtifact(t);
    const step = b.step("test", "Run golden conformance + fuzz tests against the daemon");
    step.dependOn(&run.step);
}
