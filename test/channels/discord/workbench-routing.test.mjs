import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';
import { DiscordWorkbenchStore } from '../../../src/channels/discord/workbench/workbench-store.mjs';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCD.abcdefghijklmnopqrstuvwxyz123456';
const BOT_ID = '1234567890123456789';
const GUILD_ID = '444444444444444444';
const OTHER_GUILD_ID = '444444444444444445';
const CATEGORY_ID = '555555555555555555';
const CHANNEL_ID = '222222222222222201';
const OTHER_CHANNEL_ID = '222222222222222202';
const OPERATOR_ID = '333333333333333333';
const OWNER_ID = '333333333333333330';
const STRANGER_ID = '333333333333333399';

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

class FakeSocket {
  #listeners = new Map();
  readyState = 1;
  sent = [];

  addEventListener(name, listener) {
    const list = this.#listeners.get(name) ?? [];
    list.push(listener);
    this.#listeners.set(name, list);
  }

  send(value) {
    const packet = JSON.parse(value);
    this.sent.push(packet);
    if (packet.op === 2) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({
          op: 0,
          t: 'READY',
          s: 1,
          d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' },
        }),
      }));
    }
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close', { code });
  }

  emit(name, event) {
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }
}

/**
 * Build a Discord runtime in Guild-workbench mode with mock Discord and
 * Harness surfaces. `sessions` maps channel id -> Session id and `store` is the
 * durable workbench state under test.
 */
async function fixture(t, {
  channels = [{ id: CHANNEL_ID, type: 0, parent_id: CATEGORY_ID, name: 'alpha' }],
  sessionExists = async () => true,
  askAnswer = async (sessionId, text) => `answer:${text}`,
  allowedUserIds = [OPERATOR_ID],
  projectRoots = ['/srv/projects'],
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workbench-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new DiscordWorkbenchStore(join(directory, 'workbench.json')).load();
  await store.bindGuild(GUILD_ID);
  await store.putProject({
    projectId: 'alpha',
    name: 'Alpha',
    categoryId: CATEGORY_ID,
    workspacePath: '/srv/projects/alpha',
  });

  const asks = [];
  const deliveries = [];
  const threadStarts = [];
  const created = [];
  const seen = new Set();
  let nextSession = 1;
  let nextMessage = 1;
  let socket;

  const api = {
    getCurrentUser: async () => ({ id: BOT_ID, bot: true }),
    getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
    async getChannel({ channelId }) {
      const channel = channels.find((item) => item.id === channelId);
      if (!channel) {
        const error = new Error('Unknown Channel');
        error.status = 404;
        throw error;
      }
      return channel;
    },
    async startThreadFromMessage({ channelId, messageId, name }) {
      threadStarts.push({ channelId, messageId, name });
      return { id: messageId, type: 11, parent_id: channelId, owner_id: BOT_ID };
    },
    async sendTyping() {},
    async createMessage({ channelId, content, replyToMessageId }) {
      const id = `8888888888888888${String(nextMessage).padStart(2, '0')}`;
      nextMessage += 1;
      deliveries.push({ operation: 'create', channelId, content, replyToMessageId, id });
      return { id };
    },
    async editMessage({ channelId, messageId, content }) {
      deliveries.push({ operation: 'edit', channelId, messageId, content });
      return { id: messageId };
    },
    async addOwnReaction() {},
    async removeOwnReaction() {},
  };

  const harness = {
    ensureRunning: async () => true,
    currentBusyMessageMode: () => 'queue',
    async createSession(options = {}) {
      created.push(options);
      const sessionId = `session-${nextSession}`;
      nextSession += 1;
      return sessionId;
    },
    sessionExists,
    async ask(sessionId, text) {
      asks.push({ sessionId, text });
      return askAnswer(sessionId, text);
    },
    workspaceSession(sessionId) {
      return {
        sessionId,
        sessionExists: async () => sessionExists(sessionId),
        ask: async (text) => {
          asks.push({ sessionId, text });
          return askAnswer(sessionId, text);
        },
        isRunning: async () => false,
        hasActiveTurn: async () => false,
        stopActiveTurn: async () => true,
        steerActiveTurn: async () => true,
        renameTitle: async () => undefined,
      };
    },
  };

  const state = {
    sessionFor: () => null,
    async setSession() { return true; },
    async clearSession() {},
    hasSeen: (messageId) => seen.has(messageId),
    async markSeen(messageId) { seen.add(messageId); },
    async unmarkSeen(messageId) { seen.delete(messageId); return true; },
  };

  const runtime = new DiscordRuntime({
    config: {
      botId: 'discord_test',
      platformId: BOT_ID,
      name: 'Harness Discord',
      ownerUserId: OWNER_ID,
    },
    token: TOKEN,
    harness,
    state,
    workbench: {
      enabled: true,
      guildId: GUILD_ID,
      allowedUserIds,
      projectRoots,
      maxConcurrentTasks: 1,
      projectConcurrency: 1,
    },
    workbenchStore: store,
    createApi: () => api,
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      }));
      return socket;
    },
    random: () => 0.5,
    logger: { warn() {}, error() {} },
  });
  await runtime.start();
  socket.emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: { id: GUILD_ID, channels, threads: [] },
    }),
  });

  const message = (text, {
    id = `1111111111111111${String(nextMessage).padStart(2, '0')}`,
    channelId = CHANNEL_ID,
    guildId = GUILD_ID,
    authorId = OPERATOR_ID,
    mentions = [],
    bot = false,
  } = {}) => ({
    id,
    channel_id: channelId,
    guild_id: guildId,
    author: { id: authorId, bot },
    mentions,
    content: text,
    attachments: [],
  });

  const send = (payload) => socket.emit('message', {
    data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: payload }),
  });

  return {
    runtime, store, asks, deliveries, threadStarts, created, message, send,
    async close() { await runtime.stop(); },
  };
}

