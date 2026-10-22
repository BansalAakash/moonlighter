import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseUsageOutput, isTrustedFile, minimalEnv, findClaudeBinary, probeViaHeadless } from '../src/usage-probe.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const OUT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 3% used · resets Oct 22 at 11:40pm (Asia/Calcutta)',
  'Current week (all models): 84% used · resets Oct 24 at 6:30am (Asia/Calcutta)',
].join('\n');

describe('parseUsageOutput', () => {
  it('reads both windows', () => {
    const r = parseUsageOutput(OUT, DEFAULT_CONFIG);
    assert.equal(r.percentUsed, 3);
    assert.equal(r.weeklyPercentUsed, 84);
    assert.equal(r.weeklyResetText, 'Resets Oct 24 at 6:30am (Asia/Calcutta)');
    assert.ok(r.resetAt > 0);
  });
  it('returns null when there is no session row', () => {
    assert.equal(parseUsageOutput('Unknown command: /usage', DEFAULT_CONFIG), null);
    assert.equal(parseUsageOutput('', DEFAULT_CONFIG), null);
  });
  it('tolerates a missing weekly row', () => {
    const r = parseUsageOutput(OUT.split('\n').slice(0, 3).join('\n'), DEFAULT_CONFIG);
    assert.equal(r.weeklyPercentUsed, null);
  });
});

describe('trust checks', () => {
  it('accepts own or root files, rejects group/other-writable and foreign owners', () => {
    assert.equal(isTrustedFile({ uid: 501, mode: 0o100755 }, 501), true);
    assert.equal(isTrustedFile({ uid: 0, mode: 0o100755 }, 501), true);
    assert.equal(isTrustedFile({ uid: 501, mode: 0o100775 }, 501), false);
    assert.equal(isTrustedFile({ uid: 501, mode: 0o100757 }, 501), false);
    assert.equal(isTrustedFile({ uid: 502, mode: 0o100755 }, 501), false);
  });
  it('findClaudeBinary skips a writable-by-others binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'car-bin-'));
    const bin = join(dir, 'claude');
    await writeFile(bin, '#!/bin/sh\n'); await chmod(bin, 0o777);
    assert.equal(await findClaudeBinary({ claudePath: bin }), null);
    await chmod(bin, 0o755);
    assert.equal(await findClaudeBinary({ claudePath: bin }), bin);
  });
  it('rejects a symlink whose target is writable by others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'car-bin-'));
    const real = join(dir, 'real'); const link = join(dir, 'claude');
    await writeFile(real, ''); await chmod(real, 0o777); await symlink(real, link);
    assert.equal(await findClaudeBinary({ claudePath: link }), null);
  });
});

describe('minimalEnv', () => {
  it('drops secrets and keeps only the allowlist', () => {
    const e = minimalEnv('/x/bin/claude', { HOME: '/h', USER: 'u', ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: 's', PATH: '/evil' });
    assert.deepEqual(Object.keys(e).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
    assert.ok(!e.PATH.includes('/evil'));
  });
});

describe('probeViaHeadless', () => {
  it('runs the restricted command and parses stdout; null on failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'car-bin-'));
    const bin = join(dir, 'claude');
    await writeFile(bin, ''); await chmod(bin, 0o755);
    let seen;
    const ok = await probeViaHeadless({ ...DEFAULT_CONFIG, claudePath: bin }, dir, async (b, args, opts) => { seen = { b, args, opts }; return { stdout: OUT }; });
    assert.equal(ok.percentUsed, 3);
    assert.ok(seen.args.includes('--no-session-persistence') && seen.args.includes('--strict-mcp-config'));
    assert.ok(seen.args.join(' ').includes('disableAllHooks'));
    assert.equal(seen.opts.cwd, dir);
    const bad = await probeViaHeadless({ ...DEFAULT_CONFIG, claudePath: bin }, dir, async () => { throw new Error('x'); });
    assert.equal(bad, null);
  });
});
