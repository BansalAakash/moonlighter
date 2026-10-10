// First-run setup (and its inverse) for the packaged app.
//
// The app bundle carries this package and its own Node, so there is nothing to `npm link` and no
// `node` that can be assumed on PATH. Setup wires the bundle into the machine: the `claude` shell
// function, the repair timer, the menu bar watchdog and a `claude-auto-retry` command. Every step
// is IDEMPOTENT and reports "unchanged" without touching anything when there is nothing to do —
// the app runs this on every launch, so it must not keep rewriting rc files or bouncing launchd
// jobs.
//
// Nothing here prompts or exits: results come back as data (see bin/cli.js `setup --json`), which
// is how the menu bar app learns that tmux is missing.

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, unlink, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  injectWrapper, removeWrapper, fishWrapperPath, injectFishWrapper, removeFishWrapper,
} from './shell-wrapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));          // …/src
export const PKG_ROOT = join(HERE, '..');
export const LAUNCHER_PATH = join(HERE, 'launcher.js');
export const CLI_PATH = join(PKG_ROOT, 'bin', 'cli.js');

export const RECONCILE_LABEL = 'com.claude-auto-retry.reconcile';
export const WATCHDOG_LABEL = 'com.moonlighter.watchdog';
// Earlier builds of the app used this label for the same job; migrated away on setup.
const LEGACY_WATCHDOG_LABEL = 'com.moonlighter.autoretrybar.watchdog';

// `<App>.app/Contents/Resources/moonlighter` is where this package sits inside the bundle.
export function appBundleRoot(dir = PKG_ROOT) {
  const m = dir.match(/^(.*?\.app)\/Contents\/Resources\//);
  return m ? m[1] : null;
}

export function bundledNodePath(appRoot) {
  return join(appRoot, 'Contents', 'Resources', 'runtime', 'node');
}

export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// String.replace treats `$&` etc. in a replacement STRING as patterns; paths may contain them.
export function renderReconcilePlist(template, nodePath, cliPath) {
  return template
    .replace(/__NODE_PATH__/g, () => xmlEscape(nodePath))
    .replace(/__CLI_PATH__/g, () => xmlEscape(cliPath));
}

export function renderWatchdogPlist(template, scriptPath, appPath) {
  return template
    .replace(/__SCRIPT_PATH__/g, () => xmlEscape(scriptPath))
    .replace(/__APP_PATH__/g, () => xmlEscape(appPath));
}

// GUI-launched processes get launchd's PATH (/usr/bin:/bin:…), which has no Homebrew — so a tmux
// installed there is invisible unless the usual prefixes are added back.
export function pathWithHomebrew(env = process.env) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  const have = (env.PATH || '').split(':').filter(Boolean);
  return [...extra.filter((p) => !have.includes(p)), ...have].join(':');
}

