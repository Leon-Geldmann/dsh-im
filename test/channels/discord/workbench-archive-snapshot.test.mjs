import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveArchiveSnapshot } from '../../../src/channels/discord/workbench/archive-snapshot.mjs';

const channel = { channelId: '222222222222222201', sessionId: 'session-one', projectId: 'alpha' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'discord-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, channel, api: { listChannelMessages: async () => [] },
    harness: { readSessionHistory: async () => ({ events: [], hasMore: false }) } };
}

test('archive saves complete paginated Harness history and Discord attachment bytes privately', async (t) => {
  const f = await fixture(t);
  f.harness.readSessionHistory = async (id, { beforeSeq }) => {
    assert.equal(id, 'session-one');
    return beforeSeq === undefined
      ? { events: [{ event: { seq: 2, type: 'turn/end', data: {} } }], hasMore: true }
      : { events: [{ event: { seq: 0, type: 'user/message', data: {} } }], hasMore: false };
  };
  f.api.listChannelMessages = async ({ before }) => before ? [] : [{
    id: '333333333333333333', content: 'report', attachments: [{ id: '444444444444444444', filename: '../report.txt', size: 5,
      url: 'https://cdn.discordapp.com/attachments/report.txt?ex=expires', content_type: 'text/plain' }],
  }];
  f.api.downloadAttachment = async () => ({ stream: (async function* () { yield Buffer.from('hello'); })() });
  const saved = await saveArchiveSnapshot(f);
  const manifest = JSON.parse(await readFile(join(f.root, saved.directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.history.map((row) => row.event.seq), [0, 2]);
  assert.equal(manifest.messages[0].content, 'report');
  assert.equal(manifest.attachments[0].name, '../report.txt');
  assert.equal(await readFile(join(f.root, saved.directory, manifest.attachments[0].file), 'utf8'), 'hello');
  assert.equal((await stat(join(f.root, saved.directory, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, saved.directory))).mode & 0o777, 0o700);
});

for (const broken of ['missing pagination', 'repeating history', 'attachment download', 'truncated attachment']) {
  test(`archive refuses an incomplete snapshot: ${broken}`, async (t) => {
    const f = await fixture(t);
    if (broken === 'missing pagination') f.harness.readSessionHistory = async () => ({ events: [] });
    if (broken === 'repeating history') f.harness.readSessionHistory = async () => ({ events: [{ event: { seq: 1 } }], hasMore: true });
    if (broken.includes('attachment')) {
      f.api.listChannelMessages = async () => [{ id: '333333333333333333', attachments: [{ id: '444444444444444444', filename: 'file', size: 10, url: 'https://cdn.discordapp.com/file' }] }];
      f.api.downloadAttachment = async () => {
        if (broken === 'attachment download') throw new Error('expired');
        return { stream: (async function* () { yield Buffer.from('short'); })() };
      };
    }
    await assert.rejects(saveArchiveSnapshot(f));
  });
}
