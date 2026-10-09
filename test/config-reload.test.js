import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadConfigDetailed, createConfigReloader, DEFAULT_CONFIG } from '../src/config.js';

let dir;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });
const tmpFile = async (content) => {
  dir = await mkdtemp(join(tmpdir(), 'car-config-'));
  const file = join(dir, 'config.json');
  if (content !== undefined) await writeFile(file, content);
  return file;
};
// Edits within one filesystem-timestamp tick would be invisible to an mtime check, so move the
// clock explicitly instead of sleeping.
let tick = 1_800_000_000;
const touch = async (file) => { tick += 10; await utimes(file, tick, tick); };

describe('loadConfigDetailed', () => {
  it('a missing file is simply defaults, with no error', async () => {
    const r = await loadConfigDetailed(await tmpFile());
    assert.equal(r.error, null);
    assert.equal(r.config.usageLimitMessage, DEFAULT_CONFIG.usageLimitMessage);
  });
  it('a valid file is merged over the defaults', async () => {
    const r = await loadConfigDetailed(await tmpFile('{"usageLimitMessage":"go on","maxRetries":9}'));
    assert.equal(r.error, null);
    assert.equal(r.config.usageLimitMessage, 'go on');
    assert.equal(r.config.maxRetries, 9);
  });
  it('invalid JSON reports an error but still returns a complete, usable config', async () => {
    const r = await loadConfigDetailed(await tmpFile('{"usageLimitMessage": "unterminated'));
    assert.match(r.error, /not valid JSON/);
    assert.equal(r.config.usageLimitMessage, DEFAULT_CONFIG.usageLimitMessage);
    assert.equal(typeof r.config.contextLimit.retryMessage, 'string');
  });
  it('JSON that is not an object is an error too (array, null, number)', async () => {
    for (const body of ['[1,2]', 'null', '42', '"str"']) {
      const r = await loadConfigDetailed(await tmpFile(body));
      assert.match(r.error, /JSON object/, body);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('a directory where the file should be is reported, not thrown', async () => {
    dir = await mkdtemp(join(tmpdir(), 'car-config-'));
    const r = await loadConfigDetailed(dir);
    assert.match(r.error, /could not be read/);
  });
  it('loadConfig keeps its old contract: always a config, never throws', async () => {
    assert.equal((await loadConfig(await tmpFile('{ nope'))).maxRetries, DEFAULT_CONFIG.maxRetries);
  });
});

describe('inputBox validation', () => {
  it("defaults to 'send'", async () => {
    assert.equal((await loadConfig(await tmpFile('{}'))).inputBox.whenOccupied, 'send');
  });
  it("accepts 'wait'", async () => {
    assert.equal((await loadConfig(await tmpFile('{"inputBox":{"whenOccupied":"wait"}}'))).inputBox.whenOccupied, 'wait');
  });
  it('falls back to the default for anything else', async () => {
    for (const v of ['"sometimes"', '1', 'null', '{}']) {
      assert.equal((await loadConfig(await tmpFile(`{"inputBox":{"whenOccupied":${v}}}`))).inputBox.whenOccupied, 'send', v);
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal((await loadConfig(await tmpFile('{"inputBox":"wait"}'))).inputBox.whenOccupied, 'send');
  });
});

describe('createConfigReloader', () => {
  it('serves the config it started with and reports nothing changed', async () => {
    const file = await tmpFile('{"usageLimitMessage":"first"}');
    const r = await createConfigReloader(file);
    assert.equal(r.config.usageLimitMessage, 'first');
    assert.equal(r.startupError, null);
    assert.deepEqual(await r.refresh(), { changed: false, error: null });
  });
  it('picks up an edit without a restart', async () => {
    const file = await tmpFile('{"usageLimitMessage":"first"}');
    const r = await createConfigReloader(file);
    await writeFile(file, '{"usageLimitMessage":"second"}'); await touch(file);
    assert.deepEqual(await r.refresh(), { changed: true, error: null });
    assert.equal(r.config.usageLimitMessage, 'second');
    assert.deepEqual(await r.refresh(), { changed: false, error: null }, 'and only once per edit');
  });
  it('a bad edit KEEPS the last good config and reports the error once', async () => {
    const file = await tmpFile('{"usageLimitMessage":"good"}');
    const r = await createConfigReloader(file);
    await writeFile(file, '{"usageLimitMessage": "oops'); await touch(file);
    const bad = await r.refresh();
    assert.equal(bad.changed, false);
    assert.match(bad.error, /not valid JSON/);
    assert.equal(r.config.usageLimitMessage, 'good', 'must not silently revert to defaults');
    assert.deepEqual(await r.refresh(), { changed: false, error: null }, 'the error is reported once, not every tick');
  });
  it('recovers when the file is fixed', async () => {
    const file = await tmpFile('{"usageLimitMessage":"good"}');
    const r = await createConfigReloader(file);
    await writeFile(file, '{ broken'); await touch(file); await r.refresh();
    await writeFile(file, '{"usageLimitMessage":"fixed"}'); await touch(file);
    assert.deepEqual(await r.refresh(), { changed: true, error: null });
    assert.equal(r.config.usageLimitMessage, 'fixed');
  });
  it('deleting the file returns to defaults (an intentional reset, not an error)', async () => {
    const file = await tmpFile('{"usageLimitMessage":"custom"}');
    const r = await createConfigReloader(file);
    await unlink(file);
    assert.deepEqual(await r.refresh(), { changed: true, error: null });
    assert.equal(r.config.usageLimitMessage, DEFAULT_CONFIG.usageLimitMessage);
  });
  it('reports a startup error when the file is already broken', async () => {
    const r = await createConfigReloader(await tmpFile('{ broken'));
    assert.match(r.startupError, /not valid JSON/);
    assert.equal(r.config.maxRetries, DEFAULT_CONFIG.maxRetries);
  });
  it('a changed shared prompt reaches the contextLimit continuation that defaults to it', async () => {
    const file = await tmpFile('{"usageLimitMessage":"one"}');
    const r = await createConfigReloader(file);
    assert.equal(r.config.contextLimit.retryMessage, 'one');
    await writeFile(file, '{"usageLimitMessage":"two"}'); await touch(file);
    await r.refresh();
    assert.equal(r.config.contextLimit.retryMessage, 'two');
  });
});
