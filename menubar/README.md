# AutoRetryBar

A macOS menu bar agent for [claude-auto-retry](../README.md): see what every monitored Claude
Code session is doing, and act on it, without attaching to a single tmux pane.

```
✳ 2          two sessions monitored, both idle
✳ 3h12m      one is waiting out a usage limit; that is the soonest reset
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

The menu is four lines. Anything that would always be switched on is not a choice:

```
✓ Custom printer utility application — running    ← resume this one after a limit?
    Custom prompt                                 ← ticked once you actually edit it
✓ Claude-auto-retry review — resumes in 3h12m
    Custom prompt
  Scratch experiment — auto-resume off
───────────────────────────────
06:21  Sent retry message (attempt 1)   ← last thing that happened to your work;
                                           absent on a quiet day. Click for the log
Edit Continuation Prompt…               ← hold ⌥ to swap this for "Fix Monitoring"
───────────────────────────────
✓ Open at Login
Quit
```

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

**Hold ⌥ to reveal "Fix Monitoring"** — restarts every monitor. That is also how an edit to
the package's JavaScript takes effect, since monitors load their code at start.

Anything beyond this is a CLI job: `claude-auto-retry reconcile`, `exclude-self`, `logs`.
Actions here shell out to that same CLI rather than reimplementing it, so `reconcile`'s
single-instance lock and pane→claude mapping stay the single source of truth.

## Build

```bash
./Scripts/build_app.sh          # → AutoRetryBar.app (ad-hoc signed)
cp -R AutoRetryBar.app /Applications/
open /Applications/AutoRetryBar.app
```

Requires macOS 13+ and a Swift toolchain. `LSUIElement` — no Dock icon.

## Debugging

```bash
/Applications/AutoRetryBar.app/Contents/MacOS/AutoRetryBar --dump
```

```bash
/Applications/AutoRetryBar.app/Contents/MacOS/AutoRetryBar --login-item on|off
```

The first prints everything the menu would show and exits. There is no window, so without this an empty
menu could equally mean "no sessions" or "the status directory moved". Run it from inside the
`.app` — the login-item check reports `not found` for a bare binary, which is a bundle-context
artefact rather than a real problem. The second is the Open at Login toggle without the menu
— the interesting property of that switch is what happens on the *next* launch, which a
GUI-only control cannot be checked for in a script.

## Two things worth knowing

- **PATH.** A GUI app inherits launchd's PATH, not your shell's, so Homebrew's `tmux` and an
  fnm/nvm-managed `node` are invisible to it. The status poll calls absolute paths; the menu
  *actions* run through `zsh -lc` so they resolve `claude-auto-retry` exactly as your terminal
  would. Actions are rare and user-initiated; the poll is neither.
- **Automation permission.** "Attach in Terminal…" and "Tail Log…" drive Terminal.app via
  AppleScript, so macOS asks once. Declining just means those two items do nothing.

## Icon

Drawn in code (`Icon.swift`), not shipped as an asset. It is a radiating burst — the same
visual family as Claude's mark, deliberately not the same drawing: a symmetric eight-spoke
star with long axis spokes, short diagonals and an open centre, versus Claude's uneven fan of
tapered spokes. Recognisable in a crowded menu bar without passing itself off as a
first-party app.
