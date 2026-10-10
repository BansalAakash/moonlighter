#!/bin/bash
# Build Moonlighter and publish it as a GitHub release anyone can download:
#
#   packaging/publish_release.sh [X.Y.Z]        (defaults to package.json's version)
#
# Runs the tests, builds the app, verifies the build, and uploads
#   Moonlighter-Apple-Silicon.dmg   (drag to Applications)
#   Moonlighter-Apple-Silicon.zip   (what the one-line install downloads)
#   install.sh                      (packaging/install-release.sh, the one-line install)
# The links on the README always serve the newest release:
#   curl -fsSL https://github.com/BansalAakash/moonlighter/releases/latest/download/install.sh | bash
set -euo pipefail
REPO="BansalAakash/moonlighter"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

PKG_VERSION="$(node -p "require('./package.json').version")"
VERSION="${1:-$PKG_VERSION}"
[ "$VERSION" = "$PKG_VERSION" ] || { echo "package.json says $PKG_VERSION; bump it to $VERSION first (the build embeds it)." >&2; exit 1; }

# Only committed, pushed work goes out: a build of anything else could not be traced to a commit.
[ -z "$(git status --porcelain)" ] || { echo "Commit first: the working tree has uncommitted changes." >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Push first: HEAD is not origin/main." >&2; exit 1; }
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    echo "v$VERSION is already published. Bump the version in package.json." >&2; exit 1
fi

npm test >/dev/null
"$HERE/build_mac_app.sh" "$VERSION"
"$HERE/verify_build.sh"

cp "$HERE/install-release.sh" "$ROOT/dist/install.sh"
NOTES="$(mktemp)"
cat > "$NOTES" <<NOTES_EOF
## Install

On a Mac with Apple Silicon (macOS 13+):

\`\`\`bash
curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash
\`\`\`

Or download **Moonlighter-Apple-Silicon.dmg** below and drag the app to Applications. macOS won't open a
browser-downloaded app the first time: open it, then **System Settings → Privacy & Security → Open
Anyway**. (The one-line install skips that.)

Moonlighter needs [tmux](https://github.com/tmux/tmux); the installer adds it with Homebrew if it is
missing. Everything else, including Node, is inside the app. Re-run the line to upgrade.

See the [CHANGELOG](https://github.com/$REPO/blob/main/CHANGELOG.md) for what changed.
NOTES_EOF

gh release create "v$VERSION" \
    "$ROOT/dist/Moonlighter-Apple-Silicon.dmg" "$ROOT/dist/Moonlighter-Apple-Silicon.zip" "$ROOT/dist/install.sh" \
    --repo "$REPO" --target main --title "Moonlighter $VERSION" --notes-file "$NOTES"
rm -f "$NOTES"
echo "Published: https://github.com/$REPO/releases/tag/v$VERSION"
