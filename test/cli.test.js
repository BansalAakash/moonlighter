import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { injectWrapper, removeWrapper, MARKER_START, MARKER_END, renderReconcileUnit, renderReconcilePlist, escapeForDoubleQuotes, injectFishWrapper, removeFishWrapper, fishWrapperPath, shellQuote, stopFailureHookEntry } from '../bin/cli.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Finding 7: the generated systemd unit was fragile — unquoted ExecStart paths broke
//     on spaces, and Persistent=true is a no-op on a monotonic (OnUnitActiveSec) timer. ---
describe('renderReconcileUnit (Finding 7)', () => {
  it('substitutes into the quoted ExecStart so a path with spaces survives', () => {
    const out = renderReconcileUnit(
      'ExecStart="__NODE_PATH__" "__CLI_PATH__" reconcile\n',
      '/home/a b/.nvm/node', '/home/a b/cli.js',
    );
    assert.match(out, /ExecStart="\/home\/a b\/\.nvm\/node" "\/home\/a b\/cli\.js" reconcile/);
    assert.ok(!out.includes('__NODE_PATH__') && !out.includes('__CLI_PATH__'));
  });
  it('the shipped .service template quotes the ExecStart placeholders', async () => {
    const svc = await readFile(join(REPO_ROOT, 'systemd', 'claude-auto-retry-reconcile.service'), 'utf-8');
    assert.match(svc, /ExecStart="__NODE_PATH__" "__CLI_PATH__" reconcile/);
  });
  it('the shipped .timer template has no no-op Persistent=true', async () => {
    const timer = await readFile(join(REPO_ROOT, 'systemd', 'claude-auto-retry-reconcile.timer'), 'utf-8');
    assert.ok(!/Persistent\s*=\s*true/.test(timer));
  });
});

describe('renderReconcilePlist (macOS launchd)', () => {
  it('substitutes and XML-escapes the node/CLI paths', () => {
    const out = renderReconcilePlist(
      '<string>__NODE_PATH__</string><string>__CLI_PATH__</string>',
      '/Users/a&b/.nvm/node', '/Users/a<b>/cli.js',
    );
    assert.equal(out, '<string>/Users/a&amp;b/.nvm/node</string><string>/Users/a&lt;b&gt;/cli.js</string>');
    assert.ok(!out.includes('__NODE_PATH__') && !out.includes('__CLI_PATH__'));
  });
  it('the shipped plist template has the placeholders and detaches monitors from the job', async () => {
    const plist = await readFile(join(REPO_ROOT, 'launchd', 'com.claude-auto-retry.reconcile.plist'), 'utf-8');
    assert.match(plist, /<string>__NODE_PATH__<\/string>\s*<string>__CLI_PATH__<\/string>\s*<string>reconcile<\/string>/);
    // Same reason the systemd unit needs KillMode=process: without it the short-lived
    // reconcile job's exit reaps the freshly-armed detached monitors.
    assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  });
  it('the shipped plist sets a PATH that reaches a Homebrew tmux', async () => {
    // launchd jobs get only the system default PATH; without both Homebrew prefixes
    // reconcile dies with `spawn tmux ENOENT` on every timer fire.
    const plist = await readFile(join(REPO_ROOT, 'launchd', 'com.claude-auto-retry.reconcile.plist'), 'utf-8');
    assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*\/usr\/local\/bin[^<]*<\/string>/);
  });
});

describe('package.json files whitelist (Finding 1)', () => {
  it('includes systemd/ so install-timer works from an npm install', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('systemd/'), 'package.json "files" must include "systemd/"');
  });
  it('includes launchd/ so install-timer works from an npm install on macOS', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.files.includes('launchd/'), 'package.json "files" must include "launchd/"');
  });
});

describe('injectWrapper', () => {
  const testFile = join(tmpdir(), `car-rc-test-${Date.now()}`);
  afterEach(async () => { try { await unlink(testFile); } catch {} });

  it('adds wrapper to empty file', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes('/path/to/launcher.js'));
  });
  it('unaliases claude before defining the wrapper function (#10)', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    const unaliasIdx = content.indexOf('unalias claude');
    const fnIdx = content.indexOf('\nclaude() {');
    assert.ok(unaliasIdx !== -1, 'wrapper should unalias claude');
    assert.ok(unaliasIdx < fnIdx, 'unalias must come before the function definition');
  });
  it('adds wrapper to file with existing content', async () => {
    await writeFile(testFile, 'export PATH=$HOME/bin:$PATH\n');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('export PATH'));
    assert.ok(content.includes(MARKER_START));
  });
  it('replaces existing wrapper', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nold stuff\n${MARKER_END}\nafter\n`);
    await injectWrapper(testFile, '/new/path/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('/new/path'));
    assert.ok(!content.includes('old stuff'));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
});

describe('removeWrapper', () => {
  const testFile = join(tmpdir(), `car-rm-test-${Date.now()}`);
  afterEach(async () => { try { await unlink(testFile); } catch {} });

  it('removes wrapper and preserves surrounding content', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nwrapper stuff\n${MARKER_END}\nafter\n`);
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.ok(!content.includes(MARKER_START));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
  it('does nothing when no wrapper present', async () => {
    await writeFile(testFile, 'just normal content\n');
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.equal(content, 'just normal content\n');
  });
});

