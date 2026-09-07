import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';

describe('DEFAULT_CONFIG', () => {
  it('has expected defaults', () => {
    assert.equal(DEFAULT_CONFIG.maxRetries, 5);
    assert.equal(DEFAULT_CONFIG.pollIntervalSeconds, 5);
    assert.equal(DEFAULT_CONFIG.marginSeconds, 60);
    assert.equal(DEFAULT_CONFIG.fallbackWaitHours, 5);
    assert.equal(typeof DEFAULT_CONFIG.retryMessage, 'string');
    assert.deepEqual(DEFAULT_CONFIG.customPatterns, []);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig('/nonexistent/path/.claude-auto-retry.json');
    // DEFAULT_CONFIG is the DECLARED shape, not the loaded one: contextLimit.retryMessage
    // declares null ("reuse usageLimitMessage") and resolves in validate(), so a loaded
    // config is DEFAULT_CONFIG with that one field filled in. Asserted in two parts so this
    // stays a real check rather than a restatement of the resolution rule.
    assert.deepEqual(
      { ...config, contextLimit: { ...config.contextLimit, retryMessage: null } },
      DEFAULT_CONFIG);
    assert.equal(config.contextLimit.retryMessage, config.usageLimitMessage);
  });
  it('merges partial config with defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ maxRetries: 10 }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.maxRetries, 10);
      assert.equal(config.pollIntervalSeconds, 5);
    } finally { await unlink(f); }
  });
  it('returns defaults for invalid JSON', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, 'not json{{{');
    try {
      const config = await loadConfig(f);
      // DEFAULT_CONFIG is the DECLARED shape, not the loaded one: contextLimit.retryMessage
    // declares null ("reuse usageLimitMessage") and resolves in validate(), so a loaded
    // config is DEFAULT_CONFIG with that one field filled in. Asserted in two parts so this
    // stays a real check rather than a restatement of the resolution rule.
    assert.deepEqual(
      { ...config, contextLimit: { ...config.contextLimit, retryMessage: null } },
      DEFAULT_CONFIG);
    assert.equal(config.contextLimit.retryMessage, config.usageLimitMessage);
    } finally { await unlink(f); }
  });
  it('rejects string values and falls back to defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ maxRetries: "never", pollIntervalSeconds: "fast" }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.maxRetries, 5);
      assert.equal(config.pollIntervalSeconds, 5);
    } finally { await unlink(f); }
  });
  it('filters invalid customPatterns entries', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ customPatterns: ["valid", 42, null, "[invalid"] }));
    try {
      const config = await loadConfig(f);
      assert.deepEqual(config.customPatterns, ["valid"]);
    } finally { await unlink(f); }
  });
  it('rejects negative numbers and falls back to defaults', async () => {
    const { writeFile, unlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(tmpdir(), `car-test-${Date.now()}.json`);
    await writeFile(f, JSON.stringify({ maxRetries: -1, marginSeconds: -10 }));
    try {
      const config = await loadConfig(f);
      assert.equal(config.maxRetries, 5);
      assert.equal(config.marginSeconds, 60);
    } finally { await unlink(f); }
  });
});
