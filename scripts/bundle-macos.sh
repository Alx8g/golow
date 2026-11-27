#!/bin/sh
# Builds GoLow.app and installs it to ~/Applications (or the directory given as $1).
set -e
cd "$(dirname "$0")/.."
DEST="${1:-$HOME/Applications}"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
cargo build --release
APP="$DEST/GoLow.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/golow "$APP/Contents/MacOS/GoLow"

ICONSET=$(mktemp -d)/GoLow.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size assets/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) assets/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/GoLow.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>GoLow</string>
  <key>CFBundleDisplayName</key><string>GoLow</string>
  <key>CFBundleIdentifier</key><string>com.alx8g.golow</string>
  <key>CFBundleExecutable</key><string>GoLow</string>
  <key>CFBundleIconFile</key><string>GoLow</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# An ad-hoc signature is enough for a local build; Gatekeeper only checks downloaded apps.
codesign --force --deep --sign - "$APP"
echo "Installed $APP"
