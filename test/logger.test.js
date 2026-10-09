import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, todayLogFile } from '../src/logger.js';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('createLogger', () => {
  const testDir = join(tmpdir(), `car-logger-test-${Date.now()}`);

  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('creates log directory and writes log entry', async () => {
    const logger = createLogger(testDir);
    await logger.info('test message');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(testDir, `${today}.log`), 'utf-8');
    assert.ok(content.includes('test message'));
    assert.ok(content.includes('[INFO]'));
  });
  it('includes timestamp in log entries', async () => {
    const logger = createLogger(testDir);
    await logger.info('timestamped');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(testDir, `${today}.log`), 'utf-8');
    assert.match(content, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });
  it('supports warn and error levels', async () => {
    const logger = createLogger(testDir);
    await logger.warn('warning msg');
    await logger.error('error msg');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(testDir, `${today}.log`), 'utf-8');
    assert.ok(content.includes('[WARN]'));
    assert.ok(content.includes('[ERROR]'));
  });
});

describe('todayLogFile (local date, shared by the monitors and the CLI)', () => {
  it('names the file by LOCAL calendar date', () => {
    // Built from local components, so the expectation holds in any host timezone. At
    // 00:30 local on the 9th, a UTC-derived name would be the 8th for any zone east of UTC.
    assert.equal(todayLogFile('/d', new Date(2026, 9, 9, 0, 30)), join('/d', '2026-10-09.log'));
    assert.equal(todayLogFile('/d', new Date(2026, 9, 9, 23, 59)), join('/d', '2026-10-09.log'));
  });
  it('rolls over at local midnight', () => {
    assert.equal(todayLogFile('/d', new Date(2026, 11, 31, 23, 59, 59)), join('/d', '2026-12-31.log'));
    assert.equal(todayLogFile('/d', new Date(2027, 0, 1, 0, 0, 0)), join('/d', '2027-01-01.log'));
  });
  it('matches the file the logger actually appends to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'car-log-'));
    try {
      await createLogger(dir).info('hello');
      assert.match(await readFile(todayLogFile(dir), 'utf-8'), /hello/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
