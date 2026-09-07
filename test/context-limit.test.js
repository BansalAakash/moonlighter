import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { contextLimitMatch, detectContextLimit, isRateLimited, isWorking } from '../src/patterns.js';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_CONTEXT_LIMIT } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A REAL idle pane, captured from Claude Code v2.1.263 in a 200x45 tmux pane. Using the real
// capture rather than a hand-written sketch is the point: it carries the actual box rules, the
// footer, and the U+00A0 in the empty "❯ " input row, all of which the chrome rules have to
// classify correctly for the live-region gate to mean anything.
const IDLE_PANE = readFileSync(join(__dirname, 'fixture-idle-pane.txt'), 'utf-8').split('\n');

// The verbatim render, per the v2.1.263 binary:
//   <Text color="error">{"Context limit reached · "}{tz}{Nh}{zS ? ` · ${zS}` : ""}</Text>
const ROW = 'Context limit reached · /compact or /clear to continue';
const ROW_AUTOCOMPACT_OFF = `${ROW} · auto-compact is off · /config to turn it on`;
const ROW_CLEAR_ONLY = 'Context limit reached · /clear to continue';

// The row's exact seat in the render tree is a Claude Code implementation detail that has
// moved before, so the detector is anchored on the live region rather than on a fixed offset.
// These are the three seats it could plausibly take around the input box; all must detect.
const SEATS = {
  'above the input box': -4,   // …transcript, [row], rule, ❯, rule, footer
  'between box and footer': -2, // …rule, ❯, rule, [row], footer
  'below the footer': IDLE_PANE.length, // …footer, [row]
};
function paneWith(row, at) {
  const lines = [...IDLE_PANE];
  lines.splice(at < 0 ? lines.length + at : at, 0, row);
  return lines.join('\n');
}

function mockTmux(paneContent = '', paneCommand = 'node', claudeForeground = true) {
  const t = {
    _sent: [],
    capturePane: async () => t._pane,
    getPaneCommand: async () => paneCommand,
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => claudeForeground,
  };
  t._pane = paneContent;
  return t;
}

function cfg(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    usageLimitMessage: 'RESUME THE WORK',
    contextLimit: { ...DEFAULT_CONTEXT_LIMIT, retryMessage: 'RESUME THE WORK', ...overrides },
  };
}

const alive = () => true;

describe('contextLimitMatch — the live row', () => {
  for (const [where, at] of Object.entries(SEATS)) {
    it(`detects the row ${where}`, () => {
      const m = contextLimitMatch(paneWith(ROW, at));
      assert.notEqual(m, null, `no match with the row ${where}`);
      assert.equal(m.actionable, true);
      assert.equal(m.line, ROW);
    });
  }

  it('detects the "auto-compact is off" suffix variant', () => {
    const m = contextLimitMatch(paneWith(ROW_AUTOCOMPACT_OFF, -2));
    assert.notEqual(m, null);
    assert.equal(m.actionable, true);
  });

  it('detects an indented row (Ink pads notification rows in some layouts)', () =>
    assert.equal(detectContextLimit(paneWith(`  ${ROW}`, -2)), true));

  it('is case-insensitive', () =>
    assert.equal(detectContextLimit(paneWith(ROW.toUpperCase(), -2)), true));
});

describe('contextLimitMatch — the /clear-only variant (DISABLE_COMPACT)', () => {
  it('detects it but marks it NOT actionable', () => {
    const m = contextLimitMatch(paneWith(ROW_CLEAR_ONLY, -2));
    assert.notEqual(m, null);
    assert.equal(m.actionable, false);
  });
  it('detectContextLimit reports false for it — nothing to automate', () =>
    assert.equal(detectContextLimit(paneWith(ROW_CLEAR_ONLY, -2)), false));
});

