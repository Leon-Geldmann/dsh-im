import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordGuildWorkbench } from '../../../src/channels/discord/workbench/guild-workbench.mjs';
import { DiscordWorkbenchStore } from '../../../src/channels/discord/workbench/workbench-store.mjs';
import { DiscordInteractionHandler } from '../../../src/channels/discord/workbench/interactions.mjs';
import { WorkbenchCommands } from '../../../src/channels/discord/workbench/commands.mjs';
import { componentId } from '../../../src/channels/discord/workbench/session-card.mjs';

const GUILD = '444444444444444444';
const OTHER_GUILD = '444444444444444445';
const CATEGORY = '555555555555555555';
const CATEGORY_BETA = '555555555555555556';
const CATEGORY_GAMMA = '555555555555555557';
const CHANNEL = '222222222222222201';
const OPERATOR = '333333333333333333';
const STRANGER = '333333333333333399';
const APPLICATION = '1234567890123456789';

async function fixture(t, {
  sessionExists = async () => true,
  createSessionError = null,
  channels = [],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-int-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'projects');
  await mkdir(projectRoot);
  const store = await new DiscordWorkbenchStore(join(root, 'workbench.json')).load();
  await store.bindGuild(GUILD);
  await store.putProject({
    projectId: 'alpha',
    name: 'Alpha',
    categoryId: CATEGORY,
    workspacePath: join(projectRoot, 'alpha'),
  });
  await mkdir(join(projectRoot, 'alpha'));

  const calls = [];
  let nextId = 1;
  const api = {
    async listGuildChannels() { return []; },
    calls,
    async listChannelMessages() { return []; },
    async getChannel({ channelId }) {
      if ([CATEGORY, CATEGORY_BETA, CATEGORY_GAMMA].includes(channelId)) {
        return { id: channelId, type: 4 };
      }
      const channel = channels.find((item) => item.id === channelId);
      if (channel) return { ...channel, guild_id: GUILD };
      const error = new Error('Unknown Channel');
      error.status = 404;
      throw error;
    },
    async createGuildChannel(options) {
      const id = `7777777777777777${String(nextId).padStart(2, '0')}`;
      nextId += 1;
      calls.push({ operation: 'create-channel', resultId: id, ...options });
      channels.push({ id, type: options.type, parent_id: options.parentId, name: options.name });
      return channels.at(-1);
    },
    async deleteChannel(options) {
      calls.push({ operation: 'delete-channel', ...options });
    },
    async createMessage(options) {
      calls.push({ operation: 'create-message', ...options });
      return { id: '888888888888888801' };
    },
    async editMessage(options) {
      calls.push({ operation: 'edit-message', ...options });
      return { id: options.messageId };
    },
    async createInteractionResponse(options) {
      calls.push({ operation: 'interaction-response', ...options });
      return {};
    },
    async editInteractionResponse(options) {
      calls.push({ operation: 'edit-original', ...options });
      return {};
    },
    async createFollowupMessage(options) {
      calls.push({ operation: 'followup', ...options });
      return {};
    },
    async isSessionRunning() { return false; },
  };

  const harnessCalls = [];
  const harness = {
    async ensureRunning() { harnessCalls.push({ operation: 'ensure' }); return true; },
    async isSessionRunning(sessionId) { harnessCalls.push({ operation: 'running', sessionId }); return false; },
    async createSession(options = {}) {
      harnessCalls.push({ operation: 'create', options });
      if (createSessionError) throw createSessionError;
      return 'session-created';
    },
    async stopActiveTurn(sessionId) {
      harnessCalls.push({ operation: 'stop', sessionId });
      return true;
    },
    async steerActiveTurn(sessionId, text) {
      harnessCalls.push({ operation: 'steer', sessionId, text });
      return true;
    },
    async selectSessionModel(sessionId, selection) {
      harnessCalls.push({ operation: 'select-model', sessionId, selection });
      return { selected: selection };
    },
    async getSessionModels() {
      return {
        groups: [{
          id: 'llama-local',
          name: 'Local',
          models: [{ id: 'qwen3.8-27b', name: 'Qwen' }],
        }],
        current: { provider: 'llama-local', model: 'qwen3.8-27b' },
        failures: [], routable: true,
      };
    },
    async readSessionHistory() {
      return {
        hasMore: false,
        events: [
          { event: { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'hello there' }] } } },
        ],
      };
    },
    workspaceSession(sessionId) {
      return {
        sessionId,
        sessionExists: async () => sessionExists(sessionId),
        ask: async () => 'answer',
        renameTitle: async () => undefined,
      };
    },
  };

  const adminCalls = [];
  const admin = {
    async updateWorkbenchConfig(patch) {
      adminCalls.push({ operation: 'config', patch });
      return patch;
    },
    async reconnect() {
      adminCalls.push({ operation: 'reconnect' });
    },
    async setSessionSync(value) {
      adminCalls.push({ operation: 'sync', ...value });
    },
  };

  const workbench = new DiscordGuildWorkbench({
    config: {
      enabled: true,
      guildId: GUILD,
      allowedUserIds: [OPERATOR],
      projectRoots: [projectRoot],
      maxConcurrentTasks: 1,
      projectConcurrency: 1,
    },
    store,
    harness,
    logger: { warn() {}, error() {}, debug() {} },
  });
  const commands = new WorkbenchCommands({
    workbench, api, harness, admin, queue: workbench.queue,
    logger: { warn() {}, error() {}, debug() {} },
  });
  const interactions = new DiscordInteractionHandler({
    workbench,
    api,
    applicationId: APPLICATION,
    commands,
    logger: { warn() {}, error() {}, debug() {} },
  });
  const responses = () => calls.filter((call) => (
    call.operation === 'interaction-response'
    || call.operation === 'edit-original'
    || call.operation === 'followup'
  ));
  return {
    store, workbench, commands, interactions, api, harness, adminCalls, harnessCalls,
    projectRoot, calls, responses,
  };
}

