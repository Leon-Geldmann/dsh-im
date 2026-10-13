import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordWorkbenchStore } from '../../../src/channels/discord/workbench/workbench-store.mjs';
import { WorkbenchTaskJournal } from '../../../src/channels/discord/workbench/task-journal.mjs';

const MESSAGE = '111111111111111111';
const CHANNEL = '222222222222222222';
const OPERATOR = '333333333333333333';
const SESSION = 'session-alpha';
const input = { messageId: MESSAGE, channelId: CHANNEL, operatorId: OPERATOR };
const identity = { sessionId: SESSION, promptRpcId: 'prompt-own', baselineSeq: 9 };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-task-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'workbench.json');
  const store = await new DiscordWorkbenchStore(path).load();
  return { store, path, reload: () => new DiscordWorkbenchStore(path).load() };
}

function event(seq, type, data) { return { event: { seq, type, data } }; }

function answerHistory(rpcId = 'prompt-own', turn = 4, offset = 10, text = 'Recovered answer') {
  return [
    event(offset, 'turn/start', { turn }),
    event(offset + 1, 'user/message', { turn, source: { rpcId } }),
    event(offset + 2, 'assistant/message', {
      turn, step: 0, message: { content: [{ type: 'text', text }] },
    }),
    event(offset + 3, 'turn/end', { turn, reason: { kind: 'completed' } }),
  ];
}

function historyHost(events, { running = false, pageSize = 100, onList } = {}) {
  const reads = [];
  const harness = { async rpc(method, payload, timeoutMs, { signal } = {}) {
    signal?.throwIfAborted();
    assert.equal(timeoutMs > 0, true);
    if (method === 'session.list') {
      onList?.(events);
      return { items: [{ sessionId: SESSION, running }] };
    }
    assert.equal(method, 'session.history', 'recovery must never submit a prompt');
    assert.equal(payload.sessionId, SESSION);
    reads.push(payload);
    const eligible = events.filter(({ event: value }) => (
      payload.beforeSeq === undefined || value.seq < payload.beforeSeq
    ));
    const size = Math.min(payload.maxMessages, pageSize);
    return { events: eligible.slice(-size), hasMore: eligible.length > size };
  } };
  return { harness, reads };
}

test('accept durably deduplicates concurrent callers and a fresh journal after restart', async (t) => {
  const { store, path, reload } = await fixture(t);
  const first = new WorkbenchTaskJournal({ store });
  const second = new WorkbenchTaskJournal({ store });
  const accepted = await Promise.all([first.accept(input), second.accept(input)]);
  assert.deepEqual(accepted.map((result) => result.accepted), [true, false]);
  assert.equal(accepted[0].entry.operationId, `message-${MESSAGE}`);
  assert.equal(accepted[0].entry.state, 'queued');
  const restarted = new WorkbenchTaskJournal({ store: await reload() });
  assert.equal((await restarted.accept({ ...input, sessionId: 'other' })).accepted, false);
  const persisted = JSON.parse(await readFile(path, 'utf8')).operations[`message-${MESSAGE}`];
  assert.deepEqual(persisted.payload, { ...input, sessionId: null });
});

test('updates merge durable facts while excluding credentials and raw Gateway data', async (t) => {
  const { store, path, reload } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept({ ...input, token: 'secret-token', raw: { content: 'raw-message' } });
  await journal.update(MESSAGE, 'running', { ...identity, token: 'secret-token', gateway: { raw: true } });
  const persisted = (await reload()).operation(`message-${MESSAGE}`);
  assert.equal(persisted.payload.channelId, CHANNEL);
  assert.equal(persisted.payload.promptRpcId, 'prompt-own');
  assert.equal(persisted.state, 'running');
  assert.equal((await readFile(path, 'utf8')).includes('secret-token'), false);
  assert.equal((await readFile(path, 'utf8')).includes('raw-message'), false);
});

test('queued work is held for explicit resubmission without consulting or replaying Harness', async (t) => {
  const { store, reload } = await fixture(t);
  await new WorkbenchTaskJournal({ store }).accept(input);
  const journal = new WorkbenchTaskJournal({ store: await reload(), harness: {
    rpc() { assert.fail('queued tasks must not perform Harness RPCs'); },
  } });
  const [result] = await journal.recover();
  assert.equal(result.status, 'queued');
  assert.equal(result.requiresResubmission, true);
  assert.equal(result.messageId, MESSAGE);
  assert.equal(result.channelId, CHANNEL);
  assert.equal(result.operatorId, OPERATOR);
});

test('recovery pages to the exact prompt and ignores a newer unrelated completed turn', async (t) => {
  const { store, reload } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  await journal.promptLifecycle(MESSAGE)({ state: 'submitting', ...identity });
  const events = [
    ...answerHistory(),
    ...answerHistory('another-prompt', 5, 14, 'Wrong answer'),
  ];
  const { harness, reads } = historyHost(events, { pageSize: 2 });
  const recoveredStore = await reload();
  const restarted = new WorkbenchTaskJournal({ store: recoveredStore, harness });
  const [result] = await restarted.recover();
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Recovered answer');
  assert.equal(result.turn, 4);
  assert.equal(result.sessionId, SESSION);
  assert.equal(reads.length >= 4, true);
  assert.equal(reads[1].beforeSeq, 16);
  assert.equal((await reload()).operation(`message-${MESSAGE}`).payload.text, 'Recovered answer');
  assert.equal((await restarted.accept(input)).accepted, false);
});

