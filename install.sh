#!/usr/bin/env bash
# Moonlighter — one-command setup.
#
# Safe to re-run: every step is idempotent. Run it again after changing Node
# versions (nvm/fnm move the global prefix, which strands the shell wrapper).
set -euo pipefail

cd "$(dirname "$0")"
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "Moonlighter — installing"
echo

# --- prerequisites -----------------------------------------------------------

command -v node >/dev/null || die "node not found. Install Node 18+ and re-run."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $(node -v))."
echo "  node $(node -v)"

if ! command -v tmux >/dev/null; then
    warn "  tmux not found — the next step will try to install it."
else
    echo "  tmux $(tmux -V | awk '{print $2}')"
fi

# --- the CLI and the shell wrapper -------------------------------------------

echo
say "1/4  Linking the CLI"
npm link >/dev/null
echo "  claude-auto-retry -> $(pwd)"

echo
say "2/4  Installing the shell wrapper"
# Checks/installs tmux, then adds a `claude` shell function (~/.zshrc / ~/.bashrc, or fish's
# functions/claude.fish) that launches Claude Code inside a tmux pane the monitor can watch.
claude-auto-retry install

# --- the repair timer ----------------------------------------------------------

echo
say "3/4  Installing the repair timer"
# Re-arms a monitor within 5 minutes of it dying. Idempotent. The macOS menu bar app keeps this
# installed too, but it is not the only way in: Linux has no menu bar app, and a Mac without
# Swift skips it — both used to be left without self-healing. Failure here (no systemd --user
# session, say) must not abort the rest of the install.
if claude-auto-retry install-timer >/dev/null 2>&1; then
    echo "  Installed: a dead monitor is re-armed within 5 minutes."
else
    warn "  Could not install the timer (run \`claude-auto-retry install-timer\` to see why)."
    warn "  Monitors still work; one that dies stays dead until \`claude-auto-retry reconcile\`."
fi

# --- the menu bar app (macOS only) -------------------------------------------

echo
if [ "$(uname -s)" != "Darwin" ]; then
    say "4/4  Menu bar app — skipped (macOS only)"
    echo "  The CLI works on Linux; the status bar app does not."
elif ! command -v swift >/dev/null; then
    say "4/4  Menu bar app — skipped"
    warn "  Swift not found. Install Xcode Command Line Tools and re-run:"
    warn "      xcode-select --install"
else
    say "4/4  Building the menu bar app"
    ./menubar/Scripts/build_app.sh
    # Quit a running copy first: cp -R over a live bundle leaves a mangled app.
    pkill -x AutoRetryBar 2>/dev/null || true
    sleep 1
    rm -rf /Applications/AutoRetryBar.app
    cp -R menubar/AutoRetryBar.app /Applications/
    open -a /Applications/AutoRetryBar.app
    echo "  Installed to /Applications and launched."
    echo "  It keeps the repair timer installed and asks to open at login."

    # Watchdog: relaunches AutoRetryBar if it's not running, and force-restarts it if it's
    # running but its heartbeat has stopped (stuck, not crashed — a plain pgrep or launchd
    # KeepAlive can't see that). A LaunchAgent rather than a login item so it comes back after
    # a reboot on its own, independent of macOS's Login Items list.
    WATCHDOG_SCRIPT="$(pwd)/menubar/Scripts/watchdog.sh"
    WATCHDOG_PLIST="$HOME/Library/LaunchAgents/com.moonlighter.autoretrybar.watchdog.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    sed "s#__SCRIPT_PATH__#${WATCHDOG_SCRIPT}#" \
        menubar/launchd/com.moonlighter.autoretrybar.watchdog.plist > "$WATCHDOG_PLIST"
    launchctl bootout "gui/$(id -u)/com.moonlighter.autoretrybar.watchdog" 2>/dev/null || true
    if launchctl bootstrap "gui/$(id -u)" "$WATCHDOG_PLIST" 2>/dev/null; then
        echo "  Watchdog installed: checks every 60s that the menu bar app is actually alive."
    else
        warn "  Watchdog plist written but failed to load. Load manually:"
        warn "      launchctl bootstrap gui/$(id -u) $WATCHDOG_PLIST"
    fi
fi

# --- sleep check --------------------------------------------------------------
#
# The single most common reason an overnight run does nothing: the Mac was asleep.
# Reported rather than changed — power settings belong to the user, not an installer.

if [ "$(uname -s)" = "Darwin" ]; then
    echo
    say "Checking sleep settings"
    SLEEP_MIN=$(pmset -g custom 2>/dev/null | awk '/^ sleep /{print $2; exit}')
    if [ -n "${SLEEP_MIN:-}" ] && [ "$SLEEP_MIN" != "0" ]; then
        warn "  This Mac sleeps after ${SLEEP_MIN} minutes idle — usually long before a limit resets."
        warn "  To keep it awake while a session runs, add to your ~/.zshrc:"
        warn "      export CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER=\"caffeinate -i\""
        warn "  Also: stay on the charger, and leave the lid open (closing it sleeps"
        warn "  Apple Silicon laptops regardless of caffeinate)."
    else
        echo "  Idle sleep is off. Good."
    fi
fi

echo
say "Done."
echo "Open a new terminal (or: source ~/.zshrc), then use \`claude\` as you always do."
echo "Overnight runs: see \"Leaving it running overnight\" in the README."
