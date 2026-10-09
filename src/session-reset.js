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

import { readFile, writeFile, appendFile, mkdir, stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { findSessionResetLine, findSessionUsagePercent, findWeeklyResetLine, findWeeklyUsagePercent, isInputBoxEmpty } from './patterns.js';
import { localTimestamp } from './logger.js';

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
//
// "Orphaned" has to be decided, not assumed: every monitor on the machine shares this
// namespace, so sweeping everything with the prefix also killed a PEER's probe that was
// still running (the name is `<prefix><pid>-<startedAt>`). A session counts as live only if
// its owner process still exists AND it is younger than any real probe could be.
const PROBE_MAX_AGE_MS = 120_000;

export function isLiveProbeSession(name, now = Date.now()) {
  const m = name.match(/^car-usage-probe-(\d+)-(\d+)$/);
  if (!m) return false;                                   // unrecognised shape → treat as orphaned
  if (now - Number(m[2]) > PROBE_MAX_AGE_MS) return false;
  try { process.kill(Number(m[1]), 0); return true; }
  catch (err) { return err.code === 'EPERM'; }            // exists but not ours → still alive
}

async function sweepOrphanedSessions(tmuxAdapter) {
  const names = await tmuxAdapter.listSessions();
  for (const n of names) {
    if (n.startsWith(SCRATCH_SESSION_PREFIX) && !isLiveProbeSession(n)) {
      await tmuxAdapter.killSession(n).catch(() => {});
    }
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
    const resetAt = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    // A failure to read the gauge doesn't invalidate the reset time — they're independent
    // reads of the same screen, and the reset time is the one this file exists for. Weekly
    // figures are read as raw text, not turned into an epoch (see findWeeklyResetLine) —
    // nothing currently drives a countdown off the weekly boundary, only publishes it.
    const percentUsed = findSessionUsagePercent(raw);
    const weeklyPercentUsed = findWeeklyUsagePercent(raw);
    const weeklyResetText = findWeeklyResetLine(raw);
    return { resetAt, percentUsed, weeklyPercentUsed, weeklyResetText };
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

// The four figures worth persisting across calls, defaulted for a missing/empty cache.
function pickCacheFields(source) {
  return {
    resetAt: source ? source.resetAt || 0 : 0,
    percentUsed: source && source.percentUsed != null ? source.percentUsed : null,
    weeklyPercentUsed: source && source.weeklyPercentUsed != null ? source.weeklyPercentUsed : null,
    weeklyResetText: source && source.weeklyResetText != null ? source.weeklyResetText : null,
  };
}

// Cross-process mutual exclusion for the probe. The cache's claimedAt is advisory — a
// read-then-write that N monitors ticking in the same instant all pass together (after a
// "Fix Monitoring" restart they tick in lockstep), so every one of them launched its own
// scratch Claude. Creating the lock file with O_EXCL is atomic: exactly one process wins.
// A lock older than LOCK_STALE_MS belongs to a probe that died without releasing it.
const LOCK_STALE_MS = 60_000;

async function acquireProbeLock(lockFile) {
  await mkdir(dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockFile, token, { flag: 'wx' });
      // Release only a lock that is still OURS: after a stale steal, the original owner's
      // late release must not delete the new owner's lock.
      return async () => {
        try { if ((await readFile(lockFile, 'utf-8')) === token) await unlink(lockFile); } catch { /* gone */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs;
      try { ageMs = Date.now() - (await stat(lockFile)).mtimeMs; } catch { continue; }  // vanished → retry
      if (ageMs < LOCK_STALE_MS) return null;                                           // a live probe owns it
      await unlink(lockFile).catch(() => {});                                           // abandoned → take over
    }
  }
  return null;
}

// Called from an idle monitoring tick. Returns { resetAt, percentUsed, weeklyPercentUsed,
// weeklyResetText, fresh } — fresh is true only when a probe actually produced a reading THIS
// call (as opposed to serving a cache hit, deferring to another monitor's in-flight probe, or
// a probe that failed outright), so callers can tell "just learned something new" apart from
// "nothing changed, don't bother logging it".
export async function getSessionUsage(tmuxAdapter, config, cacheFile = DEFAULT_CACHE_FILE) {
  const intervalMs = ((config.sessionResetCheck && config.sessionResetCheck.intervalMinutes) || 10) * 60_000;
  const served = (cache) => ({ ...pickCacheFields(cache), fresh: false });
  const now = Date.now();
  const cache = await readCache(cacheFile);
  if (cache) {
    if (cache.checkedAt && now - cache.checkedAt < intervalMs) return served(cache);
    if (cache.claimedAt && now - cache.claimedAt < CLAIM_ABANDON_MS) return served(cache);
  }

  const release = await acquireProbeLock(`${cacheFile}.lock`).catch(() => null);
  if (!release) return served(cache);                       // another monitor is probing right now
  try {
    // Re-check under the lock: a peer may have finished a probe in the gap between our first
    // read and winning the lock, in which case there is nothing left to do.
    const current = await readCache(cacheFile);
    if (current && current.checkedAt && Date.now() - current.checkedAt < intervalMs) return served(current);

    const prior = pickCacheFields(current);
    const priorCheckedAt = current ? current.checkedAt || 0 : 0;
    const claimedAt = Date.now();
    await writeCache(cacheFile, { ...prior, checkedAt: priorCheckedAt, claimedAt });
    const result = await probeViaScratchSession(tmuxAdapter, config).catch(() => null);
    const final = {
      resetAt: (result && result.resetAt) || prior.resetAt,
      // A totally failed probe falls back to the last known figures (better than nothing,
      // same as resetAt); a probe that succeeded but couldn't read a given row reports that
      // one as unknown rather than silently reusing a figure that's since drifted.
      percentUsed: result ? result.percentUsed : prior.percentUsed,
      weeklyPercentUsed: result ? result.weeklyPercentUsed : prior.weeklyPercentUsed,
      weeklyResetText: result ? result.weeklyResetText : prior.weeklyResetText,
    };
    await writeCache(cacheFile, { ...final, checkedAt: Date.now(), claimedAt });
    return { ...final, fresh: result !== null };
  } finally {
    await release();
  }
}

// A real usage-limit episode just resolved, so the window that produced the cached
// boundary is gone — due immediately instead of waiting out the normal interval, so the
// next idle tick (from any monitored pane) refreshes it rather than showing the
// now-meaningless old one for up to intervalMinutes.
export async function invalidateSessionResetCache(cacheFile = DEFAULT_CACHE_FILE) {
  const cache = await readCache(cacheFile);
  await writeCache(cacheFile, { ...pickCacheFields(cache), checkedAt: 0, claimedAt: 0 });
}

export const DEFAULT_USAGE_LOG_FILE = join(homedir(), '.claude-auto-retry', 'usage_log.txt');

function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// A plain-text running log of the two quotas, one line per fresh check — separate from the
// JSON cache (which exists to be read by this code, not skimmed by a person). Requested
// directly: publish the 5-hour and weekly remaining quota to usage_log.txt periodically.
// Takes the object getSessionUsage just returned rather than re-reading the cache, so a
// caller that already has a fresh result doesn't pay for a redundant file read.
export async function appendUsageLog(usage, logFile = DEFAULT_USAGE_LOG_FILE) {
  const sessionPart = usage.resetAt
    ? `5-hour: ${usage.percentUsed != null ? `${usage.percentUsed}% used` : 'unknown%'}, resets in ${formatDuration(usage.resetAt - Date.now())}`
    : '5-hour: unknown';
  const weeklyPart = usage.weeklyResetText
    ? `Weekly: ${usage.weeklyPercentUsed != null ? `${usage.weeklyPercentUsed}% used` : 'unknown%'}, ${usage.weeklyResetText}`
    : 'Weekly: unknown';
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `[${localTimestamp()}] ${sessionPart} | ${weeklyPart}\n`);
}
