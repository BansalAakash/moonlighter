#!/bin/bash
# Build Moonlighter.app for one chip or both:
#   packaging/build_mac_app.sh [X.Y.Z]
# giving dist/Moonlighter-Apple-Silicon.dmg (drag to Applications) and the same app as
# dist/Moonlighter-Apple-Silicon.zip (for the one-line install, packaging/install-release.sh).
# X.Y.Z defaults to package.json's version. Apple Silicon only: there is no Intel build.
#
# The app is self-contained: the menu bar app (Swift) plus this package and its own Node, so the
# person installing it needs nothing but tmux. Node comes from nodejs.org, checked against the
# published SHA-256 sums, and is cached under build/cache.
#
# Ad-hoc signed, not notarised (that needs a paid Apple Developer account): a copy downloaded in a
# browser needs "Open Anyway" in System Settings the first time; the one-line install does not.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

NODE_VERSION="${MOONLIGHTER_NODE_VERSION:-24.14.1}"
VERSION="${1:-$(node -p "require('./package.json').version")}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Version must look like 1.0.0, not '$VERSION'." >&2; exit 1
fi
if [ "$(uname -m)" != arm64 ]; then
    echo "Moonlighter is built for Apple Silicon only; this Mac is $(uname -m)." >&2; exit 1
fi
for tool in swift curl tar hdiutil iconutil sips ditto codesign lipo shasum; do
    command -v "$tool" >/dev/null || { echo "Missing tool: $tool (install Xcode's command line tools)." >&2; exit 1; }
done
CACHE="$ROOT/build/cache"; mkdir -p "$CACHE" "$ROOT/dist"

# --- Node, verified ------------------------------------------------------------------------------
fetch_node() {   # $1 = arm64|x64 → prints the path of the extracted `node` binary
    local arch="$1" name="node-v$NODE_VERSION-darwin-$1"
    local tgz="$CACHE/$name.tar.gz" sums="$CACHE/SHASUMS256-$NODE_VERSION.txt" out="$CACHE/$name"
    if [ ! -x "$out/node" ]; then
        [ -f "$sums" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$sums"
        [ -f "$tgz" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz" -o "$tgz"
        local want got
        want="$(grep " $name.tar.gz\$" "$sums" | cut -d' ' -f1)"
        got="$(shasum -a 256 "$tgz" | cut -d' ' -f1)"
        if [ -z "$want" ] || [ "$want" != "$got" ]; then
            rm -f "$tgz"; echo "Node $NODE_VERSION ($arch) failed its checksum." >&2; exit 1
        fi
        rm -rf "$out"; mkdir -p "$out"
        tar -xzf "$tgz" -C "$out" --strip-components=2 "$name/bin/node"
    fi
    echo "$out/node"
}

CHIP=apple-silicon; ARCH=arm64; NODE_ARCH=arm64; LABEL=Apple-Silicon
{
    echo "== $LABEL ($ARCH)"
    APP="$ROOT/build/$CHIP/Moonlighter.app"
    RES="$APP/Contents/Resources"
    rm -rf "$ROOT/build/$CHIP"; mkdir -p "$APP/Contents/MacOS" "$RES/runtime" "$RES/moonlighter"

    # The Swift app, built for arm64 to match the Node that ships beside it.
    swift build -c release --arch "$ARCH" --package-path "$ROOT/menubar" --scratch-path "$ROOT/build/swift-$ARCH" >/dev/null
    BIN="$(swift build -c release --arch "$ARCH" --package-path "$ROOT/menubar" --scratch-path "$ROOT/build/swift-$ARCH" --show-bin-path)/Moonlighter"
    cp "$BIN" "$APP/Contents/MacOS/Moonlighter"
    cp "$ROOT/menubar/Resources/claude-logo.svg" "$RES/"

    # This package: only what runs (no tests, docs, or the Swift sources).
    cp -R bin src launchd package.json LICENSE "$RES/moonlighter/"
    find "$RES/moonlighter" -name ".DS_Store" -delete
    # package.json says what `files` npm would publish; the bundle needs it only for "type": "module".
    cp "$(fetch_node "$NODE_ARCH")" "$RES/runtime/node"
    chmod 755 "$RES/runtime/node" "$APP/Contents/MacOS/Moonlighter"

    # App icon: rendered by the app itself, from the same geometry as the menu bar mark.
    ICONSET="$ROOT/build/$CHIP/Moonlighter.iconset"; mkdir -p "$ICONSET"
    "$APP/Contents/MacOS/Moonlighter" --render-app-icon "$ICONSET/master.png" 1024 >/dev/null
    for sz in 16 32 128 256 512; do
        sips -z $sz $sz "$ICONSET/master.png" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
        sips -z $((sz*2)) $((sz*2)) "$ICONSET/master.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
    done
    rm "$ICONSET/master.png"
    iconutil -c icns "$ICONSET" -o "$RES/Moonlighter.icns"
    rm -rf "$ICONSET"

    cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Moonlighter</string>
    <key>CFBundleDisplayName</key><string>Moonlighter</string>
    <!-- Kept from earlier builds (when the app was AutoRetryBar) so the login item and its saved
         preferences carry over an upgrade. -->
    <key>CFBundleIdentifier</key><string>com.moonlighter.autoretrybar</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleExecutable</key><string>Moonlighter</string>
    <key>CFBundleIconFile</key><string>Moonlighter</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <!-- Menu-bar-only: no Dock icon, no app switcher entry. -->
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHumanReadableCopyright</key><string>MIT License. Fork of cheapestinference/claude-auto-retry.</string>
</dict>
</plist>
PLIST
    plutil -lint "$APP/Contents/Info.plist" >/dev/null

    # Ad-hoc sign the whole bundle (Node included) so macOS keeps one stable identity for it: the
    # login item is registered against that identity.
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1
    codesign --verify --strict "$APP"

    for f in "$APP/Contents/MacOS/Moonlighter" "$RES/runtime/node"; do
        got="$(lipo -archs "$f")"
        [ "$got" = "$ARCH" ] || { echo "$f came out as '$got', not $ARCH." >&2; exit 1; }
    done

    DMG="$ROOT/dist/Moonlighter-$LABEL.dmg"; ZIP="$ROOT/dist/Moonlighter-$LABEL.zip"
    STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
    rm -f "$DMG" "$ZIP"
    hdiutil create -volname "Moonlighter" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
    rm -rf "$STAGE"
    # ditto keeps the bundle's links and signature intact, which zip does not.
    ditto -c -k --norsrc --keepParent "$APP" "$ZIP"
    echo "Built: $APP"
    echo "       $DMG ($(du -h "$DMG" | cut -f1))"
    echo "       $ZIP ($(du -h "$ZIP" | cut -f1))"
}