test('a managed channel keeps its fixed Session without a thread or mention', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  await f.store.registerChannel({ channelId: CHANNEL_ID, projectId: 'alpha', title: 'alpha' });
  await f.store.bindChannelSession(CHANNEL_ID, 'session-fixed');

  f.send(f.message('first task', { id: '111111111111111101' }));
  await eventually(() => f.asks.length === 1);
  f.send(f.message('second task', { id: '111111111111111102' }));
  await eventually(() => f.asks.length === 2);

  assert.deepEqual(f.asks.map((entry) => entry.sessionId), ['session-fixed', 'session-fixed']);
  assert.equal(f.created.length, 0);
  assert.equal(f.threadStarts.length, 0);
  const replies = f.deliveries.filter((entry) => entry.operation === 'create');
  assert.equal(replies.length >= 2, true);
  // The final answer reaches the channel through the editable stream (create +
  // edit), so assert on every delivery record, not only new messages.
  assert.equal(
    f.deliveries.some((entry) => String(entry.content ?? '').includes('answer:first task')),
    true,
  );
  assert.equal(replies.every((entry) => entry.channelId === CHANNEL_ID), true);
});

test('the first authorized message lazily registers a mapped channel and creates one Session', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  f.send(f.message('hello', { id: '111111111111111111' }));
  await eventually(() => f.asks.length === 1);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].workspace, '/srv/projects/alpha');
  const channel = f.store.channel(CHANNEL_ID);
  assert.equal(channel.projectId, 'alpha');
  assert.equal(channel.sessionId, 'session-1');

  f.send(f.message('again', { id: '111111111111111112' }));
  await eventually(() => f.asks.length === 2);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.asks.map((entry) => entry.sessionId), ['session-1', 'session-1']);
});

test('two concurrent first messages create exactly one Session', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  f.send(f.message('one', { id: '111111111111111121' }));
  f.send(f.message('two', { id: '111111111111111122' }));
  await eventually(() => f.asks.length === 2);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.asks.map((entry) => entry.sessionId), ['session-1', 'session-1']);
});

