# Moonlighter.app (the menu bar app)

A macOS menu bar agent for [claude-auto-retry](../README.md): see what every monitored Claude
Code session is doing, and act on it, without attaching to a single tmux pane.

```
✳ 2          two sessions monitored, both idle
✳ 3h12m      one is waiting out a usage limit; that is the soonest reset
✳ 3d4h       ...a weekly limit: waits past two days read in days
✳ …          a session is compacting or backing off
✳ 1  (red)   a monitor gave up — it needs you
✳ (dimmed)   nothing is being monitored
```

## How it reads state

It does not talk to the monitor processes. `src/status-file.js` already writes one JSON
snapshot per pane on every tick — atomically, and with `pollIntervalSeconds` embedded so a
reader can derive its own staleness threshold — precisely so external readers can exist.
`bin/tmux-status.sh` is the shell reader; this is the GUI one. The app polls that directory
every 5 seconds and cross-references live `tmux` and `pgrep` state for session names and pids.

A snapshot is treated as live purely on **freshness** (three missed ticks = stale), not on
finding a matching process: only a running monitor writes the file, so a recent timestamp is
first-hand evidence, while a `pgrep` match is a second-hand signal that can go missing for
reasons unrelated to the monitor. The pid is needed to *act* on a monitor, not to believe in it.

## What it can do

The menu is a handful of lines, and deliberately shows no log: the app is meant to run on its own, and an event nobody can act on is noise. The one thing that does stand out is a session marked `stuck — needs you` (red). Anything that would always be switched on is not a choice:

```
☑ Custom printer utility application — resumes in 3h12m   ← one checkbox per session
☑ Claude-auto-retry review
☐ Scratch experiment
  Pause All Sessions                  ← or "Resume All Sessions" when any is off
  Session Prompts                  ▸  ← each session's own resume prompt
───────────────────────────────
Edit Shared Prompt…                   ← hold ⌥ to swap this for "Fix Monitoring"
───────────────────────────────
✓ Open at Login
Quit
```

**The checkboxes don't close the menu.** Each session row is a real checkbox (a view-backed menu
item, which AppKit does not dismiss on click), so several sessions can be switched on or off in
a row. While the menu is open the rows update in place instead of being replaced. "Resume All /
Pause All" does the lot in one click: if any session is off it switches everything on, otherwise
it switches everything off. "Session Prompts" lists each session with a Claude process, ticked
once its prompt really differs from the shared one, with a way back to the shared prompt.

The session line is the whole status display: `running`, `resumes in 3h12m`,
`compacting, then resuming`, `API busy — retrying`, or `stuck — needs you` (red). Sessions
whose tmux pane no longer exists are not listed at all — a leftover status file is not news.

**The checkbox is the per-session setting, and there is only one.** Unticking it runs
`exclude-self` for that pane, which records the session by claude PID — the self-expiring
form, so the entry dies with the session and can never mute a later one that inherits the
pid — and stops its monitor. That is what the 5-minute reconcile consults, so OFF sticks
instead of lasting until the next timer fire. Ticking it removes the entry and reconciles.
The app keeps no preference store of its own; the exclude file *is* the setting, which is why
the CLI and the timer honour it too.

A session that is off has no monitor and therefore no status file, so the menu falls back to
`reconcile --dry-run` to find it — otherwise switching one off would make it vanish with no
way to switch it back.

**The reconcile timer is not a setting.** It is a launchd job that re-arms a dead monitor
every 5 minutes; a monitor that stays dead after it crashes is nobody's idea of a preference,
so the app just keeps it installed.

**Open at Login is** a setting, and stays a toggle. It defaults to on — unattended overnight
coverage is the point — but it is only ever set automatically on the very first run. "Enable
it if it isn't enabled" would run on every launch and silently undo you turning it off, so
the toggle would appear to work and then revert by morning.

Sessions are named from the tmux **pane title**, which Claude Code sets to a description of
the work ("✳ Claude-auto-retry review"). Session names are minted as
`claude-retry-<pid>-<timestamp>` and say nothing; the working directory is no better, since
several sessions commonly share one. Falls back to the directory, then the pane id.

