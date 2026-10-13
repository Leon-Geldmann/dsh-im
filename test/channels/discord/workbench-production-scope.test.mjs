import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProductionController } from '../../../plugin-src/host/channels/discord/production.mjs';
import { DiscordStateStore } from '../../../src/channels/discord/state-store.mjs';
import { DiscordGuildWorkbench } from '../../../src/channels/discord/workbench/guild-workbench.mjs';
import { DiscordWorkbenchStore } from '../../../src/channels/discord/workbench/workbench-store.mjs';
import {
  BotWorkspaceStore, createBotWorkspaceScope,
} from '../../../src/channels/shared/bot-workspace-store.mjs';
import { runControlCommand } from '../../../src/channels/shared/control-command.mjs';
import { withSessionBindingLock } from '../../../src/channels/shared/session-binding-lock.mjs';
import { askInWorkspaceSession } from '../../../src/channels/shared/workspace-session.mjs';

const BOT_ID = 'discord_scope_bot';
const GUILD_ID = '444444444444444444';
const CHANNEL_A = '222222222222222201';
const CHANNEL_B = '222222222222222202';
const OTHER_KEY = 'direct:unmanaged';
const config = { enabled: true, guildId: GUILD_ID };
const logger = { warn() {}, error() {}, info() {}, debug() {} };

class RawHarness {
  created = [];
  asked = [];
  stopped = [];
  sessions = new Map();
  beforeCreate = null;

  async createSession(options) {
    await this.beforeCreate?.(options);
    const sessionId = `created-${this.created.length + 1}`;
    this.created.push({ sessionId, ...options });
    this.sessions.set(sessionId, options.workspace);
    return sessionId;
  }

  async sessionExists(sessionId) { return this.sessions.has(sessionId); }
  async ask(sessionId, text, options) {
    this.asked.push({ sessionId, text, options, workspace: this.sessions.get(sessionId) });
    await options?.onPromptState?.({ state: 'started' });
    return 'answer';
  }

  async stopActiveTurn(sessionId) { this.stopped.push(sessionId); return true; }
  stopManagedProcess() {}
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workbench-scope-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const defaultWorkspace = join(root, 'default');
  const workspaceA = join(root, 'alpha');
  const workspaceB = join(root, 'beta');
  await Promise.all([defaultWorkspace, workspaceA, workspaceB].map((path) => mkdir(path)));
  const workspacePath = join(root, 'workspaces.json');
  const workspaces = await new BotWorkspaceStore(workspacePath, { defaultWorkspace }).load();
  await workspaces.ensure(BOT_ID);
  const statePath = join(root, 'state.json');
  const state = await new DiscordStateStore(statePath).load();
  await state.setSession(OTHER_KEY, 'unmanaged-session');
  const storePath = join(root, 'workbench.json');
  const store = await new DiscordWorkbenchStore(storePath).load();
  await store.bindGuild(GUILD_ID);
  for (const [projectId, categoryId, workspace, channelId] of [
    ['alpha', '555555555555555551', workspaceA, CHANNEL_A],
    ['beta', '555555555555555552', workspaceB, CHANNEL_B],
  ]) {
    await store.putProject({ projectId, name: projectId, categoryId, workspacePath: workspace });
    await store.registerChannel({ channelId, projectId });
  }
  const raw = new RawHarness();
  const scope = createBotWorkspaceScope(raw, { botId: BOT_ID, workspaces, state });
  const workbench = new DiscordGuildWorkbench({ config, store, ...scope, logger });
  const ask = (channelId, askOptions) => askInWorkspaceSession({
    ...scope,
    key: `group:${channelId}`,
    text: 'task',
    askOptions,
    resolveSession: (context) => workbench.sessionResolver({
      ...context, message: { conversationId: channelId },
    }),
  });
  return {
    root, workspacePath, statePath, storePath, defaultWorkspace, workspaceA, workspaceB,
    workspaces, state, store, raw, scope, workbench, ask,
  };
}

