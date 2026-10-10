import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  appBundleRoot, bundledNodePath, pathWithHomebrew, renderReconcilePlist, renderWatchdogPlist,
  runSetup, runUninstallAll, shimPath, findTmux,
} from '../src/setup.js';
import { injectWrapper, MARKER_START } from '../src/shell-wrapper.js';

describe('appBundleRoot / bundledNodePath', () => {
  it('finds the .app that contains the package', () => {
    assert.equal(appBundleRoot('/Applications/Moonlighter.app/Contents/Resources/moonlighter'), '/Applications/Moonlighter.app');
    assert.equal(appBundleRoot('/Users/a/My Apps/Moonlighter.app/Contents/Resources/moonlighter'), '/Users/a/My Apps/Moonlighter.app');
  });
  it('is null for a source checkout', () => {
    assert.equal(appBundleRoot('/Users/a/code/moonlighter'), null);
    assert.equal(appBundleRoot('/Users/a/thing.app-stuff/moonlighter'), null);
  });
  it('the shipped node lives under Resources/runtime', () => {
    assert.equal(bundledNodePath('/Applications/Moonlighter.app'), '/Applications/Moonlighter.app/Contents/Resources/runtime/node');
  });
});

describe('pathWithHomebrew', () => {
  it('adds the Homebrew prefixes a GUI app does not inherit, without duplicating them', () => {
    assert.equal(pathWithHomebrew({ PATH: '/usr/bin:/bin' }), '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
    assert.equal(pathWithHomebrew({ PATH: '/usr/local/bin:/usr/bin' }), '/opt/homebrew/bin:/usr/local/bin:/usr/bin');
    assert.equal(pathWithHomebrew({}), '/opt/homebrew/bin:/usr/local/bin');
  });
});

describe('plist renderers', () => {
  it('substitute and XML-escape, treating $-sequences in paths literally', () => {
    assert.equal(renderReconcilePlist('<s>__NODE_PATH__</s><s>__CLI_PATH__</s>', '/a&b/$&', '/c<d>'), '<s>/a&amp;b/$&amp;</s><s>/c&lt;d&gt;</s>');
    assert.equal(renderWatchdogPlist('<s>__SCRIPT_PATH__</s><s>__APP_PATH__</s>', '/s h', '/Apps/My & App.app'), '<s>/s h</s><s>/Apps/My &amp; App.app</s>');
  });
  it('the shipped plist templates carry the placeholders', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'launchd');
    assert.match(await readFile(join(root, 'com.moonlighter.watchdog.plist'), 'utf-8'), /__SCRIPT_PATH__[\s\S]*__APP_PATH__/);
    assert.match(await readFile(join(root, 'com.claude-auto-retry.reconcile.plist'), 'utf-8'), /__NODE_PATH__[\s\S]*__CLI_PATH__/);
  });
});

describe('wrapper pins the shipped node', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'car-pin-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it('writes an absolute node into both branches; a plain install keeps `node`', async () => {
    const pinned = join(dir, 'pinned'); const plain = join(dir, 'plain');
    await injectWrapper(pinned, '/App/launcher.js', '/App/runtime/node');
    await injectWrapper(plain, '/p/launcher.js');
    const t = await readFile(pinned, 'utf-8');
    assert.equal(t.match(/"\/App\/runtime\/node" "\/App\/launcher\.js"/g).length, 2, 'zsh and bash branches');
    assert.ok(!/\bnode "\/App/.test(t.replace(/runtime\/node/g, '')), 'no bare `node` left');
    assert.match(await readFile(plain, 'utf-8'), /\bnode "\/p\/launcher\.js"/);
  });
  it('reports unchanged, and does not rewrite, when nothing differs', async () => {
    const rc = join(dir, 'rc');
    assert.equal(await injectWrapper(rc, '/App/launcher.js', '/App/runtime/node'), 'written');
    const before = (await stat(rc)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await injectWrapper(rc, '/App/launcher.js', '/App/runtime/node'), 'unchanged');
    assert.equal((await stat(rc)).mtimeMs, before);
    assert.equal(await injectWrapper(rc, '/App/launcher.js', '/Other/node'), 'written');
  });
});