export function findTmux(env = process.env) {
  try {
    const out = execFileSync('tmux', ['-V'], {
      encoding: 'utf-8', env: { ...env, PATH: pathWithHomebrew(env) }, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = out.match(/tmux\s+(\d+\.\d+)/);
    const version = m ? parseFloat(m[1]) : 0;
    return { found: true, version: out, supported: version === 0 || version >= 2.1 };
  } catch {
    return { found: false, version: null, supported: false };
  }
}

// --- launchd -----------------------------------------------------------------------------------

function launchAgentsDir() { return join(homedir(), 'Library', 'LaunchAgents'); }
function guiDomain() { return `gui/${process.getuid()}`; }

function agentLoaded(label) {
  try { execFileSync('launchctl', ['print', `${guiDomain()}/${label}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// → 'unchanged' | 'installed'. Throws if launchctl refuses the plist.
export async function installAgent(label, content) {
  const plistPath = join(launchAgentsDir(), `${label}.plist`);
  let existing = null;
  try { existing = await readFile(plistPath, 'utf-8'); } catch { /* absent */ }
  if (existing === content && agentLoaded(label)) return 'unchanged';
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, content);
  // bootstrap fails on an already-loaded label; bootout of an absent one fails too — both fine.
  try { execFileSync('launchctl', ['bootout', `${guiDomain()}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  execFileSync('launchctl', ['bootstrap', guiDomain(), plistPath], { stdio: 'pipe' });
  return 'installed';
}

export async function removeAgent(label) {
  try { execFileSync('launchctl', ['bootout', `${guiDomain()}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  try { await unlink(join(launchAgentsDir(), `${label}.plist`)); return 'removed'; } catch { return 'absent'; }
}

// --- the shell functions ------------------------------------------------------------------------

// Which rc files get the function: bash/zsh if present or the login shell, fish if it is the login
// shell or a fish config directory exists. Never invents a ~/.bashrc for a fish user.
export async function installShellFunctions({ launcherPath, nodePath = null, env = process.env }) {
  const shell = env.SHELL || '/bin/bash';
  const fishFile = fishWrapperPath(env);
  const useFish = shell.includes('fish') || existsSync(dirname(dirname(fishFile)));
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');
  const rcFiles = [];
  if (existsSync(bashrc) || shell.includes('bash')) rcFiles.push(bashrc);
  if (existsSync(zshrc) || shell.includes('zsh')) rcFiles.push(zshrc);
  if (rcFiles.length === 0 && !useFish) rcFiles.push(bashrc);

  const files = [];
  for (const rc of rcFiles) files.push({ file: rc, result: await injectWrapper(rc, launcherPath, nodePath) });
  if (useFish) files.push({ file: fishFile, result: await injectFishWrapper(fishFile, launcherPath, nodePath) });
  return files;
}

// --- the claude-auto-retry command ---------------------------------------------------------------

export function shimPath() { return join(homedir(), '.local', 'bin', 'claude-auto-retry'); }

export async function installShim(nodePath, cliPath) {
  const file = shimPath();
  const text = `#!/bin/sh\n# Installed by Moonlighter. Runs the copy of claude-auto-retry inside the app.\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`;
  try { if (await readFile(file, 'utf-8') === text) return 'unchanged'; } catch { /* absent */ }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  await chmod(file, 0o755);
  return 'written';
}

// --- setup ----------------------------------------------------------------------------------------

// Wire the package into this machine. `appRoot` is the .app that contains it (null when run from a
// source checkout, where the user's own node is used and no shim/watchdog is installed).
export async function runSetup({
  appRoot = appBundleRoot(),
  launcherPath = LAUNCHER_PATH,
  cliPath = CLI_PATH,
  skipLaunchd = false,
  env = process.env,
} = {}) {
  const nodePath = appRoot ? bundledNodePath(appRoot) : null;   // pinned only when we ship the node
  const reconcileNode = nodePath || process.execPath;
  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ name, ok: true, ...(await fn()) }); }
    catch (err) { steps.push({ name, ok: false, detail: String(err && err.message || err).split('\n')[0] }); }
  };

  await step('shell-functions', async () => {
    const files = await installShellFunctions({ launcherPath, nodePath, env });
    const foreign = files.filter((f) => f.result === 'foreign');
    return {
      detail: files.map((f) => `${f.file}: ${f.result}`).join('; '),
      changed: files.some((f) => f.result === 'written'),
      // A claude.fish that is not ours is left alone, and then fish users are not covered.
      ...(foreign.length ? { ok: false, detail: `${foreign[0].file} exists and is not Moonlighter's; left untouched` } : {}),
    };
  });

  if (appRoot) {
    await step('command', async () => ({ detail: shimPath(), changed: (await installShim(nodePath, cliPath)) === 'written' }));
  }

  if (process.platform === 'darwin' && !skipLaunchd) {
    await step('repair-timer', async () => {
      const template = await readFile(join(PKG_ROOT, 'launchd', `${RECONCILE_LABEL}.plist`), 'utf-8');
      const result = await installAgent(RECONCILE_LABEL, renderReconcilePlist(template, reconcileNode, cliPath));
      return { detail: result, changed: result === 'installed' };
    });
    if (appRoot) {
      await step('watchdog', async () => {
        await removeAgent(LEGACY_WATCHDOG_LABEL);
        const template = await readFile(join(PKG_ROOT, 'launchd', `${WATCHDOG_LABEL}.plist`), 'utf-8');
        const script = join(PKG_ROOT, 'launchd', 'watchdog.sh');
        const result = await installAgent(WATCHDOG_LABEL, renderWatchdogPlist(template, script, appRoot));
        return { detail: result, changed: result === 'installed' };
      });
    }
  }

  const tmux = findTmux(env);
  return { ok: steps.every((s) => s.ok), appRoot, nodePath: nodePath || reconcileNode, tmux, steps };
}

// Everything setup installed, except the app itself (which is dragged to the Trash) and the
// user's data (~/.claude-auto-retry/, ~/.claude-auto-retry.json), which is theirs.
export async function runUninstallAll({ env = process.env, skipLaunchd = false } = {}) {
  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ name, ok: true, detail: await fn() }); }
    catch (err) { steps.push({ name, ok: false, detail: String(err && err.message || err).split('\n')[0] }); }
  };
  await step('shell-functions', async () => {
    for (const rc of [join(homedir(), '.bashrc'), join(homedir(), '.zshrc')]) await removeWrapper(rc);
    return `fish: ${await removeFishWrapper(fishWrapperPath(env))}`;
  });
  await step('command', async () => {
    try { await unlink(shimPath()); return 'removed'; } catch { return 'absent'; }
  });
  if (process.platform === 'darwin' && !skipLaunchd) {
    await step('repair-timer', () => removeAgent(RECONCILE_LABEL));
    await step('watchdog', async () => `${await removeAgent(WATCHDOG_LABEL)}, legacy ${await removeAgent(LEGACY_WATCHDOG_LABEL)}`);
  }
  return { ok: steps.every((s) => s.ok), steps };
}
