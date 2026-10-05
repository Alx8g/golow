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

**Less clutter.** Upsells and creator tools are gone: Try Artist Pro, Artist Studio, Upload, artist follow suggestions, app-store badges, footer links and banners that sell a plan. Liked tracks show an orange heart everywhere, including SoundCloud's redesigned track pages, and their waveforms render at full contrast. Pages use up to 1840 px on wide monitors, and below 1000 px the sidebar drops so narrow windows never scroll sideways.

**Listening.**
- Shuffle all on Likes plays every like in a truly random order. SoundCloud's own queue only ever holds about 27 tracks, which is why its shuffle repeats the same few; GoLow keeps the order itself and plays each pick through SoundCloud's player while the Likes page stays open.
- A filter box on Likes searches every like, not just the ones loaded.
- Next to the Feed's Reposts switch, Mixes hides anything over 20 minutes and Played hides tracks you have already heard.
- Pressing play after a restart picks up where you left off.
- Turning autoplay off stays off, instead of SoundCloud switching it back on each track.
- The mouse wheel over the speaker icon changes volume. Keyboard media keys and the Windows media overlay work as usual.

**The window.** The title shows the playing track, so the taskbar does too. Closing the window while music plays keeps it playing from a tray icon; closing while paused quits. Launching GoLow again brings the window back. The mini player shrinks the window to SoundCloud's control bar, and pairs well with Keep on top.

**Settings** live behind the sliders icon in SoundCloud's header, next to the ⋯ menu, or `Ctrl+,`: Clean up interface, Reduce background work, Mini player, Keep on top, Waveform comments, Top comments first, Autoplay related tracks, and Discord status when built with a Discord application ID. Add `?noclean` to a SoundCloud URL to load one page without cleanup.

**Reduce background work** stops the hidden buffering icons from forcing a layout on every display refresh, skips a short, exact list of ad and tracking bootstrap scripts and the hidden Artist Tools frame, and asks WebView2 for a low memory target while minimized. Audio, CDN, consent, OAuth and security requests are never filtered. This is not a general tracker blocker.

GoLow allows top-level navigation and sign-in popups only to SoundCloud and its exact login providers (Google, Apple, Facebook, Microsoft, GitHub). SoundCloud requires signing in before anything plays.

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

Discord status needs a Discord application ID: create an application at the [Discord developer portal](https://discord.com/developers/applications) and build with `GOLOW_DISCORD_APP_ID` set to its ID. Without it, the switch is hidden and nothing connects to Discord.

`uv run scripts/benchmark.py --exe old=path\to\old.exe --exe new=target\release\golow.exe --cdp` compares builds on startup, CPU and memory, using throwaway profiles under `.working\bench`. Set `GOLOW_PROFILE_DIR` to run the app against a separate profile while testing.

## License

[MIT](LICENSE). SoundCloud and Go+ are trademarks of SoundCloud.
