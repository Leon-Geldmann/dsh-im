import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import {
  DiscordRateLimiter,
  rateLimitRouteKey,
} from '../../../src/channels/discord/workbench/rate-limiter.mjs';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCD.abcdefghijklmnopqrstuvwxyz123456';
const CHANNEL = '222222222222222201';
const OTHER_CHANNEL = '222222222222222202';
const MESSAGE = '888888888888888801';
const APPLICATION = '123456789012345678';
const INTERACTION_TOKEN = 'interaction-secret-token';
const QUIET = { debug() {}, warn() {} };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function clock() {
  let now = 1_000;
  const sleeps = [];
  const limiter = new DiscordRateLimiter({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    logger: QUIET,
  });
  return { limiter, sleeps, now: () => now };
}

test('successful interaction acknowledgements accept an empty 204 response', async () => {
  const api = new DiscordApi({ token: TOKEN, fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(await api.createInteractionResponse({
    interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN, body: { type: 5 },
  }), null);
});

test('interaction acknowledgements with_response retain the returned resource', async () => {
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('with_response'), 'true');
      return json({ type: 4, resource: { message: { id: MESSAGE } } });
    },
  });
  assert.equal((await api.createInteractionResponse({
    interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN,
    body: { type: 4, data: { content: 'done' } }, withResponse: true,
  })).resource.message.id, MESSAGE);
});

test('all message endpoints apply safe mention defaults without changing caller payloads', async () => {
  const payloads = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (_url, { body }) => { payloads.push(JSON.parse(body)); return json({ id: MESSAGE }); },
  });
  const body = { content: '@everyone <@123456789012345678>' };
  await api.createInteractionResponse({
    interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN, body: { type: 4, data: body },
  });
  await api.createInteractionResponse({
    interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN, body: { type: 7, data: body },
  });
  await api.editInteractionResponse({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body });
  await api.createFollowupMessage({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body });
  await api.createMessage({ channelId: CHANNEL, content: body.content, allowedMentions: { users: [APPLICATION] } });
  await api.editMessage({ channelId: CHANNEL, messageId: MESSAGE, content: body.content, allowedMentions: { users: [APPLICATION] } });
  for (const payload of payloads) {
    const mentions = (payload.data ?? payload).allowed_mentions;
    assert.deepEqual(mentions.parse, []);
    assert.equal(mentions.replied_user, false);
  }
  assert.deepEqual(payloads[4].allowed_mentions.users, [APPLICATION]);
  assert.deepEqual(body, { content: '@everyone <@123456789012345678>' });
});

test('explicit mention opt-ins survive while modal data stays unchanged', async () => {
  const payloads = [];
  const api = new DiscordApi({
    token: TOKEN,
    fetchImpl: async (_url, { body }) => { payloads.push(JSON.parse(body)); return json({ id: MESSAGE }); },
  });
  const body = { content: '@everyone', allowed_mentions: { parse: ['everyone'], replied_user: true } };
  await api.createFollowupMessage({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body });
  const modal = { type: 9, data: { title: 'Name', custom_id: 'name', components: [] } };
  await api.createInteractionResponse({ interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN, body: modal });
  assert.deepEqual(payloads, [body, modal]);
});

