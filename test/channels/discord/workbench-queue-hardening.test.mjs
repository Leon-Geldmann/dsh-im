import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkbenchQueue } from '../../../src/channels/discord/workbench/queue.mjs';

test('a project waiter leaves a global slot available for a different project', async () => {
  const queue = new WorkbenchQueue({ maxConcurrentTasks: 2, projectConcurrency: 1 });
  let release;
  const started = [];
  const first = queue.run({ sessionId: 'a', projectId: 'same' }, async () => {
    started.push('a');
    await new Promise((resolve) => { release = resolve; });
  });
  const second = queue.run({ sessionId: 'b', projectId: 'same' }, async () => { started.push('b'); });
  const other = queue.run({ sessionId: 'c', projectId: 'other' }, async () => { started.push('c'); });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(started, ['a', 'c']);
  } finally {
    release();
    await Promise.all([first, second, other]);
  }
});

test('closing a queue refuses tasks already waiting for admission', async () => {
  const queue = new WorkbenchQueue();
  let release;
  let ran = false;
  const first = queue.run({ sessionId: 'a', projectId: 'same' }, () => new Promise((r) => { release = r; }));
  const second = queue.run({ sessionId: 'b', projectId: 'same' }, async () => { ran = true; });
  const rejection = assert.rejects(second, { code: 'workbench-queue-closed' });
  await new Promise((resolve) => setImmediate(resolve));
  queue.close();
  release();
  await Promise.all([first, rejection]);
  assert.equal(ran, false);
});

for (const scope of ['global', 'project', 'session']) {
  test(`a restarted queue reserves ${scope} capacity for an unresolved accepted task`, async () => {
    const reservations = [{ sessionId: 'old', projectId: 'same' }];
    const queue = new WorkbenchQueue({ maxConcurrentTasks: scope === 'global' ? 1 : 3,
      projectConcurrency: scope === 'session' ? 3 : 1, reservations: () => reservations });
    let ran = false;
    const request = { sessionId: scope === 'session' ? 'old' : 'new', projectId: scope === 'global' ? 'other' : 'same' };
    await assert.rejects(queue.run(request, async () => { ran = true; }), { code: 'workbench-task-unresolved' });
    assert.equal(ran, false);
    reservations.splice(0);
    await queue.run(request, async () => { ran = true; });
    assert.equal(ran, true);
  });
}

test('a task that times out retains capacity after its in-process queue slot is released', async () => {
  const reservations = [];
  const queue = new WorkbenchQueue({ reservations: () => reservations });
  await assert.rejects(queue.run({ sessionId: 'old', projectId: 'same' }, async () => {
    reservations.push({ sessionId: 'old', projectId: 'same' });
    throw new Error('observation timeout');
  }), /observation timeout/);
  await assert.rejects(queue.run({ sessionId: 'new', projectId: 'other' }, () => assert.fail('must not run')), { code: 'workbench-task-unresolved' });
});

test('queue reservations do not count the same live task twice', async () => {
  const reservations = [];
  const queue = new WorkbenchQueue({ maxConcurrentTasks: 2, reservations: () => reservations });
  let release;
  const first = queue.run({ sessionId: 'a', projectId: 'one' }, async () => {
    reservations.push({ sessionId: 'a', projectId: 'one' });
    await new Promise((resolve) => { release = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));
  try { assert.equal(await queue.run({ sessionId: 'b', projectId: 'two' }, async () => 42), 42); }
  finally { release(); await first; }
});
