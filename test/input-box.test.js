import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inputBoxDraft } from '../src/patterns.js';
import { DEFAULT_CONFIG, DEFAULT_CONTEXT_LIMIT } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A REAL idle pane captured from Claude Code (flush `❯` prompt row between two rules).
const IDLE_PANE = readFileSync(join(__dirname, 'fixture-idle-pane.txt'), 'utf-8').split('\n');
const PROMPT_IDX = IDLE_PANE.findLastIndex((l) => /^\s*❯/.test(l));   // the input row, not the `❯ /compact` echo above it

// The idle pane with `draft` typed into its input row.
const idleWithDraft = (draft, extraAbove = []) => {
  const lines = [...IDLE_PANE];
  lines[PROMPT_IDX] = `❯ ${draft}`;
  lines.splice(PROMPT_IDX - 2, 0, ...extraAbove);
  return lines.join('\n');
};

// A small synthetic pane in the same shape: content, rule, prompt row, rule, footer.
const box = (content, draft = '') => [...content, '', '─'.repeat(40), draft ? `❯ ${draft}` : '❯ ', '─'.repeat(40), '  ? for shortcuts'].join('\n');

describe('inputBoxDraft', () => {
  it('is null for the real captured idle pane (empty box)', () => {
    assert.equal(inputBoxDraft(IDLE_PANE.join('\n')), null);
  });
  it('returns the text typed into the real pane\'s input row', () => {
    assert.equal(inputBoxDraft(idleWithDraft('fix the flaky test and')), 'fix the flaky test and');
  });
  it('reads the older boxed layout (│ > draft │), which the chrome rules swallow', () => {
    const text = ['● hi', '╭────────╮', '│ > half a thought │', '╰────────╯', '  ? for shortcuts'].join('\n');
    assert.equal(inputBoxDraft(text), 'half a thought');
  });
  it('an empty boxed prompt is not a draft', () => {
    assert.equal(inputBoxDraft(['● hi', '╭────────╮', '│ >          │', '╰────────╯'].join('\n')), null);
  });
  it("Claude Code's own ghost placeholder (Try \"…\") is not a draft", () => {
    assert.equal(inputBoxDraft(box(['● hi'], 'Try "fix typecheck errors"')), null);
  });
  it('is null when no prompt row can be found — unknown layout never reads as occupied', () => {
    assert.equal(inputBoxDraft('● some output\n● more output'), null);
    assert.equal(inputBoxDraft(''), null);
  });
  it('a quoted ">" line that is not at the live bottom is not the input row', () => {
    const text = ['> an old user message echoed in the transcript', '● and the assistant replied with real work', '', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n');
    assert.equal(inputBoxDraft(text), null);
  });
  it('an earlier echoed submission with only blank lines before the empty box is not a draft', () => {
    // The real capture, minus the "compact failed" result line that normally follows the echo.
    const lines = [...IDLE_PANE];
    lines.splice(IDLE_PANE.findIndex((l) => /compact failed/.test(l)), 1);
    assert.equal(inputBoxDraft(lines.join('\n')), null);
  });
  it('ignores ANSI styling around the row', () => {
    assert.equal(inputBoxDraft(box(['● hi']).replace('❯ ', '\x1b[2m❯\x1b[0m draft')), 'draft');
  });
});

// ---------------------------------------------------------------------------------------
// The policy, per family. Default 'send': message goes out and the draft is noted for the log.
// 'wait': nothing is typed, no attempt is consumed, and the hold lifts when the box is empty.
// ---------------------------------------------------------------------------------------
function mockTmux(pane) {
  const t = {
    _sent: [], _pane: pane,
    capturePane: async () => t._pane,
    getPaneCommand: async () => 'node',
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => true,
  };
  return t;
}
const alive = () => true;
const cfg = (whenOccupied) => ({ ...DEFAULT_CONFIG, inputBox: { whenOccupied } });
const NO_JITTER = () => 0.5;

describe('draft policy — usage limit', () => {
  const BANNER = ["⎿ You've hit your session limit · resets 3pm (UTC)"];
  const armed = () => { const s = createMonitorState(); s.status = 'waiting'; s.waitUntil = Date.now() - 1000; return s; };

  it("default ('send') still sends, and records the draft it landed on", async () => {
    const t = mockTmux(box(BANNER, 'my half typed thought'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('send'), alive), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s._overDraft, 'my half typed thought');
  });
  it('an empty box leaves no draft note', async () => {
    const t = mockTmux(box(BANNER));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('send'), alive), 'retried');
    assert.equal(s._overDraft, null);
  });
  it("'wait' holds without typing or consuming an attempt, then sends once the box is empty", async () => {
    const t = mockTmux(box(BANNER, 'my half typed thought'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('wait'), alive), 'draft-held');
    assert.equal(t._sent.length, 0);
    assert.equal(s.attempts, 0);
    assert.ok(s.waitUntil > Date.now(), 'backs off rather than re-checking every poll');
    s.waitUntil = Date.now() - 1000;
    t._pane = box(BANNER);                       // the user cleared it
    assert.equal(await processOneTick(s, t, '%0', cfg('wait'), alive), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s.attempts, 1);
  });
});