describe('contextLimitMatch — false positives', () => {
  // The whole-line anchor exists because a monitored session READING about this feature
  // (a README, this package's own source, a chat about context limits) must not compact itself.
  const prose = [
    `⏺ When that happens Claude Code prints "${ROW}" and stops.`,
    `  The fix is to run /compact. You will see: ${ROW}`,
    `❯ what does "${ROW}" mean?`,
    `● ${ROW} — that is the row I was describing.`,
    `> ${ROW}`,
    `  - ${ROW}`,
    `  * ${ROW}`,
    `  | ${ROW} |`,
    `1. ${ROW}`,
  ];
  for (const line of prose) {
    it(`refuses ${JSON.stringify(line.slice(0, 48))}…`, () =>
      assert.equal(contextLimitMatch(paneWith(line, -2)), null));
  }

  it('refuses a row with real content below it (scrolled into history)', () => {
    const lines = [...IDLE_PANE];
    lines.splice(-2, 0, ROW, '⏺ Then I carried on working after it cleared.');
    assert.equal(contextLimitMatch(lines.join('\n')), null);
  });

  it('refuses the row quoted inside a tool-call render (#63 mask)', () => {
    const lines = [...IDLE_PANE];
    lines.splice(-2, 0, '● Bash(grep -rn "Context limit" src/)', `  ⎿  ${ROW}`);
    assert.equal(contextLimitMatch(lines.join('\n')), null);
  });

  it('finds nothing in a clean idle pane', () =>
    assert.equal(contextLimitMatch(IDLE_PANE.join('\n')), null));
});

describe('the chrome entry keeps the row from squeezing the other detectors', () => {
  // Regression: the row is the one render that sits BELOW the input box as a non-chrome line.
  // Untreated, the trailing-chrome scan stops on it and hands isRateLimited a 12-line window
  // made of box rules and footer instead of transcript — so a live limit banner a few rows up
  // goes undetected for as long as the context row is on screen.
  const BANNER = "⚠ You've hit your session limit · resets 2am (Europe/Zurich)";
  it('still sees a usage-limit banner above the box while the context row is displayed', () => {
    const lines = [...IDLE_PANE];
    lines.splice(-6, 0, BANNER);          // banner up in the transcript
    lines.splice(-2, 0, ROW);             // context row down by the box
    assert.equal(isRateLimited(lines.join('\n'), [], 12), true);
  });
  it('the row alone never reads as a usage limit', () =>
    assert.equal(isRateLimited(paneWith(ROW, -2), [], 12), false));
});

