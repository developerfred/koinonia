<div align="center">

# Koinonia

**κοινωνία** — "sharing"

A browser-based streaming studio plus a Zig daemon for **Twitch** and **YouTube**.
Agent-controlled via **WebMCP**. No OBS.

[Docs](https://developerfred.github.io/koinonia/) · [Plan](PLANO.md) · [Português](README.md) · [Contributing](CONTRIBUTING.md)

</div>

> **Honest status:** work in progress. No real stream to Twitch or YouTube has been
> tested yet. See the status table in the [Portuguese README](README.md#status).

## What it is

- **Browser studio:** camera, screen, scenes and encoding (WebCodecs), no OBS install.
- **Zig daemon (`koinonia-d`):** receives already-encoded media over a local WebSocket and fans it out over RTMP(S) to several platforms, with no re-encoding.
- **Agents:** producer, moderator, clipper, analyst and token economist operate the stream through the page's WebMCP tools.
- **Vertical clips and post-live:** moment detection, 9:16 reframing, captions and a post-stream report.
- **Two views:** **Foco** (one thing at a time, calm) and **Painel** (everything visible), switchable with `Alt+V`.

## Quick start

Requires [Zig 0.17](https://ziglang.org/download/), Node.js 24+ and a Chromium-based browser.

```bash
git clone https://github.com/developerfred/koinonia.git
cd koinonia/daemon && zig build test && zig build
cd ../studio && npm install && npm run dev
```

Stream keys go in environment variables or a local config file, never in the repository. They are always printed as `****`.

## Security

Localhost-only daemon with Origin check, chat treated as untrusted data, and human approval for sensitive actions (ban, delete, stop stream, publish clip). Report issues via [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
