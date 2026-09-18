// Learns the account's usage-limit reset time for the menu bar's always-on countdown
// (see AppDelegate/Model.swift's sessionResetDeadline), without touching any of the
// user's live, working panes.
//
// The reset time turned out to be ACCOUNT-WIDE, not per-session — verified live: a
// brand-new session with zero conversation history reported the identical "Resets
// 10:50pm" instant as a long-running one asked moments later. That means there is no
// need to open Claude Code's own /status panel inside a pane someone is actually using
// (and risk landing on top of an in-progress, unsent prompt no matter how carefully
// that's gated) — this spins up its own disposable tmux session, launches its own
// `claude` process in it, reads the SAME boundary off that, and tears the whole thing
// down. The user's real panes are never sent a single keystroke.
//
// Cached to one shared file rather than per-pane state, since every monitored pane on
// the machine is asking about the same boundary — one probe answers all of them, and
// the file's checkedAt lets concurrent monitors avoid piling on redundant scratch
// sessions (each one claims the slot by writing a fresh checkedAt before it starts).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { findSessionResetLine, isInputBoxEmpty } from './patterns.js';

// Overridable (see getSessionResetAt/invalidateSessionResetCache's cacheFile param) so
// tests don't read or write the real, shared, machine-wide cache — mirrors logger.js's
// createLogger(dir).
export const DEFAULT_CACHE_FILE = join(homedir(), '.claude-auto-retry', 'session-reset-cache.json');

// FIXED, not the caller's own cwd: Claude Code's first-run trust dialog is keyed by
// directory (persisted in ~/.claude.json's projects[<dir>].hasTrustDialogAccepted), so a
// probe launched in whatever directory the monitor process happens to have as its cwd
// would re-trigger that dialog in a fresh, unrelated folder every time it differs. Using
// one dedicated, always-the-same directory means the dialog (handled below) is answered
// at most once, ever, on a given machine — every later probe boots straight to a prompt.
export const SCRATCH_CWD = join(homedir(), '.claude-auto-retry', 'scratch-probe-cwd');

// claude can take a few seconds to boot (more on a cold cache / first launch of the day).
const BOOT_TIMEOUT_MS = 12_000;
const BOOT_POLL_MS = 400;

async function readCache(cacheFile) {
  try { return JSON.parse(await readFile(cacheFile, 'utf-8')); } catch { return null; }
}

async function writeCache(cacheFile, data) {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(data));
}

// "Quick safety check: Is this a project you created or one you trust? ... ❯ No, exit /
// Yes, I trust this folder" — Claude Code's first-run-per-directory prompt, cursor
// defaulting to "No, exit". Answered at most once ever (see SCRATCH_CWD); every
// subsequent probe's first capture already shows a bare prompt and this never matches.
const TRUST_DIALOG_MARKER = /Yes, I trust this folder/;

async function waitForPrompt(tmuxAdapter, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let acceptedTrustDialog = false;
  while (Date.now() < deadline) {
    try {
      const raw = await tmuxAdapter.capturePane(name, 60);
      if (isInputBoxEmpty(raw)) return true;
      if (!acceptedTrustDialog && TRUST_DIALOG_MARKER.test(raw)) {
        acceptedTrustDialog = true; // once — a stuck dialog otherwise re-triggers every poll
        await tmuxAdapter.sendKey(name, 'Down');   // "No, exit" → "Yes, I trust this folder"
        await new Promise((r) => setTimeout(r, 150));
        await tmuxAdapter.sendKey(name, 'Enter');
      }
    } catch { /* session not fully up yet */ }
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
  }
  return false;
}

const SCRATCH_SESSION_PREFIX = 'car-usage-probe-';

// A monitor killed mid-probe (SIGTERM from a restart — the common case, since restarting
// monitors is how any code change here takes effect) exits immediately without ever
// reaching probeViaScratchSession's `finally`, orphaning the scratch tmux session and its
// `claude` process. Swept here — right before creating a new one — rather than at shutdown
// time, so it self-heals no matter WHY a previous probe never finished, not just SIGTERM.
async function sweepOrphanedSessions(tmuxAdapter) {
  const names = await tmuxAdapter.listSessions();
  for (const n of names) {
    if (n.startsWith(SCRATCH_SESSION_PREFIX)) await tmuxAdapter.killSession(n).catch(() => {});
  }
}