test('recovery keeps a verified live turn running across plugin restarts and observes completion later', async (t) => {
  const { store, reload } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  await journal.promptLifecycle(MESSAGE)({ state: 'submitted', ...identity });
  const events = answerHistory().slice(0, 2);
  const { harness } = historyHost(events, { running: true });
  const restarted = new WorkbenchTaskJournal({ store: await reload(), harness });
  assert.equal((await restarted.recover())[0].status, 'running');
  assert.equal((await reload()).operation(`message-${MESSAGE}`).state, 'running');
  events.push(...answerHistory().slice(2));
  assert.equal((await restarted.recover())[0].text, 'Recovered answer');
});

test('unverifiable or missing prompt identity stays submission-unknown even when the host is idle', async (t) => {
  for (const facts of [identity, { sessionId: SESSION, turn: 4 }]) {
    const { store, reload } = await fixture(t);
    const journal = new WorkbenchTaskJournal({ store });
    await journal.accept(input);
    await journal.update(MESSAGE, 'submitting', facts);
    const { harness } = historyHost(answerHistory('unrelated'));
    const restarted = new WorkbenchTaskJournal({ store: await reload(), harness });
    assert.equal((await restarted.recover())[0].status, 'submission-unknown');
    assert.equal((await reload()).operation(`message-${MESSAGE}`).state, 'submission-unknown');
  }
});

test('only an identified turn with an idle host becomes interrupted', async (t) => {
  const { store, reload } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  await journal.update(MESSAGE, 'running', identity);
  const { harness } = historyHost(answerHistory().slice(0, 2));
  const restarted = new WorkbenchTaskJournal({ store: await reload(), harness });
  assert.equal((await restarted.recover())[0].status, 'interrupted');
  assert.equal((await reload()).operation(`message-${MESSAGE}`).state, 'interrupted');
});

test('completion between history and the idle probe is recovered before declaring interruption', async (t) => {
  const { store } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  await journal.update(MESSAGE, 'running', identity);
  const { harness } = historyHost(answerHistory().slice(0, 2), {
    onList(events) { events.push(...answerHistory().slice(2)); },
  });
  const [result] = await new WorkbenchTaskJournal({ store, harness }).recover();
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Recovered answer');
});

test('lifecycle facts preserve accepted work after observation failure and distinguish uncertain submission', async (t) => {
  const { store } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  const lifecycle = journal.promptLifecycle(MESSAGE);
  await lifecycle({ state: 'failed', ...identity, submissionState: 'unknown', uncertain: true });
  assert.equal(store.operation(`message-${MESSAGE}`).state, 'submission-unknown');
  await lifecycle({ state: 'failed', ...identity, submissionState: 'submitted', turnFinished: false });
  assert.equal(store.operation(`message-${MESSAGE}`).state, 'running');
  await lifecycle({ state: 'completed', ...identity, turn: 4, lastSeq: 13, text: 'Saved answer' });
  assert.equal((await journal.recover())[0].text, 'Saved answer');
  await journal.update(MESSAGE, 'delivered');
  assert.deepEqual(await journal.recover(), []);
  assert.equal((await journal.accept(input)).accepted, false);
});

test('recovery honors cancellation without changing durable state', async (t) => {
  const { store } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  await journal.update(MESSAGE, 'running', identity);
  const { harness } = historyHost(answerHistory());
  const controller = new AbortController();
  controller.abort(new Error('cancel recovery'));
  await assert.rejects(new WorkbenchTaskJournal({ store, harness }).recover({ signal: controller.signal }), /cancel recovery/);
  assert.equal(store.operation(`message-${MESSAGE}`).state, 'running');
});

test('a crash during delivery retains the answer as delivery-unknown and never offers a resend', async (t) => {
  const { store, reload } = await fixture(t);
  const journal = new WorkbenchTaskJournal({ store });
  await journal.accept(input);
  await journal.update(MESSAGE, 'delivering', { ...identity, text: 'Answer already being sent' });
  const restarted = new WorkbenchTaskJournal({ store: await reload(), harness: {
    rpc() { assert.fail('ambiguous delivery must not replay any Harness work'); },
  } });
  const [result] = await restarted.recover();
  assert.equal(result.status, 'delivery-unknown');
  assert.equal(result.text, 'Answer already being sent');
  assert.equal(result.requiresResubmission, false);
  assert.equal((await reload()).operation(`message-${MESSAGE}`).state, 'delivery-unknown');
  await restarted.update(MESSAGE, 'delivered', { deliveryMessageId: '444444444444444444' });
  assert.deepEqual(await restarted.recover(), []);
  assert.equal((await restarted.accept(input)).accepted, false);
});
