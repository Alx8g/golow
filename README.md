# SoundCloud Go+

A small Windows Rust wrapper around the official SoundCloud website using the shared Evergreen WebView2 runtime. It preserves SoundCloud authentication and normal DRM playback. It does not download protected streams or change subscription entitlements.

## Build and verify

Install Rust and Visual Studio C++ Build Tools, then run `scripts\build-and-test.cmd`. This runs formatting checks, Rust unit tests, Clippy and a release build.

Run the JavaScript checks with `node --test tests/cleanup-static.test.mjs`.

Browser regression checks use an isolated synthetic fixture through `cloak-browse`. The runner in `tests/cleanup_browser.py` covers promo cleanup, protected player and consent controls, dynamic updates, idle/background inactivity, restore, settings and mutation batching. It does not access a SoundCloud account.

## Behavior

- Standard WebView2 background throttling and hardware acceleration stay enabled.
- Before the first navigation, narrow native filters cancel the hidden Artist Tools frame navigation and return empty responses for two advertising resources observed in profiling. A document-response filter is also registered, but service-worker and cached responses can bypass resource interception. Live checks prove the Artist Tools frame executes zero scripts. Advertising responses were replaced with empty bodies in some runs, while a cached Reddit pixel response still appeared in another run. This is not a complete tracker blocker or a guarantee that every associated byte avoids download. Exact host/path checks preserve audio/CDN traffic, consent, OAuth, security scripts and the standby player. Cleanup and efficiency toggles control these filters. Reload applies request-filter changes to already loaded pages.
- Minimized windows request a low memory target, hide the WebView controller and disconnect cleanup work. The renderer is not suspended, so audio remains eligible to play. Visible cleanup ignores player/waveform mutations and added subtrees without matching promotions.
- Cleanup runs once on load and then only on added subtrees. It has no periodic sweep, text-tree walk, broad promo substring selector, geometry scan or automatic dismissal click. The exact Artist Tools iframe host is hidden, while the separate New Tracks module remains visible.
- App settings control cleanup, minimized memory reduction, compact mode and always-on-top. `Ctrl+,` opens settings. The audio-quality link goes to SoundCloud's own streaming settings. Selecting Go+ is not proof that high-quality playback is enabled.
- Exact parsed HTTPS hosts are checked for top-level navigation and managed login popups. Popup redirects are checked too. Native messages are limited to settings and cache status from SoundCloud's UI origin.
- Relaunching the same profile restores the existing app instead of opening another process tree.
- Window-state writes wait for 350 ms of inactivity and occur on close. Minimized and maximized geometry does not replace normal window size.
- Startup logging contains timings, not visited URLs or login tokens. DevTools are disabled in release builds.

## Install and rollback

After building, run `powershell -ExecutionPolicy Bypass -File install.ps1 -Restart`. The installer requests a graceful close, retains the previous executable under the installed app's `rollback` directory, verifies hashes, then launches the replacement. It does not delete login data or caches. If graceful close fails, it stops rather than force-killing the app.

The per-user app is installed under `%LOCALAPPDATA%\Programs\SoundCloudGoPlus`. Its profile remains at `%APPDATA%\soundcloud-go-client` to avoid migrating existing authentication or DRM state. The profile and settings are never committed.

For rollback, close the app, preserve the current executable under a new name, restore the retained executable and restart. Do not overwrite or delete a running executable. The original uninstall script removes the install folder, including rollback files, but intentionally preserves the profile.

## Development profile

`SOUNDCLOUD_PROFILE_DIR` selects a separate profile root for manual tests. Never point test automation at another user's browser profile. Production needs no debugging port. Tests and reports belong in ignored `.working/` directories.

## Scope

This app cannot control SoundCloud's server code or certify stream quality from a subscription label. Resource savings must be measured with comparable page, playback and visibility states. Keeping cache generally improves loading. Build artifacts may be cleaned separately after preserving a tested release, but are not runtime memory usage.