export async function probeViaScratchSession(tmuxAdapter, config, bootTimeoutMs = BOOT_TIMEOUT_MS) {
  const name = `${SCRATCH_SESSION_PREFIX}${process.pid}-${Date.now()}`;
  try {
    await mkdir(SCRATCH_CWD, { recursive: true });
    await sweepOrphanedSessions(tmuxAdapter);
    await tmuxAdapter.newSession(name, SCRATCH_CWD);
    // `command claude`, never the wrapped `claude` shell function — this must not spin up
    // its own monitored session (a monitor spawning a monitor of itself).
    await tmuxAdapter.sendKeys(name, 'command claude');
    if (!(await waitForPrompt(tmuxAdapter, name, bootTimeoutMs))) return null;

    await tmuxAdapter.sendKeys(name, '/status');
    await new Promise((r) => setTimeout(r, 500));
    // Tabs are Settings, Status, Config, Usage, Stats — /status opens on Status, so two
    // Right presses land on Usage, which has the reset line.
    for (let i = 0; i < 2; i++) {
      await tmuxAdapter.sendKey(name, 'Right');
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 400));
    const raw = await tmuxAdapter.capturePane(name, 60);

    const line = findSessionResetLine(raw);
    if (!line) return null;
    const parsed = parseResetTime(line);
    if (!parsed) return null;
    return Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
  } finally {
    // Nuke the session outright rather than exiting claude cleanly — nobody is watching
    // it, and that's simpler and faster than a graceful /exit handshake.
    await tmuxAdapter.killSession(name).catch(() => {});
  }
}

// claimedAt is written the moment a probe STARTS, checkedAt only once one actually
// FINISHES — distinct fields so a claim whose owner died mid-probe (see
// sweepOrphanedSessions) doesn't read as "someone's on it" for the full interval. 30s is
// generous over the ~3-12s a real probe takes, so a live probe is never pre-empted by a
// second one, but a dead one is retried well within the same idle-tick cadence rather than
// blocking the shared cache for up to intervalMinutes.
const CLAIM_ABANDON_MS = 30_000;

// Called from an idle monitoring tick. Returns the best-known reset epoch in ms, or the
// last good cached value (better than nothing) if a fresh probe fails or isn't due yet.
export async function getSessionResetAt(tmuxAdapter, config, cacheFile = DEFAULT_CACHE_FILE) {
  const intervalMs = ((config.sessionResetCheck && config.sessionResetCheck.intervalMinutes) || 10) * 60_000;
  const now = Date.now();
  const cache = await readCache(cacheFile);
  if (cache) {
    if (cache.checkedAt && now - cache.checkedAt < intervalMs) return cache.resetAt || 0;
    if (cache.claimedAt && now - cache.claimedAt < CLAIM_ABANDON_MS) return cache.resetAt || 0;
  }
  const priorResetAt = cache ? cache.resetAt || 0 : 0;
  const priorCheckedAt = cache ? cache.checkedAt || 0 : 0;
  // Claim the slot up front (before the several-second probe), so a second monitor's tick
  // landing moments later sees a fresh claimedAt and skips its own redundant scratch session.
  await writeCache(cacheFile, { resetAt: priorResetAt, checkedAt: priorCheckedAt, claimedAt: now });
  const resetAt = await probeViaScratchSession(tmuxAdapter, config).catch(() => null);
  const final = resetAt || priorResetAt;
  await writeCache(cacheFile, { resetAt: final, checkedAt: Date.now(), claimedAt: now });
  return final;
}

// A real usage-limit episode just resolved, so the window that produced the cached
// boundary is gone — due immediately instead of waiting out the normal interval, so the
// next idle tick (from any monitored pane) refreshes it rather than showing the
// now-meaningless old one for up to intervalMinutes.
export async function invalidateSessionResetCache(cacheFile = DEFAULT_CACHE_FILE) {
  const cache = await readCache(cacheFile);
  await writeCache(cacheFile, { resetAt: cache ? cache.resetAt || 0 : 0, checkedAt: 0, claimedAt: 0 });
}
