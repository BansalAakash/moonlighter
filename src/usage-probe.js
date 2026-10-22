// Reads the account's usage figures with `claude -p /usage` — a headless call that makes no
// model request — instead of driving an interactive Claude in a scratch tmux session.
// Cheaper (about 3s, no tmux, nothing to sweep up) and it cannot be mistaken for a user
// session by the repair timer. session-reset.js falls back to the scratch session when this
// returns null (an older Claude Code without `/usage` in print mode, an unreadable output).
//
// The binary is only run if it and its real file are owned by this user or root and writable
// by neither group nor others, in a minimal environment (no API keys, no agent sockets), in a
// fixed empty directory, with hooks, MCP servers and transcript saving switched off, under a
// hard deadline.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, realpath, readdir, mkdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { parseResetTime, calculateWaitMs } from './time-parser.js';

const execFile = promisify(execFileCb);

const PROBE_TIMEOUT_MS = 30_000;
const SESSION_ROW = /Current session:\s*(\d{1,3})%\s*used\s*·\s*resets\s+(.+)$/im;
const WEEK_ROW = /Current week \(all models\):\s*(\d{1,3})%\s*used\s*·\s*resets\s+(.+)$/im;

const RESTRICTED_ARGS = [
  '-p', '/usage',
  '--no-session-persistence',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--settings', '{"disableAllHooks":true}',
];

// Safe to execute: owned by us or root, not writable by group or others.
export function isTrustedFile(st, uid = process.getuid()) {
  return (st.uid === uid || st.uid === 0) && (st.mode & 0o022) === 0;
}

async function trusted(path) {
  try {
    const real = await realpath(path);
    for (const p of new Set([path, real])) {
      if (!isTrustedFile(await stat(p))) return false;
    }
    return true;
  } catch { return false; }
}

async function fnmBinDirs() {
  const root = join(homedir(), '.local', 'share', 'fnm', 'node-versions');
  try {
    return (await readdir(root)).map((v) => join(root, v, 'installation', 'bin'));
  } catch { return []; }
}

// First trusted `claude` on the usual PATH plus the places installers put it. Never the
// `claude` shell function: that is the wrapper, and a probe must not start a monitored session.
export async function findClaudeBinary(config = {}, env = process.env) {
  const dirs = [
    ...(env.PATH || '').split(delimiter),
    join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'),
    join(homedir(), '.npm-global', 'bin'), join(homedir(), '.volta', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin',
    ...(await fnmBinDirs()),
  ].filter(Boolean);
  const candidates = config.claudePath ? [config.claudePath] : dirs.map((d) => join(d, 'claude'));
  for (const c of candidates) {
    try { await stat(c); } catch { continue; }
    if (await trusted(c)) return c;
  }
  return null;
}

export function minimalEnv(binary, env = process.env) {
  const out = {
    HOME: env.HOME || homedir(), USER: env.USER || '', LOGNAME: env.LOGNAME || env.USER || '',
    TMPDIR: env.TMPDIR || '/tmp', LANG: env.LANG || 'en_US.UTF-8',
    PATH: [binary.replace(/\/[^/]*$/, ''), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  };
  if (env.CLAUDE_CONFIG_DIR) out.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  return out;
}

// Pure: `claude -p /usage` output → the same shape the scratch probe returns, or null.
export function parseUsageOutput(text, config) {
  const s = SESSION_ROW.exec(text || '');
  if (!s) return null;
  const parsed = parseResetTime(`resets ${s[2]}`);
  if (!parsed) return null;
  const resetAt = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
  const w = WEEK_ROW.exec(text);
  // The weekly line carries a date, so it can be turned into an instant like the session one.
  const wParsed = w ? parseResetTime(`resets ${w[2]}`) : null;
  const weeklyResetAt = wParsed ? Date.now() + calculateWaitMs(wParsed, config.marginSeconds, config.fallbackWaitHours) : 0;
  return {
    resetAt,
    percentUsed: parseInt(s[1], 10),
    weeklyPercentUsed: w ? parseInt(w[1], 10) : null,
    weeklyResetText: w ? `Resets ${w[2].trim()}` : null,
    weeklyResetAt,
  };
}

export async function probeViaHeadless(config, scratchCwd, run = execFile) {
  const binary = await findClaudeBinary(config);
  if (!binary) return null;
  await mkdir(scratchCwd, { recursive: true });
  try {
    const { stdout } = await run(binary, RESTRICTED_ARGS, {
      cwd: scratchCwd, env: minimalEnv(binary), timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      maxBuffer: 1 << 20,
    });
    return parseUsageOutput(stdout, config);
  } catch { return null; }
}

// The subscription tier ("pro", "max", …) from `claude auth status --json`. Only that one field is
// kept — the email and org the command also prints are dropped here. null if signed out or unreadable.
export async function readPlan(config = {}, run = execFile) {
  const binary = await findClaudeBinary(config);
  if (!binary) return null;
  try {
    const { stdout } = await run(binary, ['auth', 'status', '--json'], {
      env: minimalEnv(binary), timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20,
    });
    const j = JSON.parse(stdout);
    return j && j.loggedIn && typeof j.subscriptionType === 'string' ? j.subscriptionType : null;
  } catch { return null; }
}
