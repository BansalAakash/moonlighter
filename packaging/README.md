# Packaging

How Moonlighter becomes an installable Mac app.

```
packaging/build_mac_app.sh [X.Y.Z]     build → dist/Moonlighter-Apple-Silicon.{dmg,zip}
packaging/verify_build.sh              start the built app's own Node + CLI against a throwaway $HOME
packaging/publish_release.sh [X.Y.Z]   tests, build, verify, then a GitHub release
packaging/install-release.sh           the one-line installer (uploaded to each release as install.sh)
```

**What is in the app.** `Moonlighter.app/Contents/MacOS/Moonlighter` (the Swift menu bar app),
`Resources/runtime/node` (Node from nodejs.org, checked against the published SHA-256 sums, cached under
`build/cache`) and `Resources/moonlighter/` (this package: `bin/`, `src/`, `launchd/`). Apple Silicon only.

**First run.** The app runs `claude-auto-retry setup` on every launch (`src/setup.js`): the `claude` shell
function pinned to the bundled Node, a `claude-auto-retry` command in `~/.local/bin`, the repair timer and
the watchdog. It is idempotent — "unchanged" means nothing was touched. `claude-auto-retry uninstall --all`
reverses it.

**Signing.** Ad-hoc signed, not notarised (that needs a paid Apple Developer account). A copy downloaded in a
browser is quarantined, so macOS asks for **Open Anyway** once; the one-line install strips the quarantine
flag and does not.

**Releasing.** Bump `version` in `package.json`, commit and push to `main`, run `publish_release.sh`. The
README's links point at `releases/latest`, so they follow the newest release.
