# GoLow

GoLow is a small, fast, unofficial desktop client for SoundCloud on Windows. It runs the real soundcloud.com in the WebView2 runtime that ships with Windows, so sign-in, Go+ playback and DRM work exactly as they do in Edge, and it trims the work SoundCloud's page does that you never see.

GoLow is not affiliated with or endorsed by SoundCloud. It does not download streams, unlock paid features or change what your subscription includes.

## Performance

Measured with `scripts/benchmark.py` against the last SoundCloud Go+ build, idle on the logged-out Discover page, 10 runs per build across two sessions on a Windows 11 PC with a 180 Hz display:

| Window visible, idle | SoundCloud Go+ 0.1.6 | GoLow |
|---|---|---|
| CPU, share of one core | 9 to 34% | 0.9 to 3.6% |
| Page layout and style work | 6 to 32 ms every second | none |
| Private memory, all processes | 353 to 532 MiB | 321 to 384 MiB |

Most of the gap is one fix. Each playlist tile on SoundCloud hides a buffering icon that spins forever, and Chromium redoes the page layout for it on every display refresh, so faster screens pay more. GoLow stops rendering that icon only while SoundCloud itself keeps it hidden. Minimized, both builds idle near 1% of one core.

## What it does

Settings live behind the sliders icon in SoundCloud's header, next to the ⋯ menu, or `Ctrl+,`. There are four switches:

- **Clean up interface** hides upsells and listener-irrelevant modules: Try Artist Pro, Artist Studio, Upload, artist follow suggestions, app-store badges, footer links and banners that sell a plan. Exact CSS rules never touch the player, forms, dialogs or cookie consent. Below 1000 px wide the sidebar drops and SoundCloud's fixed 960 px layout reflows, so narrow windows need no horizontal scrolling. Scrollbars follow the dark theme.
- **Reduce background work** stops the hidden buffering icons from forcing a layout on every display refresh, skips a short, exact list of ad and tracking bootstrap scripts and the hidden Artist Tools frame, and asks WebView2 for a low memory target while minimized. Audio, CDN, consent, OAuth and security requests are never filtered. This is not a general tracker blocker.
- **Mini player** shrinks the window to SoundCloud's control bar: previous, play, next, progress and the current track. The expand button on the right returns to the full window.
- **Keep on top** pins the window above others, which pairs well with the mini player.

Keyboard media keys and the Windows media overlay work through WebView2. GoLow remembers window size and position, restores the existing window instead of opening a second copy, and allows top-level navigation and sign-in popups only to SoundCloud and its exact login providers (Google, Apple, Facebook, Microsoft, GitHub). Add `?noclean` to a SoundCloud URL to load one page without cleanup.

## Install

Download `golow-windows-x64.zip` from [Releases](https://github.com/Alx8g/golow/releases), extract it and run:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Restart
```

This installs to `%LOCALAPPDATA%\Programs\GoLow` with Start menu and desktop shortcuts and an entry in Installed apps. The previous build is kept as `golow.previous.exe`. You can also run `golow.exe` directly without installing. The executable is not code-signed yet, so SmartScreen may warn on first launch.

Your sign-in and settings live in `%APPDATA%\golow`. Builds released as SoundCloud Go+ used `%APPDATA%\soundcloud-go-client`, and GoLow keeps using that folder when it exists, so you stay signed in. Uninstalling keeps this folder.

## Build from source

Requires Rust (MSVC toolchain), the Visual Studio C++ build tools and Node.js 22 or later.

```powershell
cargo build --release              # target\release\golow.exe
cargo test
node --test tests/client.test.mjs  # page script tests, uses headless Edge
```

`uv run scripts/benchmark.py --exe old=path\to\old.exe --exe new=target\release\golow.exe --cdp` compares builds on startup, CPU and memory, using throwaway profiles under `.working\bench`. Set `GOLOW_PROFILE_DIR` to run the app against a separate profile while testing.

## License

[MIT](LICENSE). SoundCloud and Go+ are trademarks of SoundCloud.