**"Custom prompt"** ticks only once that session's prompt actually DIFFERS from the shared
one. The file is seeded with the shared text so there is something to edit, which otherwise
meant a session read as customised the instant you opened the editor — and worse, that seeded
copy was a snapshot, so later edits to the shared prompt would silently never reach a session
that had never really been customised. Unedited copies are deleted whenever the menu is drawn,
so the behaviour matches the label. Clicking it opens a plain
text file in Sublime Text (falling back to your default editor if Sublime isn't installed),
seeded with the shared prompt so you edit rather than start blank. Emptying the file removes
the override. Write it wrapped across lines if you like — the daemon collapses it to one line
before sending, because a raw newline would submit the message early.

That line started out hidden behind ⌥, to keep the menu at one line per session. That was the
wrong call: a per-session prompt is no use if nothing tells you it exists. It earns its line
by reporting state, not just offering an action — which prompt a session gets is not visible
anywhere else.

**Hold ⌥ to reveal "Fix Monitoring"** — restarts every monitor. That is how an edit to the
package's JavaScript takes effect, since monitors load their code at start. (Edits to
`~/.claude-auto-retry.json` do *not* need it: monitors re-read that file while running.)

Anything beyond this is a CLI job: `claude-auto-retry reconcile`, `exclude-self`, `logs`.
Actions here shell out to that same CLI rather than reimplementing it, so `reconcile`'s
single-instance lock and pane→claude mapping stay the single source of truth.

## Build

```bash
./packaging/build_mac_app.sh        # from the repo root → dist/Moonlighter-Apple-Silicon.{dmg,zip}
./packaging/verify_build.sh         # starts the built app's Node and CLI against a throwaway $HOME
```

Requires macOS 13+ on Apple Silicon and a Swift toolchain. The app is self-contained: this Swift
menu bar app, the `claude-auto-retry` package, and its own Node (downloaded from nodejs.org and
checked against the published checksums). `LSUIElement` — no Dock icon. See
[`packaging/`](../packaging) for the release flow.

## Debugging

```bash
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --dump
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --login-item on|off
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --auto-resume %1 on|off
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --self-test
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --render-icon out.png [scale]
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --render-app-icon out.png [px]
/Applications/Moonlighter.app/Contents/MacOS/Moonlighter --setup
```

`--dump` prints everything the menu would show and exits. There is no window, so without this
an empty menu could equally mean "no sessions" or "the status directory moved". Run it from
inside the `.app` — the login-item check reports `not found` for a bare binary, which is a
bundle-context artefact rather than a real problem. `--login-item` and `--auto-resume` are the
two toggles without the menu: the interesting property of each is what happens *afterwards*,
which a GUI-only control cannot be checked for in a script.

`--self-test` runs the app's built-in checks (shell timeouts, countdown text, the snapshot
contract, parsing tmux's pane list with no locale) and exits non-zero on failure — the package
has no XCTest target, so this is its test suite. `--render-icon` draws the menu bar mark to a PNG
so a 16pt glyph can actually be looked at.

## Things worth knowing

- **PATH.** A GUI app inherits launchd's PATH, not your shell's, so Homebrew's `tmux` and an
  fnm/nvm-managed `node` are invisible to it. The status poll calls absolute paths; the menu
  *actions* run through `zsh -lc` so they resolve `claude-auto-retry` exactly as your terminal
  would. Actions are rare and user-initiated; the poll is neither.
- **Locale.** A GUI app also inherits no `LANG`/`LC_*`, and a tmux client in that state
  rewrites every tab and non-ASCII character in `-F` output to `_` (seen on tmux 3.7c) — which
  made the pane list unparseable and the menu empty. The app runs tmux with `-u`, which forces
  UTF-8 regardless of the environment.
- **Nothing blocks the menu bar.** Status loads and repair actions run off the main thread,
  and every child process has an enforced timeout. A hung `tmux` or a slow login shell shows
  up as a slightly stale menu, not a frozen one. The app writes a heartbeat from the main
  thread on every tick; the watchdog LaunchAgent restarts the app if it stops moving.
- **One tmux server.** Sessions are listed from the default tmux server. Panes on a server
  started with `tmux -L <name>` are not visible to the app (the monitors themselves handle
  them fine).

## Icon

The mark is Claude's spark (`Resources/claude-logo.svg`, bundled by `build_app.sh`) with a small
crescent moon in its lower-right corner. The moon is drawn in code (`Icon.swift`) over a knockout
halo cut from the spark, so it stays legible at 16pt and carries through all three states —
template (follows the menu bar's light/dark/highlighted tint), dimmed, and red for "needs you".
It exists because the spark on its own is identical to Claude's own menu bar icon, which made
the two impossible to tell apart at a glance. Run `--render-icon` to see it at any size.

`claude-logo.svg` is Anthropic's artwork, used as-is; it is not covered by this repository's MIT
license. To ship a mark of your own, replace that file — the moon badge is independent of it.
