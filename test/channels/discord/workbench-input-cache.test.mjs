import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cacheWorkbenchInputs } from '../../../src/channels/discord/workbench/input-cache.mjs';

test('authorized queued files are stored locally and do not need the expired CDN again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloads = 0;
  const cached = await cacheWorkbenchInputs({ files: [{
    name: '../../report.txt', load: async () => {
      downloads += 1;
      return { stream: (async function* () { yield Buffer.from('report'); })() };
    },
  }], images: [] }, { root, messageId: '111111111111111111' });
  assert.equal(downloads, 1);
  const loaded = await cached.message.files[0].load();
  const chunks = [];
  for await (const chunk of loaded.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'report');
  assert.equal(downloads, 1);
  assert.equal(cached.attachments[0].name, '../../report.txt');
  assert.equal((await readdir(root)).length, 1);
  await cached.cleanup();
  assert.deepEqual(await readdir(root), []);
});

test('a failed download removes partial cache bytes before any prompt can be submitted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(cacheWorkbenchInputs({ files: [{
    load: async () => ({ stream: (async function* () { yield Buffer.from('partial'); throw new Error('offline'); })() }),
  }] }, { root, messageId: '111111111111111111' }), /offline/);
  assert.deepEqual(await readdir(root), []);
});