function commandInteraction({ name, subcommand = null, options = {}, channelId = CHANNEL, guildId = GUILD, operatorId = OPERATOR } = {}) {
  return {
    id: `9999999999999999${String(Math.floor(Math.random() * 90) + 10)}`,
    token: 'interaction-token',
    application_id: APPLICATION,
    app_permissions: '66576',
    type: 2,
    guild_id: guildId,
    channel_id: channelId,
    member: { user: { id: operatorId } },
    data: {
      name,
      options: [
        ...(subcommand ? [{ type: 1, name: subcommand, options: Object.entries(options).map(([key, value]) => ({ name: key, value })) }] : []),
      ],
    },
  };
}

function componentInteraction(customId, { channelId = CHANNEL, guildId = GUILD, operatorId = OPERATOR, values = null } = {}) {
  return {
    id: `9999999999999999${String(Math.floor(Math.random() * 90) + 10)}`,
    token: 'interaction-token',
    application_id: APPLICATION,
    app_permissions: '66576',
    type: values ? 3 : 3,
    guild_id: guildId,
    channel_id: channelId,
    member: { user: { id: operatorId } },
    data: {
      custom_id: customId,
      component_type: values ? 3 : 2,
      ...(values ? { values } : {}),
    },
  };
}

function lastResponse(f) {
  return f.responses().at(-1);
}

test('a ping is acknowledged and a stranger or another guild is refused', async (t) => {
  const f = await fixture(t);
  await f.interactions.handle({ type: 1, id: '1', token: 'ping-token' });
  assert.deepEqual(lastResponse(f).body, { type: 1 });

  await f.interactions.handle(commandInteraction({ name: 'status', operatorId: STRANGER }));
  assert.match(lastResponse(f).body.data.content, /权限/u);

  await f.interactions.handle(commandInteraction({ name: 'status', guildId: OTHER_GUILD }));
  assert.match(lastResponse(f).body.data.content, /绑定的服务器/u);
});

