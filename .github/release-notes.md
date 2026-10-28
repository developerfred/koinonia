**Alpha, unsigned binaries.** Only macOS arm64 has been run by the maintainers. Linux, Windows and Intel macOS binaries compile but are untested. No real Twitch or YouTube stream has been validated with this build yet.

Requires a Chromium-family browser (Chrome recommended) with H.264/AAC WebCodecs encoding. Put your stream keys in environment variables (`KOINONIA_YOUTUBE_KEY`, `KOINONIA_TWITCH_KEY`) or a local config file, never in the repository.

macOS: the binary is not notarized. Run it from a terminal, or clear quarantine with `xattr -d com.apple.quarantine koinonia`.

Verify downloads with the `.sha256` files.
