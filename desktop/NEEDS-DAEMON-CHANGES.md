# Proposed daemon / studio changes (not applied)

The desktop app imports `daemon/src` as a Zig package dependency
(`.koinonia_d = .{ .path = "../daemon" }`, module `koinonia`). Nothing in `daemon/` or
`studio/` was edited. The items below would remove workarounds in `desktop/`.

## 1. Studio wiring (resolved upstream while this was written)

When this work started the studio spoke a draft protocol on port 7777 and had no way to receive the
ingest URL. The studio has since been updated (`studio/src/protocol.ts` follows `daemon/PROTOCOL.md`
v1, default URL `ws://127.0.0.1:7878/ingest`, and `studio/src/main.ts` reads `?daemon=` and `?token=`
from the page URL). The desktop app uses exactly that: it opens
`http://127.0.0.1:<http>/?daemon=ws://127.0.0.1:<ingest>/ingest&token=<per-run token>`.
`studio/PROTOCOL-NOTES.md` still describes the old draft and could be deleted or corrected.

For `dist` folders built before that change the desktop also rewrites the hardcoded
`ws://127.0.0.1:7777/ingest` / `:7878/ingest` literals in served JS and injects
`window.__KOINONIA__ = {desktop, ws, origin}`. Both are fallbacks and can be removed once old
builds no longer matter (`desktop/src/site.zig`).

Not verified: an actual media session studio -> desktop daemon -> RTMP (no stream key used here).

## 2. Small studio suggestion

Keep the token out of the address bar history: after reading `?token=` the studio could
`history.replaceState` to drop it from `location` (the app window has no URL bar, so this is cosmetic).

## 3. Make the accept loop importable

`daemon/src/main.zig` owns the listener, TLS context loading and the accept loop, so
`desktop/src/main.zig` re-implements ~25 lines of it (`ingestLoop`, the `TlsCtx` bootstrap). Proposal:
add to `daemon/src/session.zig` (or a new `server.zig` exported from `root.zig`):

```zig
pub fn acceptLoop(app: *App, server: *std.Io.net.Server) void   // returns on Canceled
pub fn needsTls(cfg: config.Config) bool
```

and have `koinonia-d` call them. Behaviour must stay cancel-friendly (return on `error.Canceled`)
so a host can stop it with `Io.Group.cancel`.

## 4. Smaller items

- `config.Config` does not say whether `clip_dir` / `port` were set explicitly, so the desktop cannot
  tell "default" from "user chose `clips`". Proposal: make them optional in `Config`, or add a
  `config.Defaults` struct the host can override before `load`.
- Optional: `session.App` could expose a `shutdown()` that sends a close frame and flushes RTMP
  before the host cancels tasks (today shutdown relies on task cancellation plus `Session.shutdown`).
- Optional: serve plain `GET` (static assets) from the same listener as `/ingest` to avoid the second
  port. The desktop uses two loopback ports so that `daemon/` stays untouched.