describe('processOneTick — context-limit compaction', () => {
  it('detects at an idle prompt without sending anything yet', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    assert.equal(await processOneTick(s, t, '%1', cfg(), alive), 'context-detected');
    assert.equal(s.status, 'context');
    assert.deepEqual(t._sent, []);
  });

  it('drives the full compact → resume flow', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    const c = cfg({ retryDelaySeconds: 0 });

    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-detected');

    s.contextWaitUntil = 0;                                   // skip the one-tick settle
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-compacting');
    assert.deepEqual(t._sent, ['/compact']);

    // Compaction turn runs: the footer carries "esc to interrupt". No attempt is consumed.
    t._pane = paneWith(ROW, -2).replace('auto mode on', 'auto mode on · esc to interrupt');
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-working');
    assert.equal(s.contextAttempts, 1);

    // Compaction lands: row gone, pane idle again → the continuation goes in.
    s.contextWaitUntil = 0;
    t._pane = IDLE_PANE.join('\n');
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-resumed');
    assert.deepEqual(t._sent, ['/compact', 'RESUME THE WORK']);
    assert.equal(s.status, 'monitoring');
  });

  it('resumes with the usageLimitMessage by default (the message the limited turn lost)', async () => {
    const c = await loadConfig('/nonexistent-config-for-this-test.json');
    assert.equal(c.contextLimit.retryMessage, c.usageLimitMessage);
  });

  it('does not resume twice — one continuation per compaction', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    const c = cfg({ retryDelaySeconds: 0 });
    await processOneTick(s, t, '%1', c, alive);
    s.contextWaitUntil = 0;
    await processOneTick(s, t, '%1', c, alive);
    s.contextWaitUntil = 0;
    t._pane = IDLE_PANE.join('\n');
    await processOneTick(s, t, '%1', c, alive);
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'monitoring');
    assert.equal(t._sent.filter(x => x === 'RESUME THE WORK').length, 1);
  });

  it('waits out the compaction deadline before spending another attempt', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    const c = cfg({ retryDelaySeconds: 0, compactTimeoutSeconds: 180 });
    await processOneTick(s, t, '%1', c, alive);
    s.contextWaitUntil = 0;
    await processOneTick(s, t, '%1', c, alive);          // sends /compact
    s.contextWaitUntil = 0;                              // row still up, idle, deadline live
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-compact-pending');
    assert.equal(s.contextAttempts, 1);
    assert.deepEqual(t._sent, ['/compact']);
  });

  it('retries, then gives up loudly once, when compaction never clears the row', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    const c = cfg({ retryDelaySeconds: 0, compactTimeoutSeconds: 0, maxRetries: 2 });
    await processOneTick(s, t, '%1', c, alive);
    for (let i = 0; i < 2; i++) {
      s.contextWaitUntil = 0;
      assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-compacting');
    }
    s.contextWaitUntil = 0;
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-gave-up');
    s.contextWaitUntil = 0;
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-holding');
    assert.equal(t._sent.filter(x => x === '/compact').length, 2);
  });

  it('never sends /clear — the clear-only render stands down', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW_CLEAR_ONLY, -2));
    const c = cfg({ retryDelaySeconds: 0 });
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-detected');
    s.contextWaitUntil = 0;
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-clear-only');
    assert.deepEqual(t._sent, []);
  });

  it('does not send when Claude is not the foreground process', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2), 'vim', false);
    const c = cfg({ retryDelaySeconds: 0 });
    await processOneTick(s, t, '%1', c, alive);
    s.contextWaitUntil = 0;
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'skipped-not-claude');
    assert.deepEqual(t._sent, []);
  });

  it('a usage limit outranks it — compacting would not help a spent window', async () => {
    const s = createMonitorState();
    const lines = [...IDLE_PANE];
    lines.splice(-6, 0, "⚠ You've hit your session limit", '· resets 2am (Europe/Zurich)');
    lines.splice(-2, 0, ROW);
    const t = mockTmux(lines.join('\n'));
    assert.equal(await processOneTick(s, t, '%1', cfg(), alive), 'waiting');
    assert.deepEqual(t._sent, []);
  });

  it('stands down when the row clears on its own (auto-compact, or the user)', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    const c = cfg({ retryDelaySeconds: 0 });
    await processOneTick(s, t, '%1', c, alive);
    s.contextWaitUntil = 0;
    t._pane = IDLE_PANE.join('\n');
    assert.equal(await processOneTick(s, t, '%1', c, alive), 'context-cleared');
    assert.equal(s.status, 'monitoring');
    assert.deepEqual(t._sent, []);
  });

  it('can be disabled', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2));
    assert.equal(await processOneTick(s, t, '%1', cfg({ enabled: false }), alive), 'monitoring');
    assert.deepEqual(t._sent, []);
  });

  it('never fires while Claude is working', async () => {
    const s = createMonitorState();
    const t = mockTmux(paneWith(ROW, -2).replace('auto mode on', 'auto mode on · esc to interrupt'));
    assert.equal(await processOneTick(s, t, '%1', cfg(), alive), 'monitoring');
  });
});

describe('config: contextLimit block', () => {
  it('falls back field-by-field on a malformed block', async () => {
    const { default: os } = await import('node:os');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(join(os.tmpdir(), 'car-cfg-'));
    const p = join(dir, 'cfg.json');
    writeFileSync(p, JSON.stringify({
      usageLimitMessage: 'GO ON',
      contextLimit: { enabled: 'yes', compactCommand: '', maxRetries: -3, compactTimeoutSeconds: 'soon' },
    }));
    const c = await loadConfig(p);
    assert.equal(c.contextLimit.enabled, DEFAULT_CONTEXT_LIMIT.enabled);
    assert.equal(c.contextLimit.compactCommand, '/compact');
    assert.equal(c.contextLimit.maxRetries, DEFAULT_CONTEXT_LIMIT.maxRetries);
    assert.equal(c.contextLimit.compactTimeoutSeconds, DEFAULT_CONTEXT_LIMIT.compactTimeoutSeconds);
    assert.equal(c.contextLimit.retryMessage, 'GO ON');   // null default → usageLimitMessage
  });

  it('an explicit retryMessage decouples it from usageLimitMessage', async () => {
    const { default: os } = await import('node:os');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(join(os.tmpdir(), 'car-cfg-'));
    const p = join(dir, 'cfg.json');
    writeFileSync(p, JSON.stringify({ usageLimitMessage: 'GO ON', contextLimit: { retryMessage: 'carry on' } }));
    const c = await loadConfig(p);
    assert.equal(c.contextLimit.retryMessage, 'carry on');
  });
});
