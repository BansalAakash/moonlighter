import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSessionUsage, invalidateSessionResetCache, probeViaScratchSession, appendUsageLog } from '../src/session-reset.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// `paneContent` is either a fixed string (every capture returns it) or a function of the
// capture call count (1-indexed) — the latter simulates the pane's content changing over
// time, e.g. a dialog that's there for the first couple of polls and then isn't.
function mockScratchTmux(paneContent = '', existingSessions = []) {
  let captureCalls = 0;
  const t = {
    _newSessions: [],
    _newSessionCwds: [],
    _killedSessions: [],
    _sent: [],
    _keys: [],
    _sessions: [...existingSessions],
    newSession: async (name, cwd) => { t._newSessions.push(name); t._newSessionCwds.push(cwd); t._sessions.push(name); },
    killSession: async (name) => { t._killedSessions.push(name); t._sessions = t._sessions.filter((s) => s !== name); },
    listSessions: async () => t._sessions,
    sendKeys: async (_target, text) => { t._sent.push(text); },
    sendKey: async (_target, key) => { t._keys.push(key); },
    capturePane: async () => {
      captureCalls++;
      return typeof paneContent === 'function' ? paneContent(captureCalls) : paneContent;
    },
  };
  return t;
}

const USAGE_PANEL = [
  '   Current session',
  '   █████████████████                                  34% used',
  '   Resets 9pm (UTC)',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
].join('\n');

const USAGE_PANEL_WITH_WEEKLY = [
  '   Current session',
  '   █████████████████                                  34% used',
  '   Resets 9pm (UTC)',
  '',
  '   Current week (all models)',
  '   ████████████████████████████▉                      58% used',
  '   Resets Sep 19 at 6:30am (UTC)',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
].join('\n');

