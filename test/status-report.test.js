import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatDuration, isStaleSnapshot, describeSnapshot, readAllSnapshots, renderSessionLines } from '../src/status-report.js';

const NOW = 1_800_000_000;
const snap = (over = {}) => ({ status: 'monitoring', updatedAt: NOW - 2, pollIntervalSeconds: 5, pane: '%3', ...over });

describe('formatDuration', () => {
  it('formats seconds, minutes, hours and days', () => {
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(12 * 60 + 5), '12m');
    assert.equal(formatDuration(2 * 3600 + 11 * 60), '2h11m');
    assert.equal(formatDuration(3 * 86400 + 4 * 3600), '3d4h');
  });
  it('never goes negative', () => assert.equal(formatDuration(-5), '0s'));
});

describe('isStaleSnapshot', () => {
  it('fresh within three poll intervals', () => assert.equal(isStaleSnapshot(snap(), NOW), false));
  it('stale beyond three poll intervals', () => assert.equal(isStaleSnapshot(snap({ updatedAt: NOW - 16 }), NOW), true));
  it('a 1s poll interval is floored to 5s so a busy machine is not "stale"', () => {
    assert.equal(isStaleSnapshot(snap({ pollIntervalSeconds: 1, updatedAt: NOW - 10 }), NOW), false);
  });
});

describe('describeSnapshot', () => {
  it('a plain monitoring session is "running"', () => assert.match(describeSnapshot(snap(), NOW), /running/));
  it('a usage-limit wait shows the countdown, in days when long', () => {
    const line = describeSnapshot(snap({ status: 'waiting', waitUntil: NOW + 3 * 86400 + 4 * 3600 }), NOW);
    assert.match(line, /usage limit/);
    assert.match(line, /3d4h left/);
  });
  it('overload, safeguard and context each read the right deadline field', () => {
    assert.match(describeSnapshot(snap({ status: 'overload', overloadWaitUntil: NOW + 90 }), NOW), /API busy.*1m left/);
    assert.match(describeSnapshot(snap({ status: 'safeguard', safeguardWaitUntil: NOW + 8 }), NOW), /safeguard.*8s left/);
    assert.match(describeSnapshot(snap({ status: 'context', contextWaitUntil: NOW + 30 }), NOW), /compacting.*30s left/);
  });
  it('a deadline already in the past shows no countdown', () => {
    assert.doesNotMatch(describeSnapshot(snap({ status: 'waiting', waitUntil: NOW - 5 }), NOW), /left/);
  });
  it('gaveUp wins over the status it was frozen at', () => {
    assert.match(describeSnapshot(snap({ status: 'waiting', waitUntil: NOW + 600, gaveUp: true }), NOW), /needs you/);
  });
  it('a stale snapshot says it is not being watched, whatever it last said', () => {
    const line = describeSnapshot(snap({ status: 'waiting', waitUntil: NOW + 600, updatedAt: NOW - 840 }), NOW);
    assert.match(line, /not being watched/);
    assert.match(line, /14m/);
  });
});

describe('readAllSnapshots / renderSessionLines', () => {
  it('reads snapshots, recovers the pane from the filename for old files, skips junk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'car-status-'));
    try {
      await writeFile(join(dir, '_private_tmp_tmux-501_default__12.json'), JSON.stringify({ status: 'monitoring', updatedAt: NOW }));
      await writeFile(join(dir, 'x_new.json'), JSON.stringify({ status: 'waiting', updatedAt: NOW, pane: '%4', claudePid: 99 }));
      await writeFile(join(dir, 'broken.json'), '{ not json');
      await writeFile(join(dir, 'noupdated.json'), JSON.stringify({ status: 'monitoring' }));
      await writeFile(join(dir, 'ignore.txt'), 'x');
      const snaps = await readAllSnapshots(dir);
      assert.deepEqual(snaps.map((s) => s.pane).sort(), ['%12', '%4']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('a missing directory is no sessions, not an error', async () => {
    assert.deepEqual(await readAllSnapshots('/nonexistent/car-status-dir'), []);
  });
  it('lists panes in numeric order with their claude pid', () => {
    const lines = renderSessionLines([
      snap({ pane: '%10', claudePid: 7 }), snap({ pane: '%2', claudePid: 1234 }),
    ], NOW);
    assert.match(lines[0], /%2 .*claude 1234/);
    assert.match(lines[1], /%10 .*claude 7/);
  });
  it('explains itself when nothing is monitored', () => {
    const lines = renderSessionLines([], NOW);
    assert.match(lines[0], /No monitored sessions/);
    assert.ok(lines.some((l) => /reconcile/.test(l)));
  });
});