test('/project bind registers a project only for a real, confined category directory', async (t) => {
  const f = await fixture(t);
  const inside = join(f.projectRoot, 'beta');
  await mkdir(inside);
  await f.interactions.handle(commandInteraction({
    name: 'project', subcommand: 'bind',
    options: { category: CATEGORY_BETA, path: inside, name: 'Beta' },
  }));
  const projects = f.store.listProjects().map((project) => project.projectId);
  assert.deepEqual(projects.sort(), ['alpha', 'beta']);
  assert.equal(f.store.project('beta').workspacePath, inside);
  assert.match(lastResponse(f).body.content ?? lastResponse(f).body.data.content, /Beta/u);

  await f.interactions.handle(commandInteraction({
    name: 'project', subcommand: 'bind',
    options: { category: CATEGORY_GAMMA, path: '/etc', name: 'Escape' },
  }));
  assert.equal(f.store.listProjects().length, 2);
  assert.match(f.responses().at(-1).body.content, /项目根目录/u);
});

test('/session new creates the channel, one Session, and the card', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.interactions.handle(commandInteraction({
    name: 'session', subcommand: 'new', options: { project: 'alpha', name: '任务' },
  }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  assert.equal(created.parentId, CATEGORY);
  assert.equal(created.type, 0);
  const restarted = f.store.channel(created.resultId);
  assert.equal(restarted.sessionId, 'session-created');
  assert.equal(restarted.projectId, 'alpha');
  assert.equal(f.store.session('session-created').channelId, created.resultId);
  // The card lands in the new channel with its action buttons.
  const card = f.calls.find((call) => call.operation === 'create-message' && call.channelId === created.resultId);
  assert.equal(Array.isArray(card.components), true);
  assert.equal(card.embeds[0].title.includes('Alpha'), true);
});

test('/session new keeps a half-created channel registered when the Session fails', async (t) => {
  const f = await fixture(t, { createSessionError: new Error('harness down') });
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.interactions.handle(commandInteraction({
    name: 'session', subcommand: 'new', options: { project: 'alpha', name: '任务' },
  }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  const channel = f.store.channel(created.resultId);
  assert.equal(channel.sessionId, null);
  assert.match(channel.lastError, /会话创建失败/u);
  const pending = f.store.listOperations();
  assert.ok(pending.some((op) => op.state === 'channel-created' && op.payload.channelId === created.resultId));
  assert.ok(pending.some((op) => op.state === 'session-creating' && op.payload.channelId === created.resultId));
  assert.match(lastResponse(f).body.content, /会话创建失败/u);
  await assert.rejects(f.workbench.router.createForChannel(created.resultId), { code: 'workbench-session-create-uncertain' });
  assert.equal(f.harnessCalls.filter((call) => call.operation === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call.operation === 'create-channel').length, 1);
});

test('/session open refuses a missing Session and keeps the old binding', async (t) => {
  const f = await fixture(t, { sessionExists: async () => false });
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'session-old');
  await f.interactions.handle(commandInteraction({
    name: 'session', subcommand: 'open', options: { session_id: 'session-missing' },
  }));
  assert.equal(f.store.channel(CHANNEL).sessionId, 'session-old');
  assert.match(lastResponse(f).body.content, /不存在/u);
});

test('archive keeps the channel, deep archive deletes it but keeps the Session', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha', title: 'Alpha main' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha', { title: 'Alpha main' });

  await f.interactions.handle(commandInteraction({ name: 'session', subcommand: 'archive' }));
  assert.equal(f.store.channel(CHANNEL).lifecycle, 'archived');
  assert.equal(f.calls.some((call) => call.operation === 'delete-channel'), false);

  await f.interactions.handle(commandInteraction({ name: 'session', subcommand: 'archive', options: { deep: true } }));
  const confirm = lastResponse(f).body.components[0].components[0].custom_id;
  assert.match(confirm, /^wb:deep-archive:/u);
  await f.interactions.handle(componentInteraction(confirm));
  assert.equal(f.calls.some((call) => call.operation === 'delete-channel' && call.channelId === CHANNEL), true);
  assert.equal(f.store.channel(CHANNEL), null);
  assert.equal(f.store.session('session-alpha').detached, true);
  assert.equal(f.store.session('session-alpha').title, 'Alpha main');
});