test('missing or malformed limit headers do not erase an exhausted bucket', async () => {
  const { limiter, sleeps } = clock();
  const route = rateLimitRouteKey('POST', `channels/${CHANNEL}/messages`);
  limiter.observe(route, new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' }));
  limiter.observe(route, new Headers());
  limiter.observe(route, new Headers({ 'x-ratelimit-remaining': '', 'x-ratelimit-reset-after': 'bad' }));
  await limiter.wait(route);
  assert.deepEqual(sleeps, [2_000]);
});

test('rate delays use valid fallback values and never shorten a provider cooldown', async () => {
  for (const [body, headers, expected] of [
    [undefined, {}, 1_000],
    [{ retry_after: 'invalid' }, { 'retry-after': '1.25' }, 1_250],
    [undefined, { 'x-ratelimit-reset-after': '2.5' }, 2_500],
    [{ retry_after: 125 }, {}, 125_000],
  ]) {
    const { limiter, sleeps } = clock();
    assert.equal(await limiter.penalize('GET /example', { body, headers: new Headers(headers) }), expected);
    assert.deepEqual(sleeps, [expected]);
  }
});

test('server bucket IDs share capacity across methods only within the same major parameter', async () => {
  const { limiter, sleeps } = clock();
  const create = rateLimitRouteKey('POST', `channels/${CHANNEL}/messages`);
  const edit = rateLimitRouteKey('PATCH', `channels/${CHANNEL}/messages/${MESSAGE}`);
  const other = rateLimitRouteKey('POST', `channels/${OTHER_CHANNEL}/messages`);
  for (const route of [create, edit, other]) {
    limiter.observe(route, new Headers({
      'x-ratelimit-bucket': 'shared-messages', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset-after': '2',
    }));
  }
  await limiter.wait(create);
  await limiter.wait(other);
  assert.deepEqual(sleeps, []);
  await limiter.wait(edit);
  assert.deepEqual(sleeps, [2_000]);
});

test('out-of-order responses do not restore spent capacity in an active bucket', async () => {
  const { limiter, sleeps } = clock();
  const route = rateLimitRouteKey('POST', `channels/${CHANNEL}/messages`);
  limiter.observe(route, new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' }));
  limiter.observe(route, new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset-after': '1' }));
  await limiter.wait(route);
  assert.deepEqual(sleeps, [2_000]);
});

test('route keys collapse reaction emoji and keep repeated snowflakes in their proper positions', () => {
  assert.equal(rateLimitRouteKey('PATCH', `channels/${CHANNEL}/messages/${CHANNEL}`),
    `PATCH /channels/{major}/messages/{id}#${CHANNEL}`);
  assert.equal(rateLimitRouteKey('PUT', `channels/${CHANNEL}/messages/${MESSAGE}/reactions/a%3A123456789012345678/@me`),
    rateLimitRouteKey('PUT', `channels/${CHANNEL}/messages/${MESSAGE}/reactions/b%3A123456789012345679/@me`));
});

test('webhook bucket keys isolate tokens without exposing them in snapshots or logs', async () => {
  const logs = [];
  const limiter = new DiscordRateLimiter({
    now: () => 1_000, sleep: async () => {},
    logger: { debug: (value) => logs.push(value), warn: (value) => logs.push(value) },
  });
  const first = rateLimitRouteKey('POST', `webhooks/${APPLICATION}/${INTERACTION_TOKEN}`);
  const second = rateLimitRouteKey('POST', `webhooks/${APPLICATION}/another-secret-token`);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /interaction-secret-token/);
  assert.doesNotMatch(rateLimitRouteKey('POST', `interactions/${MESSAGE}/${INTERACTION_TOKEN}/callback`), /interaction-secret-token/);
  limiter.observe(first, new Headers({ 'x-ratelimit-bucket': 'webhook', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1' }));
  limiter.observe(second, new Headers({ 'x-ratelimit-bucket': 'webhook', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset-after': '1' }));
  await limiter.wait(second);
  assert.doesNotMatch(JSON.stringify([limiter.snapshot(), logs]), /interaction-secret-token|another-secret-token/);
});

test('an already-aborted request never dispatches even when its bucket is open', async () => {
  const controller = new AbortController();
  const reason = new Error('stopped');
  controller.abort(reason);
  const { limiter } = clock();
  await assert.rejects(limiter.wait('GET /open', { signal: controller.signal }), (error) => error === reason);
  let requests = 0;
  const api = new DiscordApi({ token: TOKEN, fetchImpl: async () => { requests += 1; return json({}); } });
  await assert.rejects(api.getCurrentUser({ signal: controller.signal }), (error) => error === reason);
  assert.equal(requests, 0);
});

test('completed rate waits release their abort listeners', async () => {
  const signal = new AbortController().signal;
  const limiter = new DiscordRateLimiter({ logger: QUIET });
  for (let index = 0; index < 3; index += 1) {
    limiter.observe('GET /example', new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.002' }));
    await limiter.wait('GET /example', { signal });
  }
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('a terminal global 429 blocks later bot requests without delaying the rejected call', async () => {
  const { limiter, sleeps } = clock();
  let requests = 0;
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async () => {
    requests += 1;
    return requests === 1 ? json({ global: true, retry_after: 2 }, 429) : json({ id: APPLICATION });
  } });
  await assert.rejects(api.getCurrentUser({ retry: false }), { code: 'discord-429' });
  assert.deepEqual(sleeps, []);
  await api.getCurrentApplication();
  assert.deepEqual(sleeps, [2_000]);
});

test('a second 429 installs its full cooldown for the next request', async () => {
  const { limiter, sleeps } = clock();
  let requests = 0;
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async () => {
    requests += 1;
    return requests <= 2 ? json({ retry_after: requests }, 429) : json({ id: MESSAGE });
  } });
  await assert.rejects(api.createMessage({ channelId: CHANNEL, content: 'done' }), { code: 'discord-429' });
  assert.deepEqual(sleeps, [1_000]);
  await api.createMessage({ channelId: CHANNEL, content: 'next' });
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.equal(requests, 3);
});

test('interaction callbacks and webhook responses bypass a bot global cooldown', async () => {
  const { limiter, sleeps } = clock();
  await limiter.penalize('GET /users/@me', { body: { global: true, retry_after: 5 }, wait: false });
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.authorization, undefined);
    return json({ id: MESSAGE });
  } });
  await api.createInteractionResponse({ interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN, body: { type: 5 } });
  await api.editInteractionResponse({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body: { content: 'done' } });
  await api.createFollowupMessage({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body: { content: 'done' } });
  assert.deepEqual(sleeps, []);
  await limiter.wait('GET /users/@me');
  assert.deepEqual(sleeps, [5_000]);
});

test('token-authenticated global 429s pause token requests without blocking the bot', async () => {
  const { limiter, sleeps } = clock();
  let requests = 0;
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async () => {
    requests += 1;
    return requests === 1 ? json({ global: true, retry_after: 2 }, 429) : json({ id: MESSAGE });
  } });
  await assert.rejects(api.createInteractionResponse({
    interactionId: MESSAGE, interactionToken: INTERACTION_TOKEN, body: { type: 5 },
  }), { code: 'discord-429' });
  await api.getCurrentUser();
  assert.deepEqual(sleeps, []);
  await api.createFollowupMessage({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body: { content: 'done' } });
  assert.deepEqual(sleeps, [2_000]);
});

test('non-JSON errors retain HTTP rejection details and obey Retry-After', async () => {
  const { limiter, sleeps } = clock();
  let requests = 0;
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async () => {
    requests += 1;
    return requests === 1
      ? new Response('rate limited', { status: 429, headers: { 'retry-after': '1.5' } })
      : json({ id: MESSAGE });
  } });
  assert.equal((await api.createMessage({ channelId: CHANNEL, content: 'done' })).id, MESSAGE);
  assert.deepEqual(sleeps, [1_500]);
  const denied = new DiscordApi({ token: TOKEN, fetchImpl: async () => new Response('denied', { status: 403 }) });
  await assert.rejects(denied.createFileMessage({ channelId: CHANNEL, file: { fileName: 'result.txt', bytes: Buffer.from('result') } }),
    { code: 'artifact-permission-required', status: 403 });
});

