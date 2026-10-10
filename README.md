# Moonlighter

**Claude Code stops when you're not there. This keeps it going.**

## Quick start (Mac with Apple Silicon, macOS 13+)

1. Open the **Terminal** app and paste this, then press Enter:
   ```bash
   curl -fsSL https://github.com/BansalAakash/moonlighter/releases/latest/download/install.sh | bash
   ```
2. Wait about a minute. It installs Moonlighter into Applications and opens it (and installs
   [tmux](https://github.com/tmux/tmux) with Homebrew if you don't have it).
3. Open a **new** Terminal window and run Claude Code by typing `claude`, as you always do.

That's it. A spark-and-moon icon appears in your menu bar; click it to see your sessions, each with a
checkbox for automatic resume. Sessions started with `claude` in Terminal are watched — sessions in the
Claude Code desktop app are not. Details, the DMG option and removal are under [Install](#install) below.

---

You give Claude Code a long job and go to bed. An hour later it hits your usage limit
and stops:

```
You've hit your session limit · resets 11:50am (Asia/Calcutta)
```

It will sit at that prompt until you come back and type "continue" — and even if you
automate that, it will hit the *context* limit next and park at
`Context limit reached · /compact or /clear to continue`, which needs a different fix.

Moonlighter watches your sessions and handles both. You wake up to finished work
instead of a paused prompt.

| When this happens | Moonlighter does this |
|---|---|
| **Usage limit** — "resets 11:50am" | Reads the reset time, waits it out, then sends your continuation prompt. |
| **Context limit** — window is full | Sends `/compact`, **waits for compaction to actually finish**, then sends your prompt. |
| **API overload** — 529 / 500 / 503 | Retries with exponential backoff. |
| **Weekly limit** — "resets Oct 12, 2am" | Reads the *date* as well as the time, so it waits days, not hours. |
| **A monitor dies** | A repair timer notices within 5 minutes and re-arms it. |

Everything runs on your machine. No account, no network calls, no dependencies.

---

## Install

**On a Mac with Apple Silicon (macOS 13+), one line:**

```bash
curl -fsSL https://github.com/BansalAakash/moonlighter/releases/latest/download/install.sh | bash
```

That puts **Moonlighter.app** in your Applications folder and opens it. It brings its own copy of
everything it runs (including Node), so the only thing it needs from you is
[tmux](https://github.com/tmux/tmux) — if you don't have it, the installer runs `brew install tmux`
(or, if you open the app first, it offers to). Then open a **new** terminal and use `claude`
exactly as you always do. That's the whole setup, and running the line again is how you upgrade.

Prefer a disk image? Download **Moonlighter-Apple-Silicon.dmg** from the
[latest release](https://github.com/BansalAakash/moonlighter/releases/latest) and drag the app to
Applications. macOS will not open an app downloaded in a browser the first time: open it, then go to
**System Settings → Privacy & Security** and choose **Open Anyway**. (The one-line install skips this.)

On first launch the app wires itself in: the `claude` shell function (in `~/.zshrc` / `~/.bashrc`, or
`~/.config/fish/functions/claude.fish`), a `claude-auto-retry` command, the 5-minute repair timer and
a watchdog that restarts the menu bar app if it ever sticks. All of it is undone with
`claude-auto-retry uninstall --all` (then drag the app to the Trash); your settings and history
are left alone.

**Linux, or building it yourself** (the CLI works on both; the menu bar app is macOS only):

```bash
git clone https://github.com/BansalAakash/moonlighter.git
cd moonlighter
./install.sh        # macOS: builds the same app a release contains (needs Xcode's command line tools)
                    # Linux: needs Node 18+ and tmux; installs the CLI only
```

You also need **Claude Code**, of course.

## Using it

**Type `claude` exactly as you always have.** The shell function launches it inside a
tmux pane so a monitor can watch it, then gets out of the way. Nothing else changes.

To check on things:

```bash
claude-auto-retry status     # what's being watched, and what each session is doing
claude-auto-retry logs       # what has happened today
```

To stop using it, `claude-auto-retry uninstall` removes the shell function.

### Optional: event-driven overload detection

By default, API-overload errors (529/500/503) are spotted by reading the terminal. For an exact,
scrape-free trigger, install Claude Code's `StopFailure` hook (it edits
`~/.claude/settings.json`, which is why the installer doesn't do it for you):

```bash
claude-auto-retry install-hook     # remove with: claude-auto-retry uninstall-hook
```

## Leaving it running overnight

The tool can only resume a session on a machine that is **awake**. This is the part that
catches people out, so it is worth two minutes.

**Keep the Mac awake.** Add this to your `~/.zshrc` — every session then holds the machine
awake for as long as it runs, and stops holding it the moment it exits:

```bash
export CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER="caffeinate -i"
```

Check what your Mac would otherwise do:

```bash
pmset -g custom | grep -w sleep      # minutes of idle before it sleeps; 0 means never
```

A default MacBook sleeps after 15 minutes idle **even on the charger**, which is long
before a limit resets.

**Also worth doing:**

- **Plug in the charger.** On battery, macOS sleeps more aggressively, and Low Power Mode
  throttles background work.
- **Leave the lid open.** On Apple Silicon laptops, closing the lid sleeps the machine even
  on power, and `caffeinate` will *not* prevent it — it only blocks *idle* sleep. The one
  exception is clamshell mode with an external display connected.
- **Stay on a network that doesn't drop.** Claude Code needs it; the monitor doesn't.

**You do *not* need to keep the terminal window open.** Sessions run inside tmux, detached
from whatever launched them. Close the window, lock the screen, log out of the terminal app
— the work continues. Reattach later with `claude-auto-retry status` to find the session.

**And if it does sleep anyway, nothing is lost.** The wait is a wall-clock deadline, not a
countdown, so a sleeping Mac just delays the retry until it wakes. You get the work done
late rather than not at all.

### When nothing happens

| What you see | Why | Fix |
|---|---|---|
| `status` lists no sessions | Claude wasn't launched through the wrapper — you ran `command claude`, set `CLAUDE_AUTO_RETRY_NO_TMUX=1` outside tmux, or an app started the `claude` binary directly | Launch with `claude` from a normal shell, or run `claude-auto-retry reconcile` to attach monitors to sessions already running in tmux |
| A session shows "not being watched" | Its monitor stopped (killed, or the machine crashed) | `claude-auto-retry reconcile`; the repair timer also does this within 5 minutes |
| Worked yesterday, not today (source / Linux install) | You switched Node versions. The shell wrapper and the repair timer pin an absolute Node path | Re-run `./install.sh`. (The app install is unaffected: it carries its own Node.) |
| One session is skipped, others work | Its auto-resume checkmark is off in the menu bar app | Click it back on |
| Claude is stopped but never resumes | It's waiting on a **permission prompt**, not a limit. No retry message can clear that | Run unattended sessions in a mode that doesn't stop to ask |
| Everything vanished | The Mac rebooted — a macOS update, or a crash. tmux sessions do not survive a reboot, and with FileVault on, nothing runs at all until someone logs in | Nothing to recover; the menu bar app returns at login |
| Waiting for days, not hours | You hit a **weekly** cap rather than the 5-hour one | Expected — it waits for the date printed in the banner. `status` and the menu bar show the countdown in days |
| Your config edits seem ignored | `~/.claude-auto-retry.json` isn't valid JSON (a stray quote in a prompt is enough). The previous settings stay in force and the log says why | `claude-auto-retry logs` — look for "is not valid JSON" |

## The menu bar app <sub>(macOS)</sub>

A small icon in your status bar (Claude's spark with a little crescent moon, so it isn't
mistaken for Claude's own), so you never have to wonder whether the thing is working. It shows a countdown while a session is waiting out a limit, and turns red if
one needs you.

With `sessionResetCheck.enabled` on (see below), the countdown doesn't disappear the rest
of the time either. The reset time turns out to be account-wide rather than per-session, so
rather than opening `/status` inside a pane you're actually using, a monitor occasionally
spins up its own invisible, disposable session, reads the same boundary off *that* — along
with the usage percentage and the weekly figures — and tears it down: your real panes are
never sent a keystroke, and `/status` never calls the model, so this costs no usage/tokens
either. Off by default anyway, since it does still launch a real (very short-lived) `claude`
process on a timer.

The per-session percentage shows up in the menu ("34% used · resets in 4h29m"); both the
5-hour and weekly figures are appended to `~/.claude-auto-retry/usage_log.txt` on every
fresh check, one line per check, if you want a plain-text history of them.

Clicking it gives you the whole app in a few lines (there is no log in the menu — it is meant to run on its own; `claude-auto-retry logs` has the history if you ever want it):

```
✓ Custom printer utility application — running
      Custom prompt
✓ Claude-auto-retry review — waiting 2h11m
      Custom prompt
  ─────────────────────────────
  Edit Shared Prompt…
  ─────────────────────────────
✓ Open at Login
  Quit
```

- **Each session is named by what it's working on**, not by process id.
- **The checkbox is the only per-session setting**: should this one be resumed
  automatically after a limit resets? Click to toggle — the menu stays open, so you can flip
  several in a row — or use **Resume All / Pause All** to switch every session at once.
- Hold **Option** to reveal *Fix Monitoring*, which restarts every monitor.

More detail in [`menubar/README.md`](menubar/README.md).

## Customising what gets sent

### The shared prompt

When a session resumes, it is sent one message. Set it in `~/.claude-auto-retry.json`
(or via **Edit Shared Prompt…** in the menu bar app):

```json
{
  "usageLimitMessage": "Pick up where you left off and keep going until the task is done."
}
```

Make this generic. It goes to *every* session on the machine, so build-specific
instructions ("finish todo.md") will end up in an unrelated project.

Edits take effect on running sessions within a few seconds — no restart. If the file stops
being valid JSON, the monitors keep the last good settings and log a warning instead of
quietly reverting to defaults.

### A prompt for one session only

When two sessions are doing unrelated work, one shared instruction is wrong for at
least one of them. Click **Custom prompt** under a session in the menu bar app to give
that session its own — it opens in your editor, seeded with the shared text.

A session counts as customised only once its prompt actually *differs* from the shared
one, so opening the editor and changing nothing leaves you on the shared prompt rather
than silently pinning you to today's copy of it.

Overrides live in `~/.claude-auto-retry/session-prompts/` and are keyed by Claude's
process id, so they expire with the session and can never be sent to a later one.

### Everything else

| Key | Default | What it does |
|---|---|---|
| `usageLimitMessage` | `"Continue where you left off…"` | Sent after a usage limit resets |
| `contextLimit.retryMessage` | same as above | Sent after a `/compact` finishes |
| `contextLimit.compactTimeoutSeconds` | `180` | How long to let compaction run before giving up |
| `contextLimit.maxRetries` | `2` | Compaction attempts per event |
| `maxRetries` | `5` | Retry attempts per usage-limit event |
| `pollIntervalSeconds` | `5` | How often each pane is checked |
| `marginSeconds` | `60` | Extra wait after the stated reset time |
| `retryMessage` | `"Continue…"` | Sent on **API overload** only, not usage limits |
| `sessionResetCheck.enabled` | `false` | Passive `/status` check for the always-on menu bar countdown |
| `sessionResetCheck.intervalMinutes` | `10` | How often an idle session gets checked |
| `inputBox.whenOccupied` | `"send"` | What to do if the input box already holds text when a message is about to be typed. `"send"` types anyway (the text is appended to the draft, and a warning is logged); `"wait"` holds until the box is empty. Opt-in because Claude Code's greyed-out prompt *suggestions* look like typed text to a screen reader, and holding on one would stall an unattended session |

All keys are optional and invalid values fall back to defaults.
[`docs/reference.md`](docs/reference.md) documents the rest.

## Why it won't fire by accident

Sending keystrokes into your terminal is only safe if the detection is strict, so:

- A trigger must be a **whole line**, with **no message glyph** in front of it and
  **nothing but UI chrome below it** — so a session that merely *reads or prints* the
  words "Context limit reached" cannot compact itself, and neither can text you've
  typed into the input box.
- After `/compact`, the continuation prompt is **not** sent on a timer. Moonlighter
  waits until the pane shows compaction has finished.
- If you continue the session yourself first, it notices and stands down.
- Anything it isn't sure about, it leaves alone. Failure means *nothing happens* —
  never a stray keystroke.

`npm test` pins each of these rules.

## Names

The project is **Moonlighter**. The command line tool, the shell function's launcher and the
data directory (`~/.claude-auto-retry/`, `~/.claude-auto-retry.json`) keep the upstream name
`claude-auto-retry`, and the menu bar app is `Moonlighter.app`. The first two were deliberately not renamed:
the shell function, the launchd jobs and every running monitor refer to those paths, so a rename
would strand existing installs.

## Credits

A fork of [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry)
v0.7.3, which does the usage-limit and overload work. This fork adds context-limit
compaction, per-session prompts, a separate usage-limit message, and the macOS menu bar
app.

MIT, as upstream. See [`LICENSE`](LICENSE).