test('restore recreates a channel for the original Session', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha', title: 'Alpha main' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha', { title: 'Alpha main' });
  await f.store.setChannelLifecycle(CHANNEL, 'deep-archived');
  await f.store.detachChannel(CHANNEL);

  await f.interactions.handle(commandInteraction({
    name: 'session', subcommand: 'restore', options: { session_id: 'session-alpha' },
  }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  assert.equal(created.parentId, CATEGORY);
  assert.equal(created.name, 'Alpha main');
  assert.equal(f.store.channel(created.resultId).sessionId, 'session-alpha');
  assert.equal(f.store.channel(created.resultId).lifecycle, 'active');
  assert.match(lastResponse(f).body.content, /session-alpha/u);
});

test('component clicks are single-use and scoped to operator, guild and channel', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha');
  await f.store.putAction({
    actionId: 'act-1', kind: 'refresh', operatorId: OPERATOR, guildId: GUILD,
    channelId: CHANNEL, expiresAt: Date.now() + 60_000,
  });
  const id = componentId('refresh', 'act-1');

  await f.interactions.handle(componentInteraction(id, { operatorId: STRANGER }));
  assert.match(lastResponse(f).body.data.content, /没有执行该操作的权限|不属于你/u);
  await f.interactions.handle(componentInteraction(id, { channelId: '222222222222222299' }));
  assert.match(lastResponse(f).body.data.content, /不属于当前频道/u);

  await f.interactions.handle(componentInteraction(id));
  const answered = f.responses();
  assert.equal(answered.some((reply) => reply.operation === 'interaction-response' && reply.body.type === 5), true);
  assert.equal(answered.at(-1).operation, 'edit-original');
  await f.interactions.handle(componentInteraction(id));
  assert.match(lastResponse(f).body.data.content, /已经执行过/u);
});

test('/model lists the session catalog and applies a selection', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha');
  await f.interactions.handle(commandInteraction({ name: 'model' }));
  const select = lastResponse(f).body.components[0].components[0];
  assert.equal(select.type, 3);
  assert.equal(select.options[0].value, 'llama-local/qwen3.8-27b');

  const actionId = select.custom_id.split(':')[2];
  await f.interactions.handle(componentInteraction(componentId('model', actionId), {
    values: ['llama-local/qwen3.8-27b'],
  }));
  assert.deepEqual(
    f.harnessCalls.filter((call) => call.operation === 'select-model').at(-1),
    { operation: 'select-model', sessionId: 'session-alpha', selection: { provider: 'llama-local', model: 'qwen3.8-27b' } },
  );
});

test('/task stop and steer reach the running Session', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha');
  await f.interactions.handle(commandInteraction({ name: 'task', subcommand: 'stop' }));
  assert.equal(f.harnessCalls.some((call) => call.operation === 'stop' && call.sessionId === 'session-alpha'), true);
  await f.interactions.handle(commandInteraction({ name: 'task', subcommand: 'steer', options: { text: '换个思路' } }));
  assert.deepEqual(
    f.harnessCalls.filter((call) => call.operation === 'steer').at(-1),
    { operation: 'steer', sessionId: 'session-alpha', text: '换个思路' },
  );
});

test('/workbench bind persists the binding and reconnects', async (t) => {
  const f = await fixture(t);
  await f.interactions.handle(commandInteraction({ name: 'workbench', subcommand: 'bind' }));
  assert.deepEqual(f.adminCalls, [
    { operation: 'config', patch: { enabled: true, guildId: GUILD } },
    { operation: 'reconnect' },
  ]);
});

test('/status reports connection, workbench and channel state', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha');
  await f.interactions.handle(commandInteraction({ name: 'status' }));
  const text = lastResponse(f).body.content;
  assert.match(text, /Harness/u);
  assert.match(text, /session-alpha/u);
});

test('/session sync stores the channel binding and clears it on off', async (t) => {
  const f = await fixture(t);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'session-alpha');
  await f.interactions.handle(commandInteraction({
    name: 'session', subcommand: 'sync', options: { action: 'on' },
  }));
  assert.deepEqual(f.adminCalls.filter((call) => call.operation === 'sync'), [
    { operation: 'sync', channelId: CHANNEL, sessionId: 'session-alpha', enabled: true },
  ]);
  assert.match(f.responses().at(-1).body.content, /已开启双向同步/u);
});
