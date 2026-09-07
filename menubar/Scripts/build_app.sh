#!/bin/bash
# Builds AutoRetryBar.app in the menubar/ directory.
set -euo pipefail

cd "$(dirname "$0")/.."

swift build -c release

APP="AutoRetryBar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp .build/release/AutoRetryBar "$APP/Contents/MacOS/"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AutoRetryBar</string>
    <key>CFBundleDisplayName</key>
    <string>Claude Auto-Retry</string>
    <key>CFBundleIdentifier</key>
    <string>com.moonlighter.autoretrybar</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>AutoRetryBar</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <!-- Menu-bar-only: no Dock icon, no app switcher entry. -->
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- "Attach in Terminal…" and "Tail Log…" drive Terminal.app via AppleScript; macOS
         shows this string the first time it asks for Automation permission. -->
    <key>NSAppleEventsUsageDescription</key>
    <string>Opens a Terminal window attached to a Claude tmux session.</string>
</dict>
PLIST
echo '</plist>' >> "$APP/Contents/Info.plist"

# Ad-hoc signature: a stable code identity, so macOS keeps a login item registered and
# Gatekeeper doesn't re-verify on every launch. Not a Developer ID signature — a copy
# downloaded from the internet would still be quarantined.
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1

if codesign --verify --strict "$APP" 2>/dev/null; then
    SIGNED="signed (ad-hoc)"
else
    SIGNED="UNSIGNED — codesign failed"
fi

SIZE=$(du -sh "$APP" | cut -f1)
echo "Built $APP  [$SIZE, $SIGNED]"
echo "Install it with:  cp -R $APP /Applications/"
