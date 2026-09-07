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
say "1/3  Linking the CLI"
npm link >/dev/null
echo "  claude-auto-retry -> $(pwd)"

echo
say "2/3  Installing the shell wrapper"
# Checks/installs tmux, then adds a `claude` shell function to ~/.zshrc / ~/.bashrc
# that launches Claude Code inside a tmux pane the monitor can watch.
claude-auto-retry install

# --- the menu bar app (macOS only) -------------------------------------------

echo
if [ "$(uname -s)" != "Darwin" ]; then
    say "3/3  Menu bar app — skipped (macOS only)"
    echo "  The CLI works on Linux; the status bar app does not."
elif ! command -v swift >/dev/null; then
    say "3/3  Menu bar app — skipped"
    warn "  Swift not found. Install Xcode Command Line Tools and re-run:"
    warn "      xcode-select --install"
else
    say "3/3  Building the menu bar app"
    ./menubar/Scripts/build_app.sh
    # Quit a running copy first: cp -R over a live bundle leaves a mangled app.
    pkill -x AutoRetryBar 2>/dev/null || true
    sleep 1
    rm -rf /Applications/AutoRetryBar.app
    cp -R menubar/AutoRetryBar.app /Applications/
    open -a /Applications/AutoRetryBar.app
    echo "  Installed to /Applications and launched."
    echo "  It installs its own 5-minute repair timer and asks to open at login."
fi

echo
say "Done."
echo "Open a new terminal (or: source ~/.zshrc), then use \`claude\` as you always do."