test('successful malformed JSON still updates rate headers and is never retried', async () => {
  const { limiter, sleeps } = clock();
  let requests = 0;
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async () => {
    requests += 1;
    return requests === 1 ? new Response('truncated', {
      status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' },
    }) : json({ id: MESSAGE });
  } });
  await assert.rejects(api.createMessage({ channelId: CHANNEL, content: 'done' }), /invalid JSON/);
  assert.equal(requests, 1);
  await api.createMessage({ channelId: CHANNEL, content: 'next' });
  assert.deepEqual(sleeps, [2_000]);
});

test('mutation transport and server failures never trigger blind retries', async () => {
  for (const fail of [
    () => { throw new TypeError('socket reset after write'); },
    () => json({ message: 'server error' }, 503),
    () => new Response('truncated', { status: 200 }),
  ]) {
    for (const mutate of [
      (api) => api.createMessage({ channelId: CHANNEL, content: 'done' }),
      (api) => api.startThreadFromMessage({ channelId: CHANNEL, messageId: MESSAGE, name: 'Task' }),
      (api) => api.createGuildChannel({ guildId: APPLICATION, name: 'task' }),
      (api) => api.editMessage({ channelId: CHANNEL, messageId: MESSAGE, content: 'done' }),
      (api) => api.createFollowupMessage({ applicationId: APPLICATION, interactionToken: INTERACTION_TOKEN, body: { content: 'done' } }),
      (api) => api.createFileMessage({ channelId: CHANNEL, file: { fileName: 'result.bin', bytes: Buffer.from('done') } }),
    ]) {
      let requests = 0;
      const api = new DiscordApi({ token: TOKEN, fetchImpl: async () => { requests += 1; return fail(); } });
      await assert.rejects(mutate(api));
      assert.equal(requests, 1);
    }
  }
});