test('real production scope creates and asks in each channel project without changing the bot default', async (t) => {
  const f = await fixture(t);
  const promptStates = [];
  const onPromptState = (value) => promptStates.push(value);
  await f.ask(CHANNEL_A, { onPromptState });
  await f.ask(CHANNEL_B);

  assert.deepEqual(f.raw.created.map(({ workspace }) => workspace), [f.workspaceA, f.workspaceB]);
  assert.deepEqual(f.raw.asked.map(({ workspace }) => workspace), [f.workspaceA, f.workspaceB]);
  assert.equal(f.raw.asked[0].options.onPromptState, onPromptState);
  assert.deepEqual(promptStates, [{ state: 'started' }]);
  assert.equal(f.workspaces.workspaceFor(BOT_ID), f.defaultWorkspace);
  assert.equal(f.state.sessionFor(OTHER_KEY), 'unmanaged-session');
  assert.equal(f.scope.state.sessionFor(`group:${CHANNEL_A}`), f.store.channel(CHANNEL_A).sessionId);
  assert.equal(f.scope.state.sessionFor(`group:${CHANNEL_B}`), f.store.channel(CHANNEL_B).sessionId);
});

test('channel preparation restores the fixed control binding with one workspace switch', async (t) => {
  const f = await fixture(t);
  const key = `group:${CHANNEL_A}`;
  f.raw.sessions.set('fixed', f.workspaceA);
  await f.store.bindChannelSession(CHANNEL_A, 'fixed');

  await Promise.all([f.workbench.prepareChannel(CHANNEL_A), f.workbench.prepareChannel(CHANNEL_A)]);
  const generation = f.scope.harness.conversationWorkspaceGeneration(key);
  const session = f.scope.harness.workspaceSession('fixed', key);
  await f.workbench.prepareChannel(CHANNEL_A);

  assert.equal(f.scope.harness.currentConversationWorkspace(key), f.workspaceA);
  assert.equal(f.scope.harness.conversationWorkspaceGeneration(key), generation);
  assert.equal(await session.sessionExists(), true);
  assert.equal(f.scope.state.sessionFor(key), 'fixed');
  assert.equal(f.state.sessionFor(OTHER_KEY), 'unmanaged-session');
  assert.equal(f.workspaces.workspaceFor(BOT_ID), f.defaultWorkspace);
  assert.equal((await runControlCommand('/stop', f.scope.harness, f.scope.state, key)).stopped, true);
  assert.deepEqual(f.raw.stopped, ['fixed']);
  assert.equal(f.raw.created.length, 0);
});

test('concurrent first asks for a project create only one session', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.ask(CHANNEL_A), f.ask(CHANNEL_A)]);
  assert.equal(f.raw.created.length, 1);
  assert.equal(f.raw.created[0].workspace, f.workspaceA);
  assert.deepEqual(f.raw.asked.map(({ sessionId }) => sessionId), ['created-1', 'created-1']);
});

test('commands can prepare a channel while holding its creation lock', { timeout: 1_000 }, async (t) => {
  const f = await fixture(t);
  await withSessionBindingLock(f.store, `channel:${CHANNEL_A}`, () => f.workbench.prepareChannel(CHANNEL_A));
  assert.equal(f.scope.harness.currentConversationWorkspace(`group:${CHANNEL_A}`), f.workspaceA);
});

for (const unavailable of ['missing', 'unreadable']) {
  test(`a ${unavailable} fixed session is preserved without replacement through the real scope`, async (t) => {
    const f = await fixture(t);
    await f.store.bindChannelSession(CHANNEL_A, 'fixed');
    if (unavailable === 'unreadable') {
      f.raw.sessionExists = async () => { throw new Error('read failed'); };
    }
    await assert.rejects(f.ask(CHANNEL_A), {
      code: unavailable === 'missing' ? 'workbench-session-missing' : 'workbench-session-unverified',
    });
    assert.equal(f.store.channel(CHANNEL_A).sessionId, 'fixed');
    assert.equal(f.scope.state.sessionFor(`group:${CHANNEL_A}`), 'fixed');
    assert.equal(f.raw.created.length, 0);
  });
}

test('session creation is journaled before the raw transport runs', async (t) => {
  const f = await fixture(t);
  f.raw.beforeCreate = async () => {
    const durable = await new DiscordWorkbenchStore(f.storePath).load();
    const operation = durable.listOperations().find((item) => item.payload.channelId === CHANNEL_A);
    assert.ok(operation, 'creation intent must be durable before the irreversible request');
    assert.equal(operation.payload.projectId, 'alpha');
    assert.equal(operation.payload.workspacePath, f.workspaceA);
  };
  await f.ask(CHANNEL_A);
  assert.equal(f.store.listOperations().length, 0);
});

