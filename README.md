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

**Mixes and podcasts.**
- The GoLow panel shows a mix's tracklist, read from its description, with times you can click and the current track marked. Find IDs in comments collects the tracklists and track names people post in the comments.
- The track playing inside a mix shows in the title bar, on Discord and on Last.fm, which scrobbles each identified track instead of the whole mix. Unknown IDs are shown but never scrobbled.
- Times in descriptions and comments on track pages are clickable.
- Skip back and forward (10 and 30 seconds by default, or `[` and `]`), go to an exact time, and set the speed from 0.75× to 2× with natural pitch, remembered for each track. Skips land on the exact second, even in a three-hour mix.
- Bookmarks with notes appear as dots on the timeline (`Shift+B`).
- Anything 10 minutes or longer resumes where you stopped it, each one separately, and Continue lists what you have not finished.
- The sleep timer runs 15 to 90 minutes or to the end of the track, from the player bar or the tray icon. It fades out, pauses, and puts your volume back.

**Lists.**
- Shuffle all on Likes plays every like in a truly random order. SoundCloud's own queue only ever holds about 27 tracks, which is why its shuffle repeats the same few; GoLow keeps the order itself and plays each pick through SoundCloud's player while the Likes page stays open.
- Likes can be filtered, searching every like rather than only the loaded ones, and sorted by title, artist, length or when you liked them, then played in that order.
- Badges mark 30-second previews, tracks not available in your country, free downloads and tracks tagged as AI.
- Never play blocks a track or an artist from the player bar: they disappear from lists and get skipped when they come up. Settings can also skip previews, hide or skip tracks tagged as AI, and hide genres and tags you never want.
- Next to the Feed's Reposts switch, Mixes hides anything over 20 minutes and Played hides tracks you have already heard. A setting applies both to every list.
- Turning autoplay off stays off, instead of SoundCloud switching it back on each track.
- Pressing play after a restart picks up where you left off.
- The mouse wheel over the speaker icon changes volume. Keyboard media keys and the Windows media overlay work as usual.

**The window.** The title shows the playing track, so the taskbar does too. Links to other sites, such as an artist's website, open in your browser. Closing the window while music plays keeps it playing from a tray icon; closing while paused quits. Launching GoLow again brings the window back. The mini player shrinks the window to SoundCloud's control bar, and pairs well with Keep on top.

**Settings** live behind the sliders icon in SoundCloud's header, next to the ⋯ menu, or `Ctrl+,`, grouped into Interface, Playback, Mixes and podcasts, Lists and feed, and Sharing. Sharing holds Discord status, which shows what you are listening to on your Discord profile, and Scrobble to Last.fm, which signs in through your browser the first time; both are off until you switch them on. The GoLow panel, from the list icon in the player bar or `Ctrl+.`, holds the tracklist, Continue and the blocklist. Add `?noclean` to a SoundCloud URL to load one page without cleanup.

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
node --test "tests/*.test.mjs"     # page script tests, uses headless Edge
```

Discord status appears as GoLow's Discord application. A fork can use its own by creating an application at the [Discord developer portal](https://discord.com/developers/applications) and building with `GOLOW_DISCORD_APP_ID` set to its ID.

Last.fm scrobbling needs an API key and secret from [Last.fm's API page](https://www.last.fm/api/account/create), set as `GOLOW_LASTFM_KEY` and `GOLOW_LASTFM_SECRET` at build time. Without them the switch is hidden.

`uv run scripts/benchmark.py --exe old=path\to\old.exe --exe new=target\release\golow.exe --cdp` compares builds on startup, CPU and memory, using throwaway profiles under `.working\bench`. Set `GOLOW_PROFILE_DIR` to run the app against a separate profile while testing.

## License

[MIT](LICENSE). SoundCloud and Go+ are trademarks of SoundCloud.
