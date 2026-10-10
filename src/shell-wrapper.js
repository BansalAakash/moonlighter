// The `claude` shell function Moonlighter installs, for bash/zsh (spliced into an rc file between
// markers) and fish (a file of its own under functions/). Kept apart from bin/cli.js, which is a
// script with a top-level command switch and so cannot be imported by the setup code.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.sh');
const FISH_WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.fish');

export const MARKER_START = '# >>> claude-auto-retry >>>';
export const MARKER_END = '# <<< claude-auto-retry <<<';

// --- Wrapper injection ---

// The launcher path is spliced into a double-quoted string in the generated shell code, so
// the characters that are live inside double quotes must be escaped — and the substitution
// itself must use a replacer FUNCTION, because String.replace treats `$&`, `$1`, `$'` in a
// replacement STRING as patterns and would silently mangle a path containing them.
export function escapeForDoubleQuotes(path) {
  return path.replace(/[\\"$`]/g, '\\$&');
}

// Pin the interpreter: `node "<launcher>"` becomes `"<abs node>" "<launcher>"`. Used when the
// package ships its own Node (the app bundle), where "whatever node is on PATH" may not exist.
function pinNode(template, nodePath) {
  if (!nodePath) return template;
  return template.replace(/\bnode "__LAUNCHER_PATH__"/g, () => `"${escapeForDoubleQuotes(nodePath)}" "__LAUNCHER_PATH__"`);
}

// → 'written' | 'unchanged'. Unchanged is reported (and nothing is written) so that running
// setup on every app launch does not keep touching the user's rc files.
export async function injectWrapper(rcFile, launcherPath, nodePath = null) {
  let content = '';
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    // File doesn't exist, create it
  }
  const original = content;

  const template = await readFile(WRAPPER_TEMPLATE, 'utf-8');
  const wrapper = pinNode(template, nodePath).replace(/__LAUNCHER_PATH__/g, () => escapeForDoubleQuotes(launcherPath));

  // Remove existing wrapper if present
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const afterMarker = endIdx + MARKER_END.length;
    // Skip the newline after MARKER_END if present, but don't blindly +1
    const skipTo = content[afterMarker] === '\n' ? afterMarker + 1
                 : content.slice(afterMarker, afterMarker + 2) === '\r\n' ? afterMarker + 2
                 : afterMarker;
    content = content.slice(0, startIdx) + content.slice(skipTo);
  }

  content = content.trimEnd() + '\n\n' + wrapper + '\n';
  if (content === original) return 'unchanged';
  await writeFile(rcFile, content);
  return 'written';
}

export async function removeWrapper(rcFile) {
  let content;
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    return;
  }

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + MARKER_END.length).trimStart();
  content = before + (after ? '\n' + after : '\n');
  await writeFile(rcFile, content);
}

// --- fish ---
// fish has no rc-file wrapper to splice into: functions autoload from functions/<name>.fish,
// so the wrapper is a file of its own. It is only ever written or removed when it is OURS
// (carries the marker) — an existing claude.fish the user wrote is left alone.

export function fishWrapperPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fish', 'functions', 'claude.fish');
}

// 'written' | 'unchanged' | 'foreign' (a claude.fish that is not ours exists; untouched)
export async function injectFishWrapper(file, launcherPath, nodePath = null) {
  try {
    const existing = await readFile(file, 'utf-8');
    if (!existing.includes(MARKER_START)) return 'foreign';
  } catch { /* absent — create it */ }
  const template = await readFile(FISH_WRAPPER_TEMPLATE, 'utf-8');
  const text = pinNode(template, nodePath).replace(/__LAUNCHER_PATH__/g, () => escapeForDoubleQuotes(launcherPath));
  try { if (await readFile(file, 'utf-8') === text) return 'unchanged'; } catch { /* absent */ }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return 'written';
}

// 'removed' | 'foreign' | 'absent'
export async function removeFishWrapper(file) {
  let content;
  try { content = await readFile(file, 'utf-8'); } catch { return 'absent'; }
  if (!content.includes(MARKER_START)) return 'foreign';
  await unlink(file);
  return 'removed';
}