test('multipart rate retries preserve bytes, metadata and nonce across an encoded HTTP request', async () => {
  const { limiter, sleeps } = clock();
  const payloads = [];
  const files = [];
  const api = new DiscordApi({ token: TOKEN, rateLimiter: limiter, fetchImpl: async (url, options) => {
    const request = new Request(url, options);
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    const form = await request.formData();
    payloads.push(JSON.parse(form.get('payload_json')));
    const file = form.get('files[0]');
    files.push({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return payloads.length === 1 ? json({ retry_after: 1 }, 429) : json({ id: MESSAGE });
  } });
  await api.createFileMessage({ channelId: CHANNEL, replyToMessageId: MESSAGE,
    file: { deliveryKey: 'turn:artifact', fileName: 'result.bin', mediaType: 'application/octet-stream', bytes: Buffer.from([0, 1, 255]) },
  });
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(payloads[0].attachments, [{ id: 0, filename: 'result.bin' }]);
  assert.equal(payloads[0].message_reference.message_id, MESSAGE);
  assert.equal(payloads[0].enforce_nonce, true);
  assert.deepEqual(payloads[0].allowed_mentions, { parse: [], replied_user: false });
  assert.deepEqual(files, [
    { name: 'result.bin', type: 'application/octet-stream', bytes: Buffer.from([0, 1, 255]) },
    { name: 'result.bin', type: 'application/octet-stream', bytes: Buffer.from([0, 1, 255]) },
  ]);
  assert.deepEqual(sleeps, [1_000]);
});

test('attachment nonces are stable per destination without deduplicating delivery to another channel', async () => {
  const nonces = [];
  const api = new DiscordApi({ token: TOKEN, fetchImpl: async (_url, { body }) => {
    nonces.push(JSON.parse(body.get('payload_json')).nonce);
    return json({ id: MESSAGE });
  } });
  const file = { artifactId: 'shared-artifact', fileName: 'result.bin', bytes: Buffer.from('done') };
  for (const channelId of [CHANNEL, CHANNEL, OTHER_CHANNEL]) await api.createFileMessage({ channelId, file });
  assert.equal(nonces[0], nonces[1]);
  assert.notEqual(nonces[0], nonces[2]);
});
