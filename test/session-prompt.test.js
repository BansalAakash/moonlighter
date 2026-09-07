import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionPrompt, sessionPromptFile, normalize } from '../src/session-prompt.js';
import { DEFAULT_CONFIG, DEFAULT_CONTEXT_LIMIT } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'car-prompts-')); mkdirSync(dir, { recursive: true }); });

function write(pane, pid, text) {
  writeFileSync(sessionPromptFile(pane, pid, dir), text);
}

describe('normalize', () => {
  it('collapses a wrapped paragraph to one line', () => {
    // The retry is `send-keys -l <text>` + a separate Enter, so an embedded newline would
    // submit early and type the remainder into the next prompt.
    assert.equal(normalize("Carry on with the\nrefactor, then\n\nrun the tests."),
                 "Carry on with the refactor, then run the tests.");
  });
  it('trims and collapses runs of whitespace', () =>
    assert.equal(normalize("  keep   going  \n"), "keep going"));
});

describe('readSessionPrompt', () => {
  it('returns null when there is no override', async () =>
    assert.equal(await readSessionPrompt('%1', 4242, dir), null));

  it('reads an override for the right pane+pid', async () => {
    write('%1', 4242, 'Resume the PixCut driver work.');
    assert.equal(await readSessionPrompt('%1', 4242, dir), 'Resume the PixCut driver work.');
  });

  it('does NOT leak to another pane', async () =>
    assert.equal(await readSessionPrompt('%2', 4242, dir), null));

  it('does NOT survive the claude PID changing — the reuse guard', async () => {
    // The whole point of keying on the pid: a new session in the same pane must not inherit
    // an instruction written for the one before it.
    assert.equal(await readSessionPrompt('%1', 9999, dir), null);
  });

  it('treats an emptied file as "no override" rather than "send nothing"', async () => {
    write('%3', 1, '   \n\n  ');
    assert.equal(await readSessionPrompt('%3', 1, dir), null);
  });

  it('needs both a pane and a pid', async () => {
    assert.equal(await readSessionPrompt(null, 4242, dir), null);
    assert.equal(await readSessionPrompt('%1', null, dir), null);
  });
});

// --- the monitor actually using it ---

function mockTmux(pane, override) {
  const t = {
    _sent: [],
    _pane: '',
    capturePane: async () => t._pane,
    getPaneCommand: async () => 'node',
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => true,
    readSessionPrompt: async () => override,
  };
  return t;
}

const LIMITED = [
  "⚠ You've hit your session limit",
  '· resets 2am (Europe/Zurich)',
  '❯ ',
].join('\n');

function cfg(over = {}) {
  return {
    ...DEFAULT_CONFIG,
    usageLimitMessage: 'GLOBAL PROMPT',
    contextLimit: { ...DEFAULT_CONTEXT_LIMIT, retryMessage: 'GLOBAL PROMPT' },
    ...over,
  };
}

describe('processOneTick — the override reaches the pane', () => {
  it('sends the global message when there is no override', async () => {
    const s = createMonitorState();
    const t = mockTmux('%1', null);
    t._pane = LIMITED;
    await processOneTick(s, t, '%1', cfg(), () => true);   // detect → waiting
    s.waitUntil = 0;
    await processOneTick(s, t, '%1', cfg(), () => true);   // expiry → retry
    assert.deepEqual(t._sent, ['GLOBAL PROMPT']);
  });

  it('sends the override instead, when this session has one', async () => {
    const s = createMonitorState();
    const t = mockTmux('%1', 'JUST THIS SESSION');
    t._pane = LIMITED;
    await processOneTick(s, t, '%1', cfg(), () => true);
    s.waitUntil = 0;
    await processOneTick(s, t, '%1', cfg(), () => true);
    assert.deepEqual(t._sent, ['JUST THIS SESSION']);
  });

  it('uses the same override after a compaction — one instruction per session, not two', async () => {
    // A session carrying its own prompt for the usage-limit path but the global prompt for the
    // post-compaction path would be incoherent; both are "pick the work back up".
    const s = createMonitorState();
    const t = mockTmux('%1', 'JUST THIS SESSION');
    const c = cfg({ contextLimit: { ...DEFAULT_CONTEXT_LIMIT, retryMessage: 'GLOBAL PROMPT', retryDelaySeconds: 0 } });
    const ROW = 'Context limit reached · /compact or /clear to continue';
    t._pane = ['⏺ done', '❯ ', ROW, '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(await processOneTick(s, t, '%1', c, () => true), 'context-detected');
    s.contextWaitUntil = 0;
    assert.equal(await processOneTick(s, t, '%1', c, () => true), 'context-compacting');
    s.contextWaitUntil = 0;
    t._pane = ['⏺ done', '❯ ', '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(await processOneTick(s, t, '%1', c, () => true), 'context-resumed');
    assert.deepEqual(t._sent, ['/compact', 'JUST THIS SESSION']);
  });

  it('an adapter with no override support still works (back-compat)', async () => {
    const s = createMonitorState();
    const t = mockTmux('%1', null);
    delete t.readSessionPrompt;
    t._pane = LIMITED;
    await processOneTick(s, t, '%1', cfg(), () => true);
    s.waitUntil = 0;
    await processOneTick(s, t, '%1', cfg(), () => true);
    assert.deepEqual(t._sent, ['GLOBAL PROMPT']);
  });
});
