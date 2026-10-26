//! QA tests for the daemon, written against its public surface (`koinonia.framing/flv/amf0/rtmp`).
//! Adapts: sections guarded by `@hasDecl` are skipped (compile-time) when the daemon API moves.
const std = @import("std");
const testing = std.testing;
const koinonia = @import("koinonia");
const opts = @import("qa_options");
const golden = @embedFile("golden");

test {
    _ = @import("conformance.zig");
    _ = @import("fuzz.zig");
}

comptime {
    // Fail loudly (not silently skip) if the surface that conformance depends on disappears.
    if (!@hasDecl(koinonia, "framing")) @compileError("daemon root.zig must export `framing`");
    if (!@hasDecl(koinonia.framing, "parse")) @compileError("daemon framing.parse missing");
    _ = golden;
    _ = opts;
}
