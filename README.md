# Moonlighter

**Claude Code stops when you're not there. This keeps it going.**

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
| **A monitor dies** | A repair timer notices within 5 minutes and re-arms it. |

Everything runs on your machine. No account, no network calls, no dependencies.

---

## Requirements

- **macOS or Linux** (the menu bar app is macOS 13+ only; the CLI works on both)
- **Node 18+**
- **tmux** — installed for you if missing
- **Claude Code**

## Install

```bash
git clone https://github.com/BansalAakash/moonlighter.git
cd moonlighter
./install.sh
```

Then open a new terminal. That's the whole setup.

The script links the CLI, adds a `claude` shell function to your `~/.zshrc` /
`~/.bashrc`, and on macOS builds and launches the menu bar app. It's safe to re-run —
do that after switching Node versions, which strands the shell wrapper.

## Using it

**Type `claude` exactly as you always have.** The shell function launches it inside a
tmux pane so a monitor can watch it, then gets out of the way. Nothing else changes.

To check on things:

```bash
claude-auto-retry status     # what's being watched, and what each session is doing
claude-auto-retry logs       # what has happened today
```

To stop using it, `claude-auto-retry uninstall` removes the shell function.

## The menu bar app <sub>(macOS)</sub>

A small icon in your status bar, so you never have to wonder whether the thing is
working. It shows a countdown while a session is waiting out a limit, and turns red if
one needs you.

Clicking it gives you the whole app in about six lines:

```
✓ Custom printer utility application — running
      Custom prompt
✓ Claude-auto-retry review — waiting 2h11m
      Custom prompt
  ─────────────────────────────
  2h ago  ·  Sent retry message (attempt 1)
  Edit Shared Prompt…
  ─────────────────────────────
✓ Open at Login
  Quit
```

- **Each session is named by what it's working on**, not by process id.
- **The checkmark is the only per-session setting**: should this one be resumed
  automatically after a limit resets? Click to toggle.
- **The log line answers "did it fire while I was asleep?"** Click it to open the full
  log. On a quiet day it just reads `Open Log…`.
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

`npm test` runs 576 tests covering this.

## Credits

A fork of [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry)
v0.7.3, which does the usage-limit and overload work. This fork adds context-limit
compaction, per-session prompts, a separate usage-limit message, and the macOS menu bar
app.

MIT, as upstream. See [`LICENSE`](LICENSE).