describe('draft policy — overload backoff', () => {
  const ERR = ['● API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'];
  const armed = () => { const s = createMonitorState(); s.status = 'overload'; s.overloadWaitUntil = Date.now() - 1000; s.overloadTotalWaitMs = 1000; return s; };

  it("'wait' holds and does not consume an overload attempt", async () => {
    const t = mockTmux(box(ERR, 'draft'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('wait'), alive, NO_JITTER), 'draft-held');
    assert.equal(t._sent.length, 0);
    assert.equal(s.overloadAttempts, 0);
  });
  it("'send' retries over the draft", async () => {
    const t = mockTmux(box(ERR, 'draft'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('send'), alive, NO_JITTER), 'overload-retried');
    assert.equal(s._overDraft, 'draft');
  });
  it("'wait' also holds the event-driven (StopFailure) retry", async () => {
    const t = mockTmux(box(['● hi'], 'draft'));
    const s = createMonitorState();
    s.status = 'overload'; s.viaEvent = true; s.overloadWaitUntil = Date.now() - 1000;
    assert.equal(await processOneTick(s, t, '%0', cfg('wait'), alive, NO_JITTER), 'draft-held');
    assert.equal(t._sent.length, 0);
    assert.equal(s.viaEvent, true, 'the incident is still open; the send is only postponed');
  });
});

describe('draft policy — safeguard retry', () => {
  const FLAG = ['● API Error: Fable 5\'s safeguards flagged this message (https://x/legal/aup).'];
  const armed = () => { const s = createMonitorState(); s.status = 'safeguard'; s.safeguardWaitUntil = Date.now() - 1000; return s; };
  it("'wait' holds without consuming a retry", async () => {
    const t = mockTmux(box(FLAG, 'draft'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('wait'), alive), 'draft-held');
    assert.equal(s.safeguardAttempts, 0);
    assert.equal(t._sent.length, 0);
  });
  it("'send' retries over the draft", async () => {
    const t = mockTmux(box(FLAG, 'draft'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', cfg('send'), alive), 'safeguard-retried');
  });
});

describe('draft policy — context-limit compaction', () => {
  const ROW = 'Context limit reached · /compact or /clear to continue';
  const withRow = (draft) => {
    const lines = idleWithDraft(draft).split('\n');
    lines.splice(lines.length - 2, 0, ROW);
    return lines.join('\n');
  };
  const c = (whenOccupied) => ({ ...DEFAULT_CONFIG, inputBox: { whenOccupied }, contextLimit: { ...DEFAULT_CONTEXT_LIMIT, retryMessage: 'RESUME' } });
  const armed = () => { const s = createMonitorState(); s.status = 'context'; s.contextWaitUntil = Date.now() - 1000; return s; };

  it("'wait' will not type /compact into a draft (it would not run as a command anyway)", async () => {
    const t = mockTmux(withRow('half a prompt'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', c('wait'), alive), 'draft-held');
    assert.equal(t._sent.length, 0);
    assert.equal(s.contextAttempts, 0);
  });
  it("'wait' holds the post-compaction continuation too", async () => {
    const t = mockTmux(idleWithDraft('half a prompt'));       // row gone: compaction landed
    const s = armed(); s._contextCompactSentAt = Date.now() - 5000;
    assert.equal(await processOneTick(s, t, '%0', c('wait'), alive), 'draft-held');
    assert.equal(t._sent.length, 0);
    assert.ok(s._contextCompactSentAt, 'still primed to resume once the box is clear');
  });
  it("'send' compacts as before", async () => {
    const t = mockTmux(withRow('half a prompt'));
    const s = armed();
    assert.equal(await processOneTick(s, t, '%0', c('send'), alive), 'context-compacting');
    assert.deepEqual(t._sent, ['/compact']);
  });
});

describe('overload give-up is announced once', () => {
  it('returns overload-gave-up the first time and overload-holding after (no per-minute log spam)', async () => {
    const t = mockTmux(box(['● API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}']));
    const s = createMonitorState();
    s.status = 'overload';
    s.overloadTotalWaitMs = DEFAULT_CONFIG.overload.maxTotalWaitMinutes * 60_000;
    s.overloadWaitUntil = Date.now() - 1000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive, NO_JITTER), 'overload-gave-up');
    s.overloadWaitUntil = Date.now() - 1000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive, NO_JITTER), 'overload-holding');
    s.overloadWaitUntil = Date.now() - 1000;
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive, NO_JITTER), 'overload-holding');
    assert.equal(s._gaveUp, true, 'still flagged as given up for the status readers');
  });
});
