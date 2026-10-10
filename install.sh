#!/usr/bin/env bash
# Moonlighter — install from a source checkout.
#
#   macOS: builds the same Moonlighter.app a release contains and installs it
#          (needs Xcode's command line tools; downloads Node once, checksum-verified).
#   Linux: links the CLI and installs the shell function (no menu bar app on Linux).
#
# Most people want the one-line install instead — see the README. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")"
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ "$(uname -s)" = Darwin ]; then
    [ "$(uname -m)" = arm64 ] || die "The Moonlighter app is built for Apple Silicon only (this Mac is $(uname -m))."
    command -v swift >/dev/null || die "Swift not found. Install Xcode's command line tools: xcode-select --install"
    command -v node  >/dev/null || die "node not found (needed to read the package version). Install Node 18+ and re-run."
    say "Moonlighter — building"
    ./packaging/build_mac_app.sh
    MOONLIGHTER_ZIP="$PWD/dist/Moonlighter-Apple-Silicon.zip" ./packaging/install-release.sh
    exit 0
fi

# --- Linux: CLI only ---------------------------------------------------------------------------------
command -v node >/dev/null || die "node not found. Install Node 18+ and re-run."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || die "Node 18+ required (found $(node -v))."
say "Moonlighter — installing (CLI only)"
npm link >/dev/null
claude-auto-retry install
claude-auto-retry install-timer >/dev/null 2>&1 || warn "Could not install the repair timer (run \`claude-auto-retry install-timer\` to see why)."
say "Done."
echo "Open a new terminal (or: source ~/.zshrc), then use \`claude\` as you always do."
