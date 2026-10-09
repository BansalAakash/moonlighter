// What `claude-auto-retry status` prints about each monitored session.
//
// The monitors publish one JSON snapshot per pane (status-file.js). This turns a snapshot
// into one plain-English line, using the same freshness and deadline rules as the menu bar
// app (menubar/Sources/AutoRetryBar/Model.swift) so the two never disagree about whether a
// session is being watched.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATUS_DIR } from './status-file.js';

// "3d4h" / "2h11m" / "12m" / "45s" — a countdown short enough for one line.
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s >= 2 * 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

// A snapshot older than three poll intervals means its monitor stopped ticking (SIGKILL,
// host crash): the file outlives the process. Floored at 5s so a 1s poll does not make every
// snapshot look stale on a busy machine — same tolerance as the menu bar app.
export function isStaleSnapshot(snap, nowSec = Math.floor(Date.now() / 1000)) {
  const poll = Math.max(snap.pollIntervalSeconds || 5, 5);
  return nowSec - snap.updatedAt > poll * 3;
}

const DEADLINE_FIELD = {
  waiting: 'waitUntil',
  overload: 'overloadWaitUntil',
  safeguard: 'safeguardWaitUntil',
  context: 'contextWaitUntil',
};

// One line describing what the session is doing, or why it is not being watched.
export function describeSnapshot(snap, nowSec = Math.floor(Date.now() / 1000)) {
  if (isStaleSnapshot(snap, nowSec)) {
    return `not being watched (monitor silent for ${formatDuration(nowSec - snap.updatedAt)})`;
  }
  if (snap.gaveUp) return `stuck — needs you (${snap.status}; the monitor has stopped retrying)`;
  const until = snap[DEADLINE_FIELD[snap.status]];
  const left = until > nowSec ? ` — ${formatDuration(until - nowSec)} left` : '';
  switch (snap.status) {
    case 'waiting': return `waiting for the usage limit to reset${left}`;
    case 'overload': return `API busy, backing off${left}`;
    case 'safeguard': return `retrying a safeguard flag${left}`;
    case 'context': return `compacting the conversation, then resuming${left}`;
    default: return 'running (watching)';
  }
}

// Panes recorded before snapshots carried their own identity: recover "%N" from the
// filename ("<socket>_<pane>.json", pane id sanitised so "%2" became "_2").
function paneFromFileName(name) {
  const m = name.replace(/\.json$/, '').match(/_(\d+)$/);
  return m ? `%${m[1]}` : name;
}

export async function readAllSnapshots(dir = STATUS_DIR) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const snap = JSON.parse(await readFile(join(dir, name), 'utf-8'));
      if (typeof snap.updatedAt !== 'number') continue;
      out.push({ ...snap, pane: snap.pane || paneFromFileName(name) });
    } catch { /* unreadable / half-written — skip */ }
  }
  return out;
}

// The "Monitored sessions" block. Returns an array of lines.
export function renderSessionLines(snapshots, nowSec = Math.floor(Date.now() / 1000)) {
  if (snapshots.length === 0) {
    return [
      'No monitored sessions.',
      '  Launch Claude with the `claude` shell function (see "When nothing happens" in the README),',
      '  or run `claude-auto-retry reconcile` to attach monitors to sessions already running in tmux.',
    ];
  }
  const sorted = snapshots.slice().sort((a, b) => String(a.pane).localeCompare(String(b.pane), undefined, { numeric: true }));
  return sorted.map((snap) => {
    const who = snap.claudePid ? `claude ${snap.claudePid}` : 'claude';
    return `  ${String(snap.pane).padEnd(6)} ${who.padEnd(14)} ${describeSnapshot(snap, nowSec)}`;
  });
}
