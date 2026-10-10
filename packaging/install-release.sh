#!/bin/bash
# Install Moonlighter. One line, no account, no Homebrew needed for the app itself:
#
#   curl -fsSL https://github.com/BansalAakash/moonlighter/releases/latest/download/install.sh | bash
#
# Downloads the newest release, puts Moonlighter.app in /Applications, wires it in (the `claude`
# shell function, the 5-minute repair timer, the menu bar watchdog) and opens it. Safe to re-run:
# that is also how to upgrade. Installing through this script skips the "Open Anyway" step a
# browser-downloaded copy needs, because nothing here is quarantined.
#
# For testing or an offline install: MOONLIGHTER_ZIP=/path/to/Moonlighter-Apple-Silicon.zip
set -euo pipefail

REPO="BansalAakash/moonlighter"
APP="/Applications/Moonlighter.app"
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "The Moonlighter app is for macOS. On Linux, install from source (see the README)."
[ "$(uname -m)" = arm64 ] || die "Moonlighter is built for Apple Silicon Macs only (this Mac is $(uname -m))."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || die "Moonlighter needs macOS 13 or newer."

say "Moonlighter — installing"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# --- get the app ----------------------------------------------------------------------------------
if [ -n "${MOONLIGHTER_ZIP:-}" ]; then
    [ -f "$MOONLIGHTER_ZIP" ] || die "No such file: $MOONLIGHTER_ZIP"
    ZIP="$MOONLIGHTER_ZIP"
else
    echo "  Downloading the latest release…"
    ZIP="$TMP/Moonlighter.zip"
    curl -fSL --progress-bar "https://github.com/$REPO/releases/latest/download/Moonlighter-Apple-Silicon.zip" -o "$ZIP" \
        || die "Could not download Moonlighter. Check your connection, or get it from https://github.com/$REPO/releases"
fi
ditto -x -k "$ZIP" "$TMP/unpacked"
[ -d "$TMP/unpacked/Moonlighter.app" ] || die "That download does not contain Moonlighter.app."

# --- replace what is there --------------------------------------------------------------------------
echo "  Stopping the running copy, if any…"
pkill -x Moonlighter 2>/dev/null || true
pkill -x AutoRetryBar 2>/dev/null || true       # the name this app had before it was packaged
# The old watchdog relaunches a missing AutoRetryBar.app forever, so it goes before the app does.
launchctl bootout "gui/$(id -u)/com.moonlighter.autoretrybar.watchdog" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.moonlighter.autoretrybar.watchdog.plist"
rm -rf /Applications/AutoRetryBar.app
sleep 1

rm -rf "$APP"
ditto "$TMP/unpacked/Moonlighter.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "  Installed $APP"

NODE="$APP/Contents/Resources/runtime/node"
CLI="$APP/Contents/Resources/moonlighter/bin/cli.js"

# --- tmux: the one thing Moonlighter needs that it cannot ship ---------------------------------------
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v tmux >/dev/null; then
    if command -v brew >/dev/null; then
        say "Installing tmux with Homebrew (about a minute)"
        HOMEBREW_NO_AUTO_UPDATE=1 brew install tmux || warn "  tmux did not install. Run: brew install tmux"
    else
        warn "  tmux is not installed. Install Homebrew from https://brew.sh, then run: brew install tmux"
    fi
fi

# --- wire it in ---------------------------------------------------------------------------------------
echo
say "Setting up"
"$NODE" "$CLI" setup || warn "  Some of setup did not complete — see above. Moonlighter will retry each time it opens."

# Monitors started by an older install run old code from an old path; restart them so every watched
# session is on this version. The repair timer's job re-arms them (a session that was mid-wait
# re-detects its banner and carries on).
if pgrep -f 'src/monitor.js' >/dev/null; then
    pkill -TERM -f 'src/monitor.js' || true
    sleep 2
fi
launchctl kickstart -k "gui/$(id -u)/com.claude-auto-retry.reconcile" 2>/dev/null || true
# Do not trust that one kick: the job can lose a race with the monitors that were just stopped (it did,
# once, leaving an active session unwatched). Reconcile is idempotent and takes a lock, so running it
# directly as well costs nothing, and it is checked below rather than assumed.
sleep 3
for attempt in 1 2 3; do
    "$NODE" "$CLI" reconcile >/dev/null 2>&1 || true
    sleep 2
    # Every claude session in tmux that is not deliberately switched off should now have a monitor.
    if ! "$NODE" "$CLI" reconcile --dry-run 2>/dev/null | grep -q "Would arm"; then break; fi
done

open "$APP"

echo
say "Done."
echo "Moonlighter is in your menu bar. Open a NEW terminal and use \`claude\` as you always do —"
echo "sessions started that way are watched, and resumed after a usage limit resets."
echo "To remove it: claude-auto-retry uninstall --all, then drag Moonlighter.app to the Trash."