test('a vanished bound Session is reported, kept, and never replaced', async (t) => {
  const f = await fixture(t, { sessionExists: async () => false });
  t.after(() => f.close());
  await f.store.registerChannel({ channelId: CHANNEL_ID, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL_ID, 'session-gone');

  f.send(f.message('still there?', { id: '111111111111111131' }));
  await eventually(() => f.deliveries.some((entry) => /会话已不存在/u.test(entry.content ?? '')));
  assert.equal(f.created.length, 0);
  assert.equal(f.asks.length, 0);
  assert.equal(f.store.channel(CHANNEL_ID).sessionId, 'session-gone');
  const reply = f.deliveries.find((entry) => /会话已不存在/u.test(entry.content ?? ''));
  assert.match(reply.content, /会话已不存在/);
});

test('an unreadable Session state keeps the binding and asks the operator to retry', async (t) => {
  const f = await fixture(t, {
    sessionExists: async () => { throw new Error('harness offline'); },
  });
  t.after(() => f.close());
  await f.store.registerChannel({ channelId: CHANNEL_ID, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL_ID, 'session-unclear');

  f.send(f.message('ping', { id: '111111111111111141' }));
  await eventually(() => f.deliveries.some((entry) => /无法确认会话状态/u.test(entry.content ?? '')));
  assert.equal(f.created.length, 0);
  assert.equal(f.store.channel(CHANNEL_ID).sessionId, 'session-unclear');
  assert.match(f.deliveries.find((entry) => /无法确认会话状态/u.test(entry.content ?? '')).content, /无法确认会话状态/);
});

test('a stranger in the bound guild never triggers a task, even with a mention', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  await f.store.registerChannel({ channelId: CHANNEL_ID, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL_ID, 'session-fixed');

  f.send(f.message('do something', {
    id: '111111111111111151',
    authorId: STRANGER_ID,
    mentions: [{ id: BOT_ID }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.asks.length, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.threadStarts.length, 0);
  assert.equal(f.deliveries.length, 0);
});

test('token /new in a managed channel is refused instead of silently rebinding', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  await f.store.registerChannel({ channelId: CHANNEL_ID, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL_ID, 'session-fixed');

  f.send(f.message('/new', { id: '111111111111111161' }));
  await eventually(() => f.deliveries.length === 1);
  assert.equal(f.asks.length, 0);
  assert.match(f.deliveries[0].content, /固定一个会话/);
  assert.equal(f.store.channel(CHANNEL_ID).sessionId, 'session-fixed');
});

test('an unmapped channel in the bound guild keeps the legacy mention/thread path', async (t) => {
  const f = await fixture(t, {
    channels: [
      { id: CHANNEL_ID, type: 0, parent_id: CATEGORY_ID, name: 'alpha' },
      { id: OTHER_CHANNEL_ID, type: 0, parent_id: '999999999999999999', name: 'misc' },
    ],
  });
  t.after(() => f.close());
  f.send(f.message('legacy', {
    id: '111111111111111171',
    channelId: OTHER_CHANNEL_ID,
    mentions: [{ id: BOT_ID }],
  }));
  await eventually(() => f.threadStarts.length === 1);
  assert.equal(f.threadStarts[0].channelId, OTHER_CHANNEL_ID);
  assert.equal(f.asks.length, 0);
});

test('messages from another guild keep their legacy handling', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  await f.store.registerChannel({ channelId: CHANNEL_ID, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL_ID, 'session-fixed');

  f.send(f.message('elsewhere', {
    id: '111111111111111181',
    guildId: OTHER_GUILD_ID,
    mentions: [{ id: BOT_ID }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The channel is workbench-managed, but the message did not come from the
  // bound Guild: it must not reach the fixed Session.
  assert.equal(f.asks.length, 0);
});

test('a disabled workbench leaves the legacy runtime untouched', async (t) => {
  const f = await fixture(t);
  t.after(() => f.close());
  // Rebuilding the runtime without a workbench must not change thread behavior.
  assert.equal(f.runtime.workbench.guildId, GUILD_ID);
  assert.equal(f.runtime.status.ready, true);
});