// --- Paths are spliced into generated shell code / unit files. `$&` and friends in a
//     replacement STRING are String.replace patterns, and `$` / backtick / quote are live
//     inside the double quotes the launcher path sits in. ---
describe('escapeForDoubleQuotes', () => {
  it('escapes the characters that are live inside double quotes', () => {
    assert.equal(escapeForDoubleQuotes('/a b/$HOME/`x`/"q"/\\z'), '/a b/\\$HOME/\\`x\\`/\\"q\\"/\\\\z');
  });
  it('leaves an ordinary path alone', () => assert.equal(escapeForDoubleQuotes('/Users/a/moonlighter/src/launcher.js'), '/Users/a/moonlighter/src/launcher.js'));
});

describe('wrapper substitution is literal', () => {
  const rc = join(tmpdir(), `car-subst-${Date.now()}`);
  afterEach(async () => { try { await unlink(rc); } catch {} });
  it("a launcher path containing $& / $' survives intact (escaped for the shell)", async () => {
    await writeFile(rc, '');
    await injectWrapper(rc, "/odd/$&/it's/launcher.js");
    const content = await readFile(rc, 'utf-8');
    assert.ok(content.includes("\\$&/it's/launcher.js"), content);
    assert.ok(!content.includes('__LAUNCHER_PATH__'));
  });
  it('the unit and plist renderers do not interpret $-patterns in paths either', () => {
    assert.equal(renderReconcileUnit('"__NODE_PATH__" "__CLI_PATH__"', '/n/$&', '/c/$1'), '"/n/$&" "/c/$1"');
    assert.equal(renderReconcilePlist('<s>__NODE_PATH__</s><s>__CLI_PATH__</s>', '/n/$&', '/c/$1'), '<s>/n/$&amp;</s><s>/c/$1</s>');
  });
});

describe('fish wrapper', () => {
  let dir;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });
  const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'car-fish-')); return join(dir, 'fish', 'functions', 'claude.fish'); };

  it('is written under XDG_CONFIG_HOME when set, else ~/.config', () => {
    assert.equal(fishWrapperPath({ XDG_CONFIG_HOME: '/x' }), '/x/fish/functions/claude.fish');
    assert.match(fishWrapperPath({}), /\.config\/fish\/functions\/claude\.fish$/);
  });
  it('writes a marked claude function that scopes the env var to one command', async () => {
    const file = await fresh();
    assert.equal(await injectFishWrapper(file, '/p/launcher.js'), 'written');
    const text = await readFile(file, 'utf-8');
    assert.ok(text.includes(MARKER_START) && text.includes(MARKER_END));
    assert.match(text, /function claude/);
    assert.match(text, /env CLAUDE_AUTO_RETRY_ACTIVE=1 node "\/p\/launcher\.js" \$argv/);
    assert.match(text, /command claude \$argv/);   // degrade path
    assert.ok(!text.includes('__LAUNCHER_PATH__'));
  });
  it('is idempotent and updates the launcher path', async () => {
    const file = await fresh();
    await injectFishWrapper(file, '/old/launcher.js');
    assert.equal(await injectFishWrapper(file, '/new/launcher.js'), 'written');
    const text = await readFile(file, 'utf-8');
    assert.ok(text.includes('/new/launcher.js') && !text.includes('/old/launcher.js'));
  });
  it("never overwrites a claude.fish that is not ours", async () => {
    const file = await fresh();
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'function claude\n  echo mine\nend\n');
    assert.equal(await injectFishWrapper(file, '/p/launcher.js'), 'foreign');
    assert.equal(await readFile(file, 'utf-8'), 'function claude\n  echo mine\nend\n');
  });
  it('removes only its own file', async () => {
    const file = await fresh();
    assert.equal(await removeFishWrapper(file), 'absent');
    await injectFishWrapper(file, '/p/launcher.js');
    assert.equal(await removeFishWrapper(file), 'removed');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'function claude\nend\n');
    assert.equal(await removeFishWrapper(file), 'foreign');
    assert.equal(await readFile(file, 'utf-8'), 'function claude\nend\n');
  });
  it('escapes a launcher path for fish double quotes', async () => {
    const file = await fresh();
    await injectFishWrapper(file, '/odd/$HOME/"x"/launcher.js');
    assert.ok((await readFile(file, 'utf-8')).includes('"/odd/\\$HOME/\\"x\\"/launcher.js"'));
  });
});

describe('StopFailure hook command (quoting)', () => {
  it('shellQuote single-quotes and escapes embedded single quotes', () => {
    assert.equal(shellQuote('/a b/c'), "'/a b/c'");
    assert.equal(shellQuote("/it's"), "'/it'\\''s'");
  });
  it('the hook command survives a checkout path with spaces and quotes', () => {
    const cmd = stopFailureHookEntry("/Users/a b/it's/bin/cli.js").hooks[0].command;
    assert.equal(cmd, "node '/Users/a b/it'\\''s/bin/cli.js' _stopfailure-hook");
  });
  it('still carries the marker install-hook uses to find and replace its own entry', () => {
    assert.ok(JSON.stringify(stopFailureHookEntry()).includes('_stopfailure-hook'));
  });
});