describe('runSetup (sandboxed HOME, launchd skipped)', () => {
  let home; let saved;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'car-setup-'));
    saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, XDG: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home; process.env.SHELL = '/bin/zsh';
    // CI runners set this, which would send the fish function outside the sandboxed home.
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(async () => {
    process.env.HOME = saved.HOME; process.env.SHELL = saved.SHELL;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG;
    await rm(home, { recursive: true, force: true });
  });
  const APP = '/Applications/Moonlighter.app';
  const opts = (extra = {}) => ({ appRoot: APP, launcherPath: `${APP}/Contents/Resources/moonlighter/src/launcher.js`, cliPath: `${APP}/Contents/Resources/moonlighter/bin/cli.js`, skipLaunchd: true, ...extra });
  const step = (r, name) => r.steps.find((s) => s.name === name);

  it('installs the shell function, pinned to the shipped node, and the command shim', async () => {
    const r = await runSetup(opts());
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    const zshrc = await readFile(join(home, '.zshrc'), 'utf-8');
    assert.ok(zshrc.includes(MARKER_START));
    assert.ok(zshrc.includes(`"${APP}/Contents/Resources/runtime/node" "${APP}/Contents/Resources/moonlighter/src/launcher.js"`));
    const shim = await readFile(shimPath(), 'utf-8');
    assert.match(shim, /exec '.*\/runtime\/node' '.*\/bin\/cli\.js' "\$@"/);
    assert.ok(((await stat(shimPath())).mode & 0o111) !== 0, 'the shim is executable');
    assert.equal(r.nodePath, `${APP}/Contents/Resources/runtime/node`);
  });
  it('is idempotent: the second run changes nothing', async () => {
    await runSetup(opts());
    const r = await runSetup(opts());
    assert.equal(step(r, 'shell-functions').changed, false);
    assert.equal(step(r, 'command').changed, false);
  });
  it('never invents a ~/.bashrc for a fish user, and writes the fish function', async () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    const r = await runSetup(opts());
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    assert.ok((await readFile(join(home, '.config', 'fish', 'functions', 'claude.fish'), 'utf-8')).includes('runtime/node'));
    await assert.rejects(stat(join(home, '.bashrc')));
  });
  it("reports (does not hide) a claude.fish that is not Moonlighter's", async () => {
    process.env.SHELL = '/opt/homebrew/bin/fish';
    await mkdir(join(home, '.config', 'fish', 'functions'), { recursive: true });
    await writeFile(join(home, '.config', 'fish', 'functions', 'claude.fish'), 'function claude; echo mine; end\n');
    const r = await runSetup(opts());
    assert.equal(step(r, 'shell-functions').ok, false);
    assert.match(step(r, 'shell-functions').detail, /not Moonlighter's/);
  });
  it('from a source checkout (no bundle) it pins nothing and installs no shim', async () => {
    const r = await runSetup(opts({ appRoot: null }));
    assert.equal(step(r, 'command'), undefined);
    assert.ok(!(await readFile(join(home, '.zshrc'), 'utf-8')).includes('runtime/node'));
  });
  it('reports tmux in the result', async () => {
    const r = await runSetup(opts());
    assert.equal(typeof r.tmux.found, 'boolean');
    assert.deepEqual(Object.keys(findTmux()).sort(), ['found', 'supported', 'version']);
  });
  it('uninstall --all removes what setup installed, and leaves the user content', async () => {
    await writeFile(join(home, '.zshrc'), 'export FOO=1\n');
    await runSetup(opts());
    const r = await runUninstallAll({ skipLaunchd: true });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    const zshrc = await readFile(join(home, '.zshrc'), 'utf-8');
    assert.ok(!zshrc.includes(MARKER_START));
    assert.ok(zshrc.includes('export FOO=1'));
    await assert.rejects(stat(shimPath()));
  });
});