const cacheFile = () => join(tmpdir(), `car-session-reset-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

describe('probeViaScratchSession', () => {
  it('spins up a scratch session, reads the reset time and usage percent, and always tears it down', async () => {
    const t = mockScratchTmux(USAGE_PANEL);
    const result = await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.ok(result.resetAt > Date.now());
    assert.equal(result.percentUsed, 34);
    assert.equal(t._newSessions.length, 1);
    assert.match(t._newSessions[0], /^car-usage-probe-/);
    assert.deepEqual(t._sent, ['command claude', '/status']);
    assert.deepEqual(t._keys, ['Right', 'Right']);
    // Tears down the SAME session it created, not some other name.
    assert.deepEqual(t._killedSessions, [t._newSessions[0]]);
  });

  it('reads a reset time even when the gauge row is missing (percentUsed null, not fatal)', async () => {
    const noGauge = ['Current session', 'Resets 9pm (UTC)', '❯ '].join('\n');
    const t = mockScratchTmux(noGauge);
    const result = await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.ok(result.resetAt > Date.now());
    assert.equal(result.percentUsed, null);
  });

  it('also reads the weekly figures when the panel shows a "Current week" block', async () => {
    const t = mockScratchTmux(USAGE_PANEL_WITH_WEEKLY);
    const result = await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.equal(result.percentUsed, 34);
    assert.equal(result.weeklyPercentUsed, 58);
    assert.equal(result.weeklyResetText, 'Resets Sep 19 at 6:30am (UTC)');
  });

  it('gives up and tears the session down if the prompt never appears', async () => {
    const t = mockScratchTmux('Version: 2.1.276\nEsc to cancel'); // no prompt row → never "boots"
    const result = await probeViaScratchSession(t, DEFAULT_CONFIG, 50); // short timeout for the test
    assert.equal(result, null);
    assert.equal(t._killedSessions.length, 1);
  });

  it('tears the scratch session down even when the reset line is never found', async () => {
    const t = mockScratchTmux('Current session\nno reset line here\n❯ ');
    const result = await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.equal(result, null);
    assert.equal(t._killedSessions.length, 1);
  });

  it('still tears the scratch session down when a mid-probe tmux call throws', async () => {
    const t = mockScratchTmux(USAGE_PANEL); // boots fine (has an empty prompt row)
    t.sendKey = async () => { throw new Error('tmux exploded'); }; // fails navigating to Usage
    await assert.rejects(() => probeViaScratchSession(t, DEFAULT_CONFIG));
    assert.equal(t._killedSessions.length, 1);
  });

  it('launches in the fixed scratch cwd, not whatever cwd the caller has', async () => {
    const t = mockScratchTmux(USAGE_PANEL);
    await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.match(t._newSessionCwds[0], /scratch-probe-cwd$/);
  });

  it('sweeps orphaned scratch sessions (from a monitor killed mid-probe) before starting', async () => {
    const t = mockScratchTmux(USAGE_PANEL, ['car-usage-probe-9999-111', 'car-usage-probe-8888-222', 'some-unrelated-session']);
    await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.deepEqual(t._killedSessions.slice(0, 2).sort(), ['car-usage-probe-8888-222', 'car-usage-probe-9999-111']);
    assert.ok(!t._killedSessions.includes('some-unrelated-session'), 'must not touch sessions outside its own namespace');
  });

  it("accepts the first-run trust dialog once, then proceeds normally", async () => {
    const TRUST_DIALOG = [
      'Quick safety check: Is this a project you created or one you trust?',
      '❯ No, exit',
      '  Yes, I trust this folder',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    // Dialog for the first 2 polls (boot + one retry), then a normal idle prompt from then on.
    const t = mockScratchTmux((n) => (n <= 2 ? TRUST_DIALOG : USAGE_PANEL));
    const result = await probeViaScratchSession(t, DEFAULT_CONFIG);
    assert.ok(result.resetAt > Date.now());
    // Down (to "Yes, I trust this folder") + Enter to accept it, sent exactly once.
    assert.deepEqual(t._keys.slice(0, 2), ['Down', 'Enter']);
    assert.deepEqual(t._keys.slice(2), ['Right', 'Right'], 'navigation keys still follow, unduplicated');
  });
});

describe('getSessionUsage / invalidateSessionResetCache', () => {
  const files = [];
  afterEach(async () => { await Promise.all(files.splice(0).map((f) => rm(f, { force: true }))); });

  it('probes on first call, caches the result, and reports fresh: true', async () => {
    const file = cacheFile(); files.push(file);
    const t = mockScratchTmux(USAGE_PANEL);
    const usage = await getSessionUsage(t, DEFAULT_CONFIG, file);
    assert.ok(usage.resetAt > Date.now());
    assert.equal(usage.percentUsed, 34);
    assert.equal(usage.fresh, true);
    assert.equal(t._newSessions.length, 1);

    const cached = JSON.parse(await readFile(file, 'utf-8'));
    assert.equal(cached.resetAt, usage.resetAt);
    assert.equal(cached.percentUsed, 34);
  });

  it('caches and returns the weekly figures alongside the session ones', async () => {
    const file = cacheFile(); files.push(file);
    const t = mockScratchTmux(USAGE_PANEL_WITH_WEEKLY);
    const usage = await getSessionUsage(t, DEFAULT_CONFIG, file);
    assert.equal(usage.weeklyPercentUsed, 58);
    assert.equal(usage.weeklyResetText, 'Resets Sep 19 at 6:30am (UTC)');

    const cached = JSON.parse(await readFile(file, 'utf-8'));
    assert.equal(cached.weeklyPercentUsed, 58);
    assert.equal(cached.weeklyResetText, 'Resets Sep 19 at 6:30am (UTC)');
  });

  it('does not re-probe within intervalMinutes — serves the cached value with fresh: false', async () => {
    const file = cacheFile(); files.push(file);
    const t = mockScratchTmux(USAGE_PANEL);
    const config = { ...DEFAULT_CONFIG, sessionResetCheck: { enabled: true, intervalMinutes: 10 } };
    const first = await getSessionUsage(t, config, file);
    const second = await getSessionUsage(t, config, file);
    assert.equal(second.resetAt, first.resetAt);
    assert.equal(second.percentUsed, first.percentUsed);
    assert.equal(second.fresh, false);
    assert.equal(t._newSessions.length, 1, 'second call must not spin up another scratch session');
  });

  it('falls back to the last good cached values when a fresh probe fails entirely', async () => {
    const file = cacheFile(); files.push(file);
    const good = mockScratchTmux(USAGE_PANEL);
    const first = await getSessionUsage(good, DEFAULT_CONFIG, file);

    await invalidateSessionResetCache(file); // force the next call to actually probe again
    // Boots fine (has an empty prompt row) but the Usage tab never has a parseable line —
    // a stale cache falling back to the timeout-slow "never boots" path would make this
    // test needlessly slow without testing anything the boot-timeout test doesn't already.
    const failing = mockScratchTmux('❯ ');
    const second = await getSessionUsage(failing, DEFAULT_CONFIG, file);
    assert.equal(second.resetAt, first.resetAt, 'a failed probe should not blank out a previously-known reset time');
    assert.equal(second.percentUsed, first.percentUsed);
  });

  it('a probe that finds the reset time but not the gauge reports percentUsed: null, not the stale figure', async () => {
    const file = cacheFile(); files.push(file);
    const good = mockScratchTmux(USAGE_PANEL);
    await getSessionUsage(good, DEFAULT_CONFIG, file);

    await invalidateSessionResetCache(file);
    const noGauge = mockScratchTmux(['Current session', 'Resets 9pm (UTC)', '❯ '].join('\n'));
    const second = await getSessionUsage(noGauge, DEFAULT_CONFIG, file);
    assert.equal(second.percentUsed, null, 'a partial success should not reuse a possibly-drifted stale percentage');
  });

  it('does not re-probe while a recent claim is presumably still in flight', async () => {
    const file = cacheFile(); files.push(file);
    // A claim from "just now" with no completed checkedAt yet — another monitor's probe
    // that (as far as this one knows) simply hasn't finished.
    await writeFile(file, JSON.stringify({ resetAt: 0, percentUsed: null, checkedAt: 0, claimedAt: Date.now() }));
    const t = mockScratchTmux(USAGE_PANEL);
    const usage = await getSessionUsage(t, DEFAULT_CONFIG, file);
    assert.equal(usage.resetAt, 0);
    assert.equal(usage.fresh, false);
    assert.equal(t._newSessions.length, 0, 'must not start a second probe over a fresh claim');
  });

  it('retries once a claim is old enough to be an abandoned one (monitor killed mid-probe)', async () => {
    const file = cacheFile(); files.push(file);
    // Old enough that whatever claimed it (a monitor SIGTERM'd mid-probe — see
    // sweepOrphanedSessions) could not possibly still be genuinely in flight.
    const longAgo = Date.now() - 60_000;
    await writeFile(file, JSON.stringify({ resetAt: 0, percentUsed: null, checkedAt: 0, claimedAt: longAgo }));
    const t = mockScratchTmux(USAGE_PANEL);
    const usage = await getSessionUsage(t, DEFAULT_CONFIG, file);
    assert.ok(usage.resetAt > Date.now(), 'an abandoned claim must not block a retry forever');
    assert.equal(t._newSessions.length, 1);
  });

  it('invalidateSessionResetCache forces the next call to probe again', async () => {
    const file = cacheFile(); files.push(file);
    const t = mockScratchTmux(USAGE_PANEL);
    await getSessionUsage(t, DEFAULT_CONFIG, file);
    assert.equal(t._newSessions.length, 1);

    await invalidateSessionResetCache(file);
    await getSessionUsage(t, DEFAULT_CONFIG, file);
    assert.equal(t._newSessions.length, 2, 'invalidated cache must trigger a second probe');
  });
});

describe('appendUsageLog', () => {
  const files = [];
  afterEach(async () => { await Promise.all(files.splice(0).map((f) => rm(f, { force: true }))); });
  const logFile = () => join(tmpdir(), `car-usage-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  it('writes one timestamped line with both the 5-hour and weekly figures', async () => {
    const file = logFile(); files.push(file);
    await appendUsageLog({
      resetAt: Date.now() + 4 * 3600_000 + 29 * 60_000,
      percentUsed: 34,
      weeklyPercentUsed: 58,
      weeklyResetText: 'Resets Sep 19 at 6:30am (UTC)',
    }, file);
    const content = await readFile(file, 'utf-8');
    assert.match(content, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 5-hour: 34% used, resets in 4h29m \| Weekly: 58% used, Resets Sep 19 at 6:30am \(UTC\)\n$/);
  });

  it('appends rather than overwrites', async () => {
    const file = logFile(); files.push(file);
    const usage = { resetAt: Date.now() + 60_000, percentUsed: 1, weeklyPercentUsed: 1, weeklyResetText: 'Resets Sep 19 at 6:30am (UTC)' };
    await appendUsageLog(usage, file);
    await appendUsageLog(usage, file);
    const content = await readFile(file, 'utf-8');
    assert.equal(content.trim().split('\n').length, 2);
  });

  it('degrades to "unknown" rather than throwing when figures are missing', async () => {
    const file = logFile(); files.push(file);
    await appendUsageLog({ resetAt: 0, percentUsed: null, weeklyPercentUsed: null, weeklyResetText: null }, file);
    const content = await readFile(file, 'utf-8');
    assert.match(content, /5-hour: unknown \| Weekly: unknown/);
  });
});
