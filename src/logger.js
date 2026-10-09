import { appendFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_LOG_DIR = join(homedir(), '.claude-auto-retry', 'logs');
const MAX_AGE_DAYS = 7;
const CLEANUP_INTERVAL_MS = 3600_000;
let lastCleanup = 0;

// Local time, not UTC: toISOString() is UTC, and stripping its "Z" left every log line
// looking like local time while actually running hours ahead/behind it — on IST (UTC+5:30)
// a "14:25" entry was really 19:55, which reads as a wait/retry computed hours wrong when
// it was not. pad() only needs 2 digits: every field here is a calendar/clock value < 100.
function pad(n) { return String(n).padStart(2, '0'); }

function localParts(d) {
  return {
    y: d.getFullYear(), mo: pad(d.getMonth() + 1), day: pad(d.getDate()),
    h: pad(d.getHours()), mi: pad(d.getMinutes()), s: pad(d.getSeconds()),
  };
}

function timestamp() {
  return localTimestamp();
}

// Exported for other modules that write their own timestamped files (e.g. session-reset.js's
// usage_log.txt) and want the same local-time convention as the monitor's own logs, rather
// than a second, differently-timezoned implementation of the same three lines.
export function localTimestamp(date = new Date()) {
  const { y, mo, day, h, mi, s } = localParts(date);
  return `${y}-${mo}-${day} ${h}:${mi}:${s}`;
}

// The log file for a given moment — named by LOCAL calendar date, rolling over at local
// midnight. Exported so `claude-auto-retry status`/`logs` read the file the monitors are
// actually appending to; deriving the name separately (toISOString() is UTC) pointed them at
// yesterday's file for the first hours of every local day east of Greenwich.
export function todayLogFile(dir = DEFAULT_LOG_DIR, date = new Date()) {
  const { y, mo, day } = localParts(date);
  return join(dir, `${y}-${mo}-${day}.log`);
}

function todayFile(dir) {
  return todayLogFile(dir);
}

async function cleanup(dir) {
  if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = Date.now();
  try {
    const files = await readdir(dir);
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const s = await stat(join(dir, file));
      if (s.mtimeMs < cutoff) await unlink(join(dir, file));
    }
  } catch { /* ignore */ }
}

export function createLogger(dir = DEFAULT_LOG_DIR) {
  let dirCreated = false;
  async function ensureDir() {
    if (!dirCreated) { await mkdir(dir, { recursive: true }); dirCreated = true; }
  }
  async function log(level, message) {
    await ensureDir();
    await appendFile(todayFile(dir), `[${timestamp()}] [${level}] ${message}\n`);
    cleanup(dir);
  }
  return {
    info: (msg) => log('INFO', msg),
    warn: (msg) => log('WARN', msg),
    error: (msg) => log('ERROR', msg),
  };
}