test('an uncertain create is never repeated after a reload', async (t) => {
  const f = await fixture(t);
  f.raw.beforeCreate = async () => { throw new Error('transport lost the create response'); };
  await assert.rejects(f.ask(CHANNEL_A), { code: 'workbench-session-create-failed' });
  f.raw.beforeCreate = null;
  const store = await new DiscordWorkbenchStore(f.storePath).load();
  const workbench = new DiscordGuildWorkbench({ config, store, ...f.scope, logger });
  await assert.rejects(askInWorkspaceSession({
    ...f.scope,
    key: `group:${CHANNEL_A}`,
    text: 'retry',
    resolveSession: (context) => workbench.sessionResolver({
      ...context, message: { conversationId: CHANNEL_A },
    }),
  }), { code: 'workbench-session-create-uncertain' });
  assert.equal(f.raw.created.length, 0);
  assert.equal(f.raw.asked.length, 0);
  assert.equal(store.listOperations().length, 1);
});

test('a known session id survives a failed bind and retries without duplicate creation', async (t) => {
  const f = await fixture(t);
  const originalBind = f.store.bindChannelSession.bind(f.store);
  f.store.bindChannelSession = async () => {
    const durable = await new DiscordWorkbenchStore(f.storePath).load();
    assert.equal(durable.listOperations()[0]?.payload.sessionId, 'created-1');
    throw new Error('binding disk write failed');
  };
  await assert.rejects(f.ask(CHANNEL_A), { code: 'workbench-session-create-failed', sessionId: 'created-1' });
  f.store.bindChannelSession = originalBind;
  const store = await new DiscordWorkbenchStore(f.storePath).load();
  const scope = createBotWorkspaceScope(f.raw, { botId: BOT_ID, workspaces: f.workspaces, state: f.state });
  const workbench = new DiscordGuildWorkbench({ config, store, ...scope, logger });
  await askInWorkspaceSession({
    ...scope,
    key: `group:${CHANNEL_A}`,
    text: 'retry',
    resolveSession: (context) => workbench.sessionResolver({
      ...context, message: { conversationId: CHANNEL_A },
    }),
  });
  assert.equal(f.raw.created.length, 1);
  assert.equal(store.channel(CHANNEL_A).sessionId, 'created-1');
  assert.equal(scope.state.sessionFor(`group:${CHANNEL_A}`), 'created-1');
  assert.equal(store.listOperations().length, 0);
});

test('an aborted create also retains its journal and cannot recreate on retry', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.raw.beforeCreate = async () => { controller.abort(); throw controller.signal.reason; };
  await assert.rejects(f.ask(CHANNEL_A, { signal: controller.signal }));
  f.raw.beforeCreate = null;
  await assert.rejects(f.ask(CHANNEL_A), { code: 'workbench-session-create-uncertain' });
  assert.equal(f.raw.created.length, 0);
});

test('failed id journaling refuses a retry instead of creating a duplicate', async (t) => {
  const f = await fixture(t);
  f.store.updateOperation = async () => { throw new Error('id could not be persisted'); };
  await assert.rejects(f.ask(CHANNEL_A), { code: 'workbench-session-create-failed', sessionId: 'created-1' });
  await assert.rejects(f.ask(CHANNEL_A), { code: 'workbench-session-create-uncertain' });
  assert.equal(f.raw.created.length, 1);
  assert.equal(f.raw.asked.length, 0);
});

test('typed legacy session and workspace commands are refused in managed channels', async (t) => {
  const f = await fixture(t);
  for (const text of [
    '/new', '/session new', '/session open fixed', '/session info', '/session history',
    '/session archive', '/session restore', '/sessions', '/workspace', '/ws', '/conv',
    '/conversation', '/thread', '/preset', '/presetlist', '/presets',
  ]) {
    assert.equal(typeof f.workbench.commandOverride(text, { message: { conversationId: CHANNEL_A } }), 'string', text);
  }
  assert.equal(f.workbench.commandOverride('/stop', { message: { conversationId: CHANNEL_A } }), null);
});

