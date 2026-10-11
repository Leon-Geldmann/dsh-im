import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DiscordRateLimiter,
  rateLimitRouteKey,
} from '../../../src/channels/discord/workbench/rate-limiter.mjs';
import { WorkbenchQueue } from '../../../src/channels/discord/workbench/queue.mjs';

const CHANNEL = '222222222222222201';
const OTHER_CHANNEL = '222222222222222202';

test('route keys collapse ids but keep the method, template and major parameter', () => {
  assert.equal(
    rateLimitRouteKey('POST', `/channels/${CHANNEL}/messages`),
    `POST /channels/{major}/messages#${CHANNEL}`,
  );
  assert.equal(
    rateLimitRouteKey('PATCH', `/channels/${CHANNEL}/messages/888888888888888801`),
    `PATCH /channels/{major}/messages/{id}#${CHANNEL}`,
  );
  assert.notEqual(
    rateLimitRouteKey('POST', `/channels/${CHANNEL}/messages`),
    rateLimitRouteKey('POST', `/channels/${OTHER_CHANNEL}/messages`),
  );
  assert.equal(
    rateLimitRouteKey('PUT', `/applications/123456789012345678/guilds/444444444444444444/commands`),
    'PUT /applications/{id}/guilds/{id}/commands',
  );
});

test('a bucket that reports no remaining capacity delays the next request', async () => {
  const sleeps = [];
  let now = 1_000;
  const limiter = new DiscordRateLimiter({
    logger: { debug() {}, warn() {} },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  const route = rateLimitRouteKey('POST', `/channels/${CHANNEL}/messages`);
  limiter.observe(route, new Map([
    ['x-ratelimit-remaining', '0'],
    ['x-ratelimit-reset-after', '1.5'],
  ]));
  await limiter.wait(route);
  assert.deepEqual(sleeps, [1_500]);
});

test('a satisfied request does not delay its own bucket', async () => {
  const sleeps = [];
  const limiter = new DiscordRateLimiter({
    logger: { debug() {}, warn() {} },
    sleep: async (ms) => sleeps.push(ms),
  });
  const route = rateLimitRouteKey('POST', `/channels/${CHANNEL}/messages`);
  limiter.observe(route, new Map([
    ['x-ratelimit-remaining', '4'],
    ['x-ratelimit-reset-after', '1'],
  ]));
  await limiter.wait(route);
  assert.deepEqual(sleeps, []);
});

test('a global 429 pauses every bucket, a channel 429 only its own', async () => {
  const sleeps = [];
  let now = 5_000;
  let advance = false;
  const limiter = new DiscordRateLimiter({
    logger: { debug() {}, warn() {} },
    now: () => now,
    // The penalty's own sleep does not advance the clock here: the point is
    // what a *later* caller observes while the pause is still in effect.
    sleep: async (ms) => {
      sleeps.push(ms);
      if (advance) now += ms;
    },
  });
  const channelRoute = rateLimitRouteKey('POST', `/channels/${CHANNEL}/messages`);
  const otherRoute = rateLimitRouteKey('POST', `/channels/${OTHER_CHANNEL}/messages`);
  const untouchedRoute = rateLimitRouteKey('GET', `/channels/${OTHER_CHANNEL}/messages`);

  const delay = await limiter.penalize(channelRoute, {
    headers: new Map([['retry-after', '2']]),
    body: { retry_after: 2 },
  });
  assert.equal(delay, 2_000);
  await limiter.wait(otherRoute);
  assert.deepEqual(sleeps, [2_000], 'a channel 429 must not delay another channel');

  sleeps.length = 0;
  await limiter.penalize(otherRoute, {
    headers: new Map([['x-ratelimit-scope', 'global']]),
    body: { retry_after: 1 },
  });
  advance = true;
  // A route with no bucket state of its own still waits for the global pause.
  await limiter.wait(untouchedRoute);
  assert.deepEqual(sleeps, [1_000, 1_000], 'a global 429 delays unrelated routes too');
});

test('the rate limiter honours an abort while waiting', async () => {
  const limiter = new DiscordRateLimiter({ logger: { debug() {}, warn() {} } });
  const route = rateLimitRouteKey('POST', `/channels/${CHANNEL}/messages`);
  limiter.observe(route, new Map([
    ['x-ratelimit-remaining', '0'],
    ['x-ratelimit-reset-after', '5'],
  ]));
  const controller = new AbortController();
  controller.abort(new DOMException('caller stopped', 'AbortError'));
  await assert.rejects(
    limiter.wait(route, { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('one session runs one task at a time, in order', async () => {
  const queue = new WorkbenchQueue({ maxConcurrentTasks: 4, projectConcurrency: 4 });
  const events = [];
  let release;
  const first = queue.run({ sessionId: 's1', projectId: 'p1' }, async () => {
    events.push('first-start');
    await new Promise((resolve) => { release = resolve; });
    events.push('first-end');
    return 'first';
  });
  const second = queue.run({ sessionId: 's1', projectId: 'p1' }, async () => {
    events.push('second-start');
    return 'second';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  assert.equal(queue.pendingFor('s1'), 2);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
  assert.equal(queue.pendingFor('s1'), 0);
});

test('one project runs one task at a time while other projects proceed', async () => {
  const queue = new WorkbenchQueue({ maxConcurrentTasks: 4, projectConcurrency: 1 });
  const events = [];
  let release;
  const first = queue.run({ sessionId: 's1', projectId: 'p1' }, async () => {
    events.push('p1-a');
    await new Promise((resolve) => { release = resolve; });
    return 'a';
  });
  const second = queue.run({ sessionId: 's2', projectId: 'p1' }, async () => {
    events.push('p1-b');
    return 'b';
  });
  const other = queue.run({ sessionId: 's3', projectId: 'p2' }, async () => {
    events.push('p2');
    return 'c';
  });
  assert.equal(await other, 'c');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['p1-a', 'p2']);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(events, ['p1-a', 'p2', 'p1-b']);
});

test('the global limit bounds how many tasks run at once', async () => {
  const queue = new WorkbenchQueue({ maxConcurrentTasks: 1, projectConcurrency: 4 });
  const releases = [];
  const started = [];
  const tasks = ['a', 'b'].map((name) => queue.run({ sessionId: name, projectId: name }, async () => {
    started.push(name);
    await new Promise((resolve) => releases.push(resolve));
    return name;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a']);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b']);
  releases.shift()();
  assert.deepEqual(await Promise.all(tasks), ['a', 'b']);
});

test('a failing task releases its slot and propagates the error', async () => {
  const queue = new WorkbenchQueue({ maxConcurrentTasks: 1, projectConcurrency: 1 });
  await assert.rejects(
    queue.run({ sessionId: 's1', projectId: 'p1' }, async () => {
      throw new Error('boom');
    }),
    /boom/u,
  );
  assert.equal(await queue.run({ sessionId: 's1', projectId: 'p1' }, async () => 'ok'), 'ok');
  assert.deepEqual(queue.status().sessions, []);
});
