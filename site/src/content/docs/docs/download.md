---
title: "Download"
description: "Download the Koinonia desktop app (alpha, unsigned): pick the build for your system, verify the checksum, and start the studio. Or build it from source."
sidebar:
  order: 3
  label: "Download"
  badge:
    text: "Alpha"
    variant: "caution"
---

:::caution[Alpha, unsigned, barely tested]
The desktop app is an early alpha. Only **macOS on Apple silicon (arm64)** has been built and run by the maintainers. Linux, Windows and Intel Mac builds are cross-compiled from Linux and have **not been run by anyone yet**. The binaries are **not code-signed or notarized**, so your system will warn you when you open them. Nothing has been verified against real Twitch or YouTube beyond the maintainer's first test live.
:::

<!--dl-start-->
<div class="dl" data-dl>
  <p class="dl-status" data-dl-status role="status" aria-live="polite">Looking up the newest release&hellip;</p>
  <div class="dl-pick" data-dl-pick hidden>
    <p class="dl-pick-label" data-dl-pick-label></p>
    <p class="dl-pick-actions" data-dl-pick-actions></p>
  </div>
  <noscript><p>JavaScript is off, so your system cannot be detected. Use the table below and the <a href="https://github.com/developerfred/koinonia/releases">releases page</a>.</p></noscript>
</div>
<!--dl-end-->

## All builds

Assets are named `koinonia-{linux,windows,macos}-{x86_64,aarch64}` with `.tar.gz` (`.zip` on Windows), plus a `.sha256` file for each.

Asset names are fixed by the release workflow. When a release is found, the file names below become direct links; otherwise they stay plain text and you pick by hand.

<!--dl-start-->
<div class="dl-table" data-dl-table>

| System | CPU | Archive | Checksum | Tested by maintainers |
| --- | --- | --- | --- | --- |
| macOS | Apple silicon (arm64) | <span data-asset="koinonia-macos-aarch64" data-ext="tar.gz"><code>koinonia-macos-aarch64.tar.gz</code></span> | <span data-asset="koinonia-macos-aarch64" data-ext="sha256"><code>.sha256</code></span> | Yes, built and run |
| macOS | Intel (x86_64) | <span data-asset="koinonia-macos-x86_64" data-ext="tar.gz"><code>koinonia-macos-x86_64.tar.gz</code></span> | <span data-asset="koinonia-macos-x86_64" data-ext="sha256"><code>.sha256</code></span> | No, untested |
| Linux | x86_64 | <span data-asset="koinonia-linux-x86_64" data-ext="tar.gz"><code>koinonia-linux-x86_64.tar.gz</code></span> | <span data-asset="koinonia-linux-x86_64" data-ext="sha256"><code>.sha256</code></span> | No, untested |
| Linux | arm64 (aarch64) | <span data-asset="koinonia-linux-aarch64" data-ext="tar.gz"><code>koinonia-linux-aarch64.tar.gz</code></span> | <span data-asset="koinonia-linux-aarch64" data-ext="sha256"><code>.sha256</code></span> | No, untested |
| Windows | x86_64 | <span data-asset="koinonia-windows-x86_64" data-ext="zip"><code>koinonia-windows-x86_64.zip</code></span> | <span data-asset="koinonia-windows-x86_64" data-ext="sha256"><code>.sha256</code></span> | No, untested |
| Windows | arm64 (aarch64) | <span data-asset="koinonia-windows-aarch64" data-ext="zip"><code>koinonia-windows-aarch64.zip</code></span> | <span data-asset="koinonia-windows-aarch64" data-ext="sha256"><code>.sha256</code></span> | No, untested |

</div>
<!--dl-end-->

Releases are tagged `desktop-v*` and published as **pre-releases**, which is why GitHub's "latest release" shortcut does not point at them. The page above looks through the release list for the newest `desktop-v*` tag instead. You can always browse them yourself on the [releases page](https://github.com/developerfred/koinonia/releases).

## Requirements

- A **Chromium-family browser** already installed: Google Chrome (recommended), Microsoft Edge, Brave or Chromium. The app opens the studio in it; capture and encoding happen in the browser.
- The browser must be able to **encode H.264 video and AAC audio** with WebCodecs. Chrome and Edge include these; some Linux Chromium builds do not. On start the app runs a codec check and prints a warning naming the browser if either encoder is missing. Pass `--strict` to make that a hard failure.
- A desktop operating system. Phones and tablets are not supported.

## Verify the download

Each archive has a `.sha256` file with a line in the form `hash  filename`. Put both files in the same folder and run the check for your system:

```sh
# macOS
shasum -a 256 -c koinonia-macos-aarch64.sha256

# Linux
sha256sum -c koinonia-linux-x86_64.sha256
```

```powershell
# Windows PowerShell: compare this output with the hash inside the .sha256 file
Get-FileHash .\koinonia-windows-x86_64.zip -Algorithm SHA256
```

You want `OK` (or two identical hashes). This detects a damaged or incomplete download. It does **not** prove who made the file, because the checksum is published next to the archive and the binaries are unsigned. If that matters to you, build from source.

## Install and run

```sh
# macOS and Linux
tar -xzf koinonia-macos-aarch64.tar.gz
./koinonia
```

```powershell
# Windows PowerShell
Expand-Archive .\koinonia-windows-x86_64.zip -DestinationPath .\koinonia
.\koinonia\koinonia.exe
```

### macOS: unsigned app and quarantine

The binary is not signed or notarized, so macOS may refuse to open a file downloaded with a browser. Check the checksum first, then clear the quarantine flag on the extracted binary:

```sh
xattr -d com.apple.quarantine ./koinonia
```

If you would rather not change the flag, build from source instead: a binary you compile yourself is not quarantined.

### Windows and Linux

Windows SmartScreen will warn about an unrecognised publisher. On Linux you may need `chmod +x koinonia`. These platforms have not been tested, so please [open an issue](https://github.com/developerfred/koinonia/issues) with what you see.

## Stream keys

Keys go in **environment variables** read by the process, never in the studio page, a screenshot, a chat message or a repository:

```sh
read -rs KOINONIA_TWITCH_KEY && export KOINONIA_TWITCH_KEY
read -rs KOINONIA_YOUTUBE_KEY && export KOINONIA_YOUTUBE_KEY
./koinonia
```

`read -rs` keeps the key out of your shell history and off the screen. The app never prints keys. A `--config file.json` also works; keep that file outside any repository and readable only by you. See the [daemon protocol](../reference/daemon-protocol/) for the full list of settings.

## Build from source instead

This is the most trustworthy route today, and the only one that has been exercised on more than one machine. You need Zig 0.17.0 and Node.js.

```sh
git clone https://github.com/developerfred/koinonia.git
cd koinonia
(cd studio && npm ci && npm run build)   # produces studio/dist, embedded into the binary
cd desktop
zig build                                # -> zig-out/bin/koinonia
./zig-out/bin/koinonia
```

Flags, exit codes and the codec check are described on the [Desktop app](../desktop/) page.