async function productionFixture(t, settings = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workbench-production-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'default');
  await mkdir(workspace);
  let controllerOptions;
  const runtimes = [];
  class Controller {
    constructor(options) { controllerOptions = options; }
    async close() {}
  }
  class Runtime {
    constructor(options) { runtimes.push(options); }
  }
  const supervisor = { ready: Promise.resolve(), start() { return this; }, async close() {} };
  const dataDir = settings.dataDir ?? join(root, 'discord');
  const dshHome = settings.dshHome ?? root;
  const production = await createProductionController({
    credentials: {},
    typertGateway: { invoke() {}, stream() {} },
    logger: () => logger,
  }, { dshHome, dataDir, workspace }, {
    HarnessClient: RawHarness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => supervisor,
  });
  t.after(() => production.close());
  const runtime = async (workbench = config) => {
    await controllerOptions.createRuntime({
      botId: BOT_ID, config: { botId: BOT_ID, workbench }, token: 'host-only',
    });
    return runtimes.at(-1);
  };
  return { root, dataDir, dshHome, production, runtime, runtimes };
}

test('production refuses an invalid enabled config before creating a legacy runtime', async (t) => {
  const f = await productionFixture(t);
  await assert.rejects(f.runtime({ enabled: true, guildId: 'bad' }), { code: 'workbench-config-incomplete' });
  assert.equal(f.runtimes.length, 0);
});

test('production binds the workbench to its canonical DSH home identity', async (t) => {
  const f = await productionFixture(t);
  const options = await f.runtime();
  assert.deepEqual(options.workbenchStore.snapshot().identity, {
    guildId: GUILD_ID, botId: BOT_ID, instanceId: `dsh-home:${f.root}`,
  });
  const alias = join(f.root, 'home-alias');
  await symlink(f.root, alias, 'dir');
  const sameHost = await productionFixture(t, { dshHome: alias, dataDir: f.dataDir });
  await sameHost.runtime();
  const copiedHost = await productionFixture(t, { dataDir: f.dataDir });
  await assert.rejects(copiedHost.runtime(), { code: 'workbench-identity-conflict' });
  assert.equal(copiedHost.runtimes.length, 0);
});

test('production sync off preserves the managed binding used by control commands', async (t) => {
  const f = await productionFixture(t);
  const options = await f.runtime();
  const projectPath = join(f.root, 'project');
  await mkdir(projectPath);
  await options.workbenchStore.putProject({
    projectId: 'alpha', name: 'alpha', categoryId: '555555555555555551', workspacePath: projectPath,
  });
  await options.workbenchStore.registerChannel({ channelId: CHANNEL_A, projectId: 'alpha' });
  await options.workbenchStore.bindChannelSession(CHANNEL_A, 'fixed');
  const key = `group:${CHANNEL_A}`;
  await options.workbenchAdmin.setSessionSync({ channelId: CHANNEL_A, sessionId: 'fixed', enabled: false });
  assert.equal(options.state.sessionFor(key), 'fixed');
  await options.workbenchAdmin.setSessionSync({ channelId: CHANNEL_A, sessionId: 'fixed', enabled: true });
  await options.workbenchAdmin.setSessionSync({ channelId: CHANNEL_A, sessionId: 'fixed', enabled: false });
  assert.equal(options.state.sessionFor(key), 'fixed');
  assert.equal(options.workbenchStore.channel(CHANNEL_A).sessionId, 'fixed');
  assert.equal((await runControlCommand('/stop', options.harness, options.state, key)).stopped, true);
});

test('a queued submission revalidates lifecycle at admission', async (t) => {
  const f = await fixture(t);
  await f.ask(CHANNEL_A);
  let release;
  const blocking = f.workbench.queue.run({ sessionId: 'blocker', projectId: 'beta' }, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = f.ask(CHANNEL_A);
  const rejection = assert.rejects(waiting, { code: 'workbench-channel-archived' });
  while (f.workbench.queue.pendingFor('created-1') === 0) await new Promise((resolve) => setImmediate(resolve));
  await f.store.setChannelLifecycle(CHANNEL_A, 'archived');
  release();
  await Promise.all([blocking, rejection]);
  assert.equal(f.raw.asked.length, 1);
});
