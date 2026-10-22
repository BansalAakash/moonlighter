// Opt-in canary against the REAL Claude Code on this machine: MOONLIGHTER_LIVE=1 npm run canary
// Fails when a Claude Code update changes `claude -p /usage` enough that Moonlighter can no longer
// read it. (The banner patterns are covered by the fixture tests in patterns.test.js.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { probeViaHeadless, findClaudeBinary } from '../src/usage-probe.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const live = process.env.MOONLIGHTER_LIVE === '1';

describe('live Claude Code canary', { skip: !live && 'set MOONLIGHTER_LIVE=1' }, () => {
  it('headless /usage still parses', async () => {
    const bin = await findClaudeBinary();
    assert.ok(bin, 'no trusted claude binary found');
    const version = execFileSync(bin, ['--version'], { encoding: 'utf-8' }).trim();
    const r = await probeViaHeadless(DEFAULT_CONFIG, join(homedir(), '.claude-auto-retry', 'scratch-probe-cwd'));
    assert.ok(r, `claude ${version}: /usage output no longer parses`);
    assert.ok(r.resetAt > Date.now() - 60_000 && r.percentUsed >= 0 && r.percentUsed <= 100, JSON.stringify(r));
    console.log(`claude ${version}: ok`, r);
  });
});
