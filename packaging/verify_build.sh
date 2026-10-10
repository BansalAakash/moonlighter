#!/bin/bash
# Check a built Moonlighter.app the way a user's Mac would meet it:
#   packaging/verify_build.sh
# Starts the bundle's own Node and CLI against a throwaway $HOME (nothing of the real one is
# touched, and launchd is skipped), runs the app's self-test, and opens the DMG and zip that were
# built from it. Exits non-zero on the first thing that is wrong.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"
ok()   { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*" >&2; exit 1; }

CHIP=apple-silicon; ARCH=arm64; LABEL=Apple-Silicon
{
    APP="$ROOT/build/$CHIP/Moonlighter.app"; RES="$APP/Contents/Resources"
    NODE="$RES/runtime/node"; CLI="$RES/moonlighter/bin/cli.js"
    echo "== $LABEL"
    [ -d "$APP" ] || fail "no $APP — run packaging/build_mac_app.sh first"

    codesign --verify --strict "$APP" 2>/dev/null && ok "signature is valid" || fail "signature"
    [ "$(lipo -archs "$APP/Contents/MacOS/Moonlighter")" = "$ARCH" ] && [ "$(lipo -archs "$NODE")" = "$ARCH" ] \
        && ok "app and Node are both $ARCH" || fail "architecture mismatch"
    VER="$("$NODE" --version)"; ok "bundled Node starts ($VER)"
    BUILT="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
    [ "$("$NODE" "$CLI" version)" = "$(node -p "require('./package.json').version")" ] \
        && ok "bundled CLI reports the package version (app says $BUILT)" || fail "CLI version"

    "$APP/Contents/MacOS/Moonlighter" --self-test >/dev/null && ok "app self-test passes" || fail "app self-test"

    HOME_T="$(mktemp -d)"; trap 'rm -rf "$HOME_T"' EXIT
    export HOME="$HOME_T" SHELL=/bin/zsh
    OUT="$("$NODE" "$CLI" setup --json --no-launchd)"
    echo "$OUT" | "$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(0));process.exit(r.ok?0:1)' && ok "setup succeeds in a fresh home" || fail "setup: $OUT"
    grep -q "$RES/runtime/node\" \"$RES/moonlighter/src/launcher.js" "$HOME_T/.zshrc" && ok "shell function is pinned to the bundled Node" || fail "shell function not pinned"
    [ -x "$HOME_T/.local/bin/claude-auto-retry" ] && ok "claude-auto-retry command installed" || fail "no shim"
    "$HOME_T/.local/bin/claude-auto-retry" version >/dev/null && ok "…and it runs" || fail "shim does not run"
    OUT2="$("$NODE" "$CLI" setup --json --no-launchd)"
    echo "$OUT2" | "$NODE" -e 'const r=JSON.parse(require("fs").readFileSync(0));process.exit(r.steps.every(s=>s.changed===false||s.changed===undefined)?0:1)' \
        && ok "a second setup changes nothing" || fail "setup is not idempotent: $OUT2"
    "$NODE" "$CLI" uninstall --all --no-launchd >/dev/null 2>&1; ! grep -q "claude-auto-retry" "$HOME_T/.zshrc" 2>/dev/null \
        && [ ! -e "$HOME_T/.local/bin/claude-auto-retry" ] && ok "uninstall --all removes it again" || fail "uninstall --all"

    ZIP_T="$(mktemp -d)"; ditto -x -k "$ROOT/dist/Moonlighter-$LABEL.zip" "$ZIP_T"
    codesign --verify --strict "$ZIP_T/Moonlighter.app" 2>/dev/null && ok "the zip unpacks to a valid app" || fail "zip"
    rm -rf "$ZIP_T"
    MNT="$(mktemp -d)"
    hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$ROOT/dist/Moonlighter-$LABEL.dmg"
    [ -d "$MNT/Moonlighter.app" ] && [ -L "$MNT/Applications" ] && ok "the DMG holds the app and an Applications link" || { hdiutil detach -quiet "$MNT"; fail "DMG"; }
    hdiutil detach -quiet "$MNT"; rmdir "$MNT" 2>/dev/null || true
}
echo "All checks passed."
