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

async function waitForPrompt(tmuxAdapter, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await tmuxAdapter.capturePane(name, 60);
      if (isInputBoxEmpty(raw)) return true;
    } catch { /* session not fully up yet */ }
    await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
  }
  return false;
}

export async function probeViaScratchSession(tmuxAdapter, config, bootTimeoutMs = BOOT_TIMEOUT_MS) {
  const name = `car-usage-probe-${process.pid}-${Date.now()}`;
  try {
    await tmuxAdapter.newSession(name);
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

// Called from an idle monitoring tick. Returns the best-known reset epoch in ms, or the
// last good cached value (better than nothing) if a fresh probe fails or isn't due yet.
export async function getSessionResetAt(tmuxAdapter, config, cacheFile = DEFAULT_CACHE_FILE) {
  const intervalMs = ((config.sessionResetCheck && config.sessionResetCheck.intervalMinutes) || 10) * 60_000;
  const cache = await readCache(cacheFile);
  if (cache && Date.now() - (cache.checkedAt || 0) < intervalMs) {
    return cache.resetAt || 0;
  }
  // Claim the slot up front (before the several-second probe), so a second monitor's tick
  // landing moments later sees a fresh checkedAt and skips its own redundant scratch session.
  await writeCache(cacheFile, { resetAt: cache ? cache.resetAt || 0 : 0, checkedAt: Date.now() });
  const resetAt = await probeViaScratchSession(tmuxAdapter, config).catch(() => null);
  const final = resetAt || (cache ? cache.resetAt || 0 : 0);
  await writeCache(cacheFile, { resetAt: final, checkedAt: Date.now() });
  return final;
}

// A real usage-limit episode just resolved, so the window that produced the cached
// boundary is gone — due immediately instead of waiting out the normal interval, so the
// next idle tick (from any monitored pane) refreshes it rather than showing the
// now-meaningless old one for up to intervalMinutes.
export async function invalidateSessionResetCache(cacheFile = DEFAULT_CACHE_FILE) {
  const cache = await readCache(cacheFile);
  await writeCache(cacheFile, { resetAt: cache ? cache.resetAt || 0 : 0, checkedAt: 0 });
}
