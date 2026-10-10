import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptSignature } from '../src/patterns.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createMonitorState, processOneTick } from '../src/monitor.js';

// The morning this was found: the session hit its limit, Claude Code showed a banner BELOW the input
// box, Claude wrote its wrap-up and stopped. At the reset Claude Code removed the banner by itself.
// The monitor read "banner gone" as "the user carried on" and sent nothing, leaving the session idle.

const TRANSCRIPT = [
  '⏺ Plan: updates will ship compiled files.',
  '  Ran 3 shell commands, wrote 1 memory',
  '⏺ Your usage limit was reached, so I stopped before changing any code.',
  '  Just say "continue" next session.',
  '✻ Churned for 1m 59s · done 9:31 AM',
];
const box = (draft = '') => ['', '─'.repeat(60), draft ? `❯ ${draft}` : '❯ ', '─'.repeat(60), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const BANNER = '  ⚠ Usage limit reached · limit resets 3pm (UTC) · /upgrade to keep using Claude Code';
const pane = (...parts) => parts.flat().join('\n');

function mockTmux(content) {
  const t = {
    _sent: [], _pane: content,
    capturePane: async () => t._pane,
    getPaneCommand: async () => 'node',
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async () => {},
    isClaudeForeground: async () => true,
  };
  return t;
}
const alive = () => true;

describe('transcriptSignature', () => {
  it('is unchanged when the banner appears or disappears', () => {
    assert.equal(transcriptSignature(pane(TRANSCRIPT, box(), BANNER)), transcriptSignature(pane(TRANSCRIPT, box())));
  });
  it('ignores a half-typed draft in the input box', () => {
    assert.equal(transcriptSignature(pane(TRANSCRIPT, box('write the steps for my colleague'))), transcriptSignature(pane(TRANSCRIPT, box())));
  });
  it('ignores the footer and the spinner summary', () => {
    const a = pane(TRANSCRIPT, box());
    const b = pane(TRANSCRIPT.slice(0, -1), ['✻ Worked for 5m'], box());
    assert.equal(transcriptSignature(a), transcriptSignature(b));
  });
  it('changes when the conversation moves on', () => {
    const later = pane(TRANSCRIPT, ['❯ continue', '⏺ Picking this back up.'], box());
    assert.notEqual(transcriptSignature(later), transcriptSignature(pane(TRANSCRIPT, box())));
  });
  it('also works on the older layout, where the banner sits in the transcript above the box', () => {
    const old = [...TRANSCRIPT, "⎿ You've hit your session limit · resets 3pm (UTC)", ...box()];
    assert.equal(transcriptSignature(pane(old)), transcriptSignature(pane(TRANSCRIPT, box())));
  });
});

describe('a wait that ends with the banner gone', () => {
  const startWait = async () => {
    const t = mockTmux(pane(TRANSCRIPT, box(), BANNER));
    const s = createMonitorState();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'waiting');
    s.waitUntil = Date.now() - 1000;                      // the reset has come
    return { t, s };
  };

  it('sends the resume message when the banner cleared itself and the session is idle (the bug)', async () => {
    const { t, s } = await startWait();
    t._pane = pane(TRANSCRIPT, box());                    // banner gone, nothing else changed
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'retried');
    assert.equal(t._sent.length, 1);
    assert.equal(s._sendingAfterBannerGone, true);
  });
  it('a draft the user is typing does not make it look like they continued', async () => {
    const { t, s } = await startWait();
    t._pane = pane(TRANSCRIPT, box('write the steps for my colleague'));
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'retried');
  });
  it('stands down when the user carried on: new conversation below the old one', async () => {
    const { t, s } = await startWait();
    t._pane = pane(TRANSCRIPT, ['❯ continue please', '⏺ Picking this back up — reading the plan.'], box());
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'user-continued');
    assert.equal(t._sent.length, 0);
  });
  it('stands down when Claude is mid-turn', async () => {
    const { t, s } = await startWait();
    t._pane = pane(TRANSCRIPT, ['✻ Cogitating… (esc to interrupt)'], box());
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'user-continued');
    assert.equal(t._sent.length, 0);
  });
  it('still sends when the banner is still showing (the original behaviour)', async () => {
    const { t, s } = await startWait();
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'retried');
  });
  it('does not type over a draft when inputBox.whenOccupied is "wait"', async () => {
    const { t, s } = await startWait();
    t._pane = pane(TRANSCRIPT, box('half a thought'));
    const cfg = { ...DEFAULT_CONFIG, inputBox: { whenOccupied: 'wait' } };
    assert.equal(await processOneTick(s, t, '%0', cfg, alive), 'draft-held');
    assert.equal(t._sent.length, 0);
  });
  it('a wait that began with no conversation to fingerprint cannot be mistaken for idle', async () => {
    const t = mockTmux(BANNER);                           // nothing but the banner
    const s = createMonitorState();
    await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive);
    s.waitUntil = Date.now() - 1000;
    t._pane = '';
    assert.equal(await processOneTick(s, t, '%0', DEFAULT_CONFIG, alive), 'user-continued');
  });
});
