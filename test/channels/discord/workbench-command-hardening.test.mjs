import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WorkbenchCommands, WORKBENCH_COMMANDS } from '../../../src/channels/discord/workbench/commands.mjs';
import { DiscordGuildWorkbench } from '../../../src/channels/discord/workbench/guild-workbench.mjs';
import { DiscordInteractionHandler } from '../../../src/channels/discord/workbench/interactions.mjs';
import { buildSessionCard, componentId } from '../../../src/channels/discord/workbench/session-card.mjs';
import { DiscordWorkbenchStore } from '../../../src/channels/discord/workbench/workbench-store.mjs';

const GUILD = '444444444444444444';
const CATEGORY = '555555555555555555';
const CHANNEL = '222222222222222201';
const OPERATOR = '333333333333333333';
const APPLICATION = '1234567890123456789';
const quiet = { warn() {}, error() {} };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-hardening-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'alpha');
  await mkdir(workspace);
  const store = await new DiscordWorkbenchStore(join(root, 'store.json')).load();
  await store.bindGuild(GUILD);
  await store.putProject({ projectId: 'alpha', name: 'Alpha', categoryId: CATEGORY, workspacePath: workspace });
  await store.registerChannel({ channelId: CHANNEL, projectId: 'alpha', title: 'Main' });
  const calls = [];
  const harnessCalls = [];
  const prepared = [];
  let sequence = 0;
  const api = {
    async listGuildChannels() { return []; },
    async getChannel({ channelId }) { return { id: channelId, type: 0, guild_id: GUILD, parent_id: CATEGORY }; },
    async listChannelMessages() { return []; },
    async createGuildChannel(options) {
      const id = String(777777777777777700n + BigInt(++sequence));
      calls.push({ operation: 'create-channel', id, ...options });
      return { id, type: options.type, parent_id: options.parentId };
    },
    async deleteChannel(options) { calls.push({ operation: 'delete-channel', ...options }); },
    async createMessage(options) { calls.push({ operation: 'message', ...options }); return { id: '888888888888888801' }; },
    async createInteractionResponse(options) { calls.push({ operation: 'reply', ...options }); },
    async editInteractionResponse(options) { calls.push({ operation: 'edit', ...options }); },
    async createFollowupMessage(options) { calls.push({ operation: 'followup', ...options }); },
  };
  const harness = {
    async createSession(options) { harnessCalls.push({ operation: 'create', ...options }); return 'created-session'; },
    workspaceSession(sessionId, key) {
      assert.equal(typeof sessionId, 'string', 'workspaceSession receives the Session ID, not the Harness');
      harnessCalls.push({ operation: 'handle', sessionId, key });
      return { sessionExists: async () => true };
    },
    async listWorkspaceSessions(path) {
      harnessCalls.push({ operation: 'list', path });
      return { workspace: path, sessions: [{ sessionId: 'existing-session', archived: false }] };
    },
    async isSessionRunning() { return false; },
    async readSessionHistory() { return { events: [], hasMore: false }; },
    async getSessionModels() { return {
      groups: [{ id: 'local', name: 'Local', models: [
        { id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
        { id: 'organization/model', name: 'Organization model' },
      ] }], failures: [], current: { provider: 'local', model: 'model' }, routable: true,
    }; },
    async steerActiveTurn(sessionId, text) { harnessCalls.push({ operation: 'steer', sessionId, text }); return true; },
    async stopActiveTurn(sessionId) { harnessCalls.push({ operation: 'stop', sessionId }); return true; },
    async selectSessionModel(sessionId, selection) { harnessCalls.push({ operation: 'model', sessionId, selection }); return { selected: selection }; },
  };
  const workbench = new DiscordGuildWorkbench({
    store, harness, logger: quiet,
    config: { enabled: true, guildId: GUILD, allowedUserIds: [OPERATOR], projectRoots: [root] },
  });
  // Exercise commands against the preparation API owned by the workspace router.
  workbench.prepareChannel = async (channelId) => {
    assert.ok(store.channel(channelId), 'preparation follows channel registration');
    prepared.push(channelId);
    return { channel: store.channel(channelId), project: store.project('alpha') };
  };
  const commands = new WorkbenchCommands({ workbench, api, harness, queue: workbench.queue, logger: quiet });
  const handler = new DiscordInteractionHandler({ workbench, api, commands, applicationId: APPLICATION, logger: quiet });
  const base = () => ({ id: String(++sequence), token: `token-${sequence}`, application_id: APPLICATION, app_permissions: '66576', guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: OPERATOR } } });
  const command = (subcommand, options = {}) => ({
    ...base(), type: 2,
    data: { name: 'session', options: [{ type: 1, name: subcommand, options: Object.entries(options).map(([name, value]) => ({ name, value })) }] },
  });
  const click = (kind, actionId, { type = 3, values, components, channelId = CHANNEL } = {}) => ({
    ...base(), type, channel_id: channelId,
    data: { custom_id: componentId(kind, actionId), ...(type === 3 ? { component_type: values ? 3 : 2 } : {}), ...(values ? { values } : {}), ...(components ? { components } : {}) },
  });
  const action = async (kind, { actionId = `action-${++sequence}`, sessionId = store.channel(CHANNEL)?.sessionId, ...extra } = {}) => {
    await store.putAction({ actionId, kind, sessionId, guildId: GUILD, channelId: CHANNEL, operatorId: OPERATOR, expiresAt: Date.now() + 60_000, ...extra });
    return actionId;
  };
  const lastText = () => {
    const response = calls.filter((call) => ['reply', 'edit', 'followup'].includes(call.operation)).at(-1);
    return response?.body?.content ?? response?.body?.data?.content ?? '';
  };
  return { root, workspace, store, api, harness, workbench, commands, handler, calls, harnessCalls, prepared, command, click, action, lastText };
}

test('slash command registration uses Discord wire names for channel and integer constraints', () => {
  const project = WORKBENCH_COMMANDS.find((entry) => entry.name === 'project');
  const category = project.options.find((entry) => entry.name === 'bind').options.find((entry) => entry.name === 'category');
  assert.deepEqual(category.channel_types, [4]);
  assert.equal('channelTypes' in category, false);
  const session = WORKBENCH_COMMANDS.find((entry) => entry.name === 'session');
  const count = session.options.find((entry) => entry.name === 'history').options[0];
  assert.equal(count.min_value, 1);
  assert.equal(count.max_value, 20);
});

test('new session prepares the registered conversation and supplies its scoped key', async (t) => {
  const f = await fixture(t);
  f.harness.createSession = async (options) => {
    assert.deepEqual(f.prepared, [options.conversationKey?.slice(6)]);
    assert.equal(options.workspace, f.workspace);
    f.harnessCalls.push({ operation: 'create', ...options });
    return 'created-session';
  };
  await f.handler.handle(f.command('new', { project: 'alpha' }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  assert.equal(f.store.channel(created.id).sessionId, 'created-session');
  assert.equal(f.harnessCalls.find((call) => call.operation === 'create').conversationKey, `group:${created.id}`);
});

test('a first message racing native creation reuses the newly created Session', async (t) => {
  const f = await fixture(t);
  let routed;
  let creations = 0;
  f.harness.createSession = async (options) => {
    creations += 1;
    const channelId = options.conversationKey.slice(6);
    routed = f.workbench.router.resolveForAsk({
      message: { conversationId: channelId },
      sessionExists: async () => true,
      createSession: async () => { creations += 1; return 'raced-session'; },
      workspaceSession: () => ({ sessionExists: async () => true }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    return 'created-session';
  };
  await f.handler.handle(f.command('new', { project: 'alpha' }));
  assert.equal((await routed).sessionId, 'created-session');
  assert.equal(creations, 1);
});

test('failed preparation leaves a retryable channel without creating a Session', async (t) => {
  const f = await fixture(t);
  f.workbench.prepareChannel = async () => { throw new Error('workspace unavailable'); };
  await f.handler.handle(f.command('new', { project: 'alpha' }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  assert.equal(f.store.channel(created.id).sessionId, null);
  assert.equal(f.harnessCalls.some((call) => call.operation === 'create'), false);
  assert.match(f.lastText(), /会话创建失败/u);
});

test('open verifies the requested Session with the correct scoped handle before binding', async (t) => {
  const f = await fixture(t);
  await f.handler.handle(f.command('open', { session_id: 'existing-session' }));
  assert.equal(f.store.channel(CHANNEL).sessionId, 'existing-session');
  assert.ok(f.harnessCalls.some((call) => call.operation === 'handle' && call.sessionId === 'existing-session' && call.key === `group:${CHANNEL}`));
  assert.ok(f.harnessCalls.some((call) => call.operation === 'list' && call.path === f.workspace));
});

test('open can adopt a Session in an unused text channel under its mapped project', async (t) => {
  const f = await fixture(t);
  const unusedChannel = '222222222222222299';
  f.api.getChannel = async ({ channelId }) => ({ id: channelId, guild_id: GUILD, type: 0, parent_id: CATEGORY, name: 'Imported' });
  await f.handler.handle({ ...f.command('open', { session_id: 'existing-session' }), channel_id: unusedChannel });
  assert.equal(f.store.channel(unusedChannel)?.sessionId, 'existing-session');
  assert.ok(f.prepared.includes(unusedChannel));
});

test('open refuses an existing Session outside the channel project workspace', async (t) => {
  const f = await fixture(t);
  f.harness.listWorkspaceSessions = async (workspace) => ({ workspace, sessions: [] });
  await f.handler.handle(f.command('open', { session_id: 'elsewhere' }));
  assert.equal(f.store.channel(CHANNEL).sessionId, null);
  assert.match(f.lastText(), /项目|工作区/u);
});

test('open fails closed when the project directory is no longer within allowed roots', async (t) => {
  const f = await fixture(t);
  f.workbench.config.projectRoots.splice(0, 1, join(f.root, 'different-root'));
  await f.handler.handle(f.command('open', { session_id: 'existing-session' }));
  assert.equal(f.store.channel(CHANNEL).sessionId, null);
  assert.match(f.lastText(), /根目录/u);
});

test('open never replaces a fixed channel Session', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'fixed-session');
  await f.handler.handle(f.command('open', { session_id: 'existing-session' }));
  assert.equal(f.store.channel(CHANNEL).sessionId, 'fixed-session');
  assert.ok(f.store.session('fixed-session'));
  assert.match(f.lastText(), /固定|绑定/u);
});

test('restore does not activate a former channel now holding another Session', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'old-session');
  await f.store.detachChannel(CHANNEL);
  await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await f.store.bindChannelSession(CHANNEL, 'other-session');
  await f.store.setChannelLifecycle(CHANNEL, 'archived');
  await f.handler.handle(f.command('restore', { session_id: 'old-session' }));
  assert.equal(f.store.channel(CHANNEL).sessionId, 'other-session');
  assert.equal(f.store.channel(CHANNEL).lifecycle, 'archived');
});

test('concurrent restores create one replacement channel and prepare it', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.store.detachChannel(CHANNEL);
  await Promise.all([
    f.handler.handle(f.command('restore', { session_id: 'existing-session' })),
    f.handler.handle(f.command('restore', { session_id: 'existing-session' })),
  ]);
  const created = f.calls.filter((call) => call.operation === 'create-channel');
  assert.equal(created.length, 1);
  assert.equal(f.store.channel(created[0].id).sessionId, 'existing-session');
  assert.ok(f.prepared.includes(created[0].id));
  assert.equal(f.store.listOperations().length, 0);
});

test('restore records the created channel before a subsequent preparation failure', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.store.detachChannel(CHANNEL);
  f.workbench.prepareChannel = async () => { throw new Error('workspace unavailable'); };
  await f.handler.handle(f.command('restore', { session_id: 'existing-session' }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  const operation = f.store.listOperations()[0];
  assert.equal(operation?.payload.channelId, created.id);
  assert.equal(operation?.payload.sessionId, 'existing-session');
  assert.equal(f.store.session('existing-session').detached, true);
});

test('retrying a partial restore reuses its recorded replacement channel', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.store.detachChannel(CHANNEL);
  const prepare = f.workbench.prepareChannel;
  f.workbench.prepareChannel = async () => { throw new Error('temporarily unavailable'); };
  await f.handler.handle(f.command('restore', { session_id: 'existing-session' }));
  f.workbench.prepareChannel = prepare;
  await f.handler.handle(f.command('restore', { session_id: 'existing-session' }));
  assert.equal(f.calls.filter((call) => call.operation === 'create-channel').length, 1);
  assert.equal(f.store.listOperations().length, 0);
  assert.equal(f.store.listChannels().length, 1);
  assert.equal(f.store.listChannels()[0].sessionId, 'existing-session');
});

test('ordinary archive cannot strand an empty channel without a restore ID', async (t) => {
  const f = await fixture(t);
  await f.handler.handle(f.command('archive'));
  assert.equal(f.store.channel(CHANNEL).lifecycle, 'active');
  assert.match(f.lastText(), /没有会话/u);
});

test('a failed deep archive delete retains the routing tombstone and restore index', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  f.api.deleteChannel = async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); };
  await f.handler.handle(f.click('deep-archive', await f.action('deep-archive')));
  assert.ok(f.store.channel(CHANNEL), 'failed deletion must not make the existing channel unmanaged');
  assert.notEqual(f.store.channel(CHANNEL).lifecycle, 'active');
  assert.match(f.store.channel(CHANNEL).lastError, /删除失败/u);
  assert.notEqual(f.store.session('existing-session').detached, true);
  assert.match(f.lastText(), /删除失败/u);
});

for (const state of ['running', 'queued', 'unverified']) {
  test(`deep archive refuses deletion while the Session is ${state}`, async (t) => {
    const f = await fixture(t);
    await f.store.bindChannelSession(CHANNEL, 'existing-session');
    if (state === 'running') f.harness.isSessionRunning = async () => true;
    if (state === 'queued') f.workbench.queue.pendingFor = () => 1;
    if (state === 'unverified') f.harness.isSessionRunning = async () => { throw new Error('offline'); };
    await f.handler.handle(f.click('deep-archive', await f.action('deep-archive')));
    assert.equal(f.calls.some((call) => call.operation === 'delete-channel'), false);
    assert.equal(f.store.channel(CHANNEL).sessionId, 'existing-session');
  });
}

test('two deep archive confirmations cannot delete the same channel twice', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  const first = await f.action('deep-archive');
  const second = await f.action('deep-archive');
  await Promise.all([f.handler.handle(f.click('deep-archive', first)), f.handler.handle(f.click('deep-archive', second))]);
  assert.equal(f.calls.filter((call) => call.operation === 'delete-channel').length, 1);
  assert.equal(f.store.session('existing-session').detached, true);
});

test('a stale archive action cannot affect a channel with a different fixed Session', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'current-session');
  await f.handler.handle(f.click('archive', await f.action('archive', { sessionId: 'old-session' })));
  assert.equal(f.store.channel(CHANNEL).lifecycle, 'active');
});

test('component kind mismatch is refused without consuming the valid action', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  const id = await f.action('deep-archive');
  await f.handler.handle(f.click('refresh', id));
  assert.equal(f.calls.some((call) => call.operation === 'delete-channel'), false);
  assert.equal(f.store.action(id).consumedAt, null);
});

test('a modal-only action cannot be consumed through a button interaction', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  const id = await f.action('steer-submit');
  await f.handler.handle(f.click('steer-submit', id));
  assert.equal(f.store.action(id).consumedAt, null);
});

test('steering modal has a submit-kind ID and submits once to its captured Session', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.handler.handle(f.click('steer', await f.action('steer')));
  const modal = f.calls.find((call) => call.operation === 'reply' && call.body.type === 9).body.data;
  assert.match(modal.custom_id, /^wb:steer-submit:/u);
  const id = modal.custom_id.split(':')[2];
  const submit = f.click('steer-submit', id, { type: 5, components: [{ type: 1, components: [{ type: 4, custom_id: 'steer_text', value: 'Keep the first approach' }] }] });
  await Promise.all([f.handler.handle(submit), f.handler.handle({ ...submit, id: 'second-submit' })]);
  assert.deepEqual(f.harnessCalls.filter((call) => call.operation === 'steer'), [{ operation: 'steer', sessionId: 'existing-session', text: 'Keep the first approach' }]);
});

test('a steering submit cannot retarget after acknowledgement waits on Discord', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  const id = await f.action('steer-submit');
  const reply = f.api.createInteractionResponse;
  f.api.createInteractionResponse = async (options) => {
    await reply(options);
    if (options.body.type !== 5) return;
    await f.store.detachChannel(CHANNEL);
    await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
    await f.store.bindChannelSession(CHANNEL, 'another-session');
  };
  await f.handler.handle(f.click('steer-submit', id, { type: 5, components: [{ type: 1, components: [{ type: 4, custom_id: 'steer_text', value: 'Do not redirect this instruction' }] }] }));
  assert.equal(f.harnessCalls.some((call) => call.operation === 'steer'), false);
  assert.match(f.lastText(), /失效/u);
});

for (const kind of ['model', 'archive', 'restore']) {
  test(`${kind} cannot retarget a channel while its acknowledgement is pending`, async (t) => {
    const f = await fixture(t);
    await f.store.bindChannelSession(CHANNEL, 'existing-session');
    const lifecycle = kind === 'restore' ? 'archived' : 'active';
    await f.store.setChannelLifecycle(CHANNEL, lifecycle);
    const id = await f.action(kind);
    const reply = f.api.createInteractionResponse;
    f.api.createInteractionResponse = async (options) => {
      await reply(options);
      if (options.body.type !== 5) return;
      await f.store.detachChannel(CHANNEL);
      await f.store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
      await f.store.bindChannelSession(CHANNEL, 'another-session');
      await f.store.setChannelLifecycle(CHANNEL, lifecycle);
    };
    await f.handler.handle(f.click(kind, id, kind === 'model' ? { values: ['local/model'] } : {}));
    assert.equal(f.store.channel(CHANNEL).lifecycle, lifecycle);
    assert.equal(f.harnessCalls.some((call) => call.operation === 'model'), false);
    assert.match(f.lastText(), /失效/u);
  });
}

test('action execution waits until its durable claim resolves', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  const id = await f.action('stop');
  let release;
  let claimed;
  const entered = new Promise((resolve) => { claimed = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const claim = f.store.claimAction.bind(f.store);
  f.store.claimAction = async (...args) => { claimed(); await gate; return claim(...args); };
  const handling = f.handler.handle(f.click('stop', id));
  await Promise.race([entered, handling]);
  assert.equal(f.harnessCalls.some((call) => call.operation === 'stop'), false);
  release();
  await handling;
  assert.equal(f.harnessCalls.filter((call) => call.operation === 'stop').length, 1);
});

test('errors after a deferred acknowledgement edit the existing interaction response', async (t) => {
  const f = await fixture(t);
  const command = f.commands.executeApplicationCommand.bind(f.commands);
  f.commands.executeApplicationCommand = async (_interaction, helpers) => { await helpers.defer({ ephemeral: true }); throw new Error('unexpected'); };
  await f.handler.handle(f.command('info'));
  f.commands.executeApplicationCommand = command;
  assert.equal(f.calls.filter((call) => call.operation === 'reply').length, 1);
  assert.equal(f.calls.at(-1).operation, 'edit');
  assert.match(f.lastText(), /失败/u);
});

test('model selection preserves a model ID containing slashes', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.handler.handle(f.click('model', await f.action('model'), { values: ['local/organization/model'] }));
  assert.deepEqual(f.harnessCalls.find((call) => call.operation === 'model')?.selection, { provider: 'local', model: 'organization/model' });
});

test('model menus omit unrepresentable IDs instead of silently truncating them', () => {
  const card = buildSessionCard({
    channel: { channelId: CHANNEL }, project: { name: 'Alpha', workspacePath: '/projects/alpha' },
    actions: { model: 'select-model', modelOptions: [
      { label: 'Oversized', value: `provider/${'x'.repeat(100)}` },
      { label: 'Valid', value: 'provider/model', selected: true },
      { label: 'Second', value: 'provider/other', selected: true },
    ] },
  });
  const select = card.components[0].components[0];
  assert.deepEqual(select.options.map((option) => option.value), ['provider/model', 'provider/other']);
  assert.equal(select.options.filter((option) => option.default).length, 1);
});

for (const failure of ['history', 'attachment', 'pending task']) {
  test(`deep archive retains the channel when ${failure} is unresolved`, async (t) => {
    const f = await fixture(t);
    await f.store.bindChannelSession(CHANNEL, 'existing-session');
    f.harness.readSessionHistory = async () => {
      if (failure === 'history') throw new Error('history unavailable');
      return { events: [], hasMore: false };
    };
    if (failure === 'attachment') {
      f.api.listChannelMessages = async () => [{ id: '999999999999999999', attachments: [{ size: 1, url: 'https://cdn.discordapp.com/file' }] }];
      f.api.downloadAttachment = async () => { throw new Error('download unavailable'); };
    }
    if (failure === 'pending task') await f.store.beginOperation({ operationId: 'message-999999999999999999', kind: 'message-task', state: 'submission-unknown', payload: { channelId: CHANNEL } });
    await f.handler.handle(f.click('deep-archive', await f.action('deep-archive')));
    assert.equal(f.calls.some((call) => call.operation === 'delete-channel'), false);
    assert.equal(f.store.channel(CHANNEL).sessionId, 'existing-session');
    assert.notEqual(f.store.session('existing-session').detached, true);
  });
}

test('deep archive writes its snapshot before deletion and retains its location for restore', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  f.harness.readSessionHistory = async () => ({ events: [], hasMore: false });
  let deleted = false;
  f.api.deleteChannel = async () => {
    const operation = f.store.operation(`archive:${CHANNEL}`);
    assert.equal(operation?.state, 'saved');
    const manifest = JSON.parse(await readFile(join(f.store.archiveDirectory, operation.payload.snapshot.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.channel.sessionId, 'existing-session');
    deleted = true;
  };
  await f.handler.handle(f.click('deep-archive', await f.action('deep-archive')));
  assert.equal(deleted, true);
  assert.equal(f.store.operation(`archive:${CHANNEL}`).state, 'deleted');
});

test('restore adopts the exact recorded Discord channel after a crash before registration', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.store.setChannelLifecycle(CHANNEL, 'deep-archived');
  await f.store.detachChannel(CHANNEL);
  const replacement = '777777777777777799';
  await f.store.beginOperation({ operationId: 'restore-before-registration', kind: 'restore-channel', state: 'channel-created',
    payload: { sessionId: 'existing-session', channelId: replacement, projectId: 'alpha' } });
  f.api.getChannel = async ({ channelId }) => {
    assert.equal(channelId, replacement);
    return { id: replacement, guild_id: GUILD, type: 0, parent_id: CATEGORY };
  };
  await f.handler.handle(f.command('restore', { session_id: 'existing-session' }));
  assert.equal(f.store.channel(replacement)?.sessionId, 'existing-session');
  assert.equal(f.calls.some((call) => call.operation === 'create-channel'), false);
  assert.equal(f.store.operation('restore-before-registration'), null);
});

for (const permissions of [undefined, '16', '1040', 'invalid']) {
  test(`deep archive refuses deletion without proven history permissions (${permissions})`, async (t) => {
    const f = await fixture(t);
    await f.store.bindChannelSession(CHANNEL, 'existing-session');
    const interaction = f.click('deep-archive', await f.action('deep-archive'));
    interaction.app_permissions = permissions;
    await f.handler.handle(interaction);
    assert.equal(f.calls.some((call) => call.operation === 'delete-channel'), false);
    assert.equal(f.store.channel(CHANNEL).lifecycle, 'active');
  });
}

test('deep archive refuses deletion when a new message arrives during snapshotting', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  f.api.listChannelMessages = async ({ limit }) => limit === 1
    ? [{ id: '999999999999999999', content: 'new attachment', attachments: [] }] : [];
  await f.handler.handle(f.click('deep-archive', await f.action('deep-archive')));
  assert.equal(f.calls.some((call) => call.operation === 'delete-channel'), false);
  assert.equal(f.store.channel(CHANNEL).sessionId, 'existing-session');
});

for (const status of [404, 403]) {
  test(`restore reconciles a locally recorded channel against Discord HTTP ${status}`, async (t) => {
    const f = await fixture(t);
    await f.store.bindChannelSession(CHANNEL, 'existing-session');
    await f.store.setChannelLifecycle(CHANNEL, 'archived');
    f.api.getChannel = async () => { throw Object.assign(new Error('channel lookup failed'), { status }); };
    await f.handler.handle(f.command('restore', { session_id: 'existing-session' }));
    const created = f.calls.filter((call) => call.operation === 'create-channel');
    assert.equal(created.length, status === 404 ? 1 : 0);
    if (status === 404) assert.equal(f.store.channel(created[0].id)?.sessionId, 'existing-session');
    else assert.equal(f.store.channel(CHANNEL).lifecycle, 'archived');
  });
}

for (const [count, parentCount] of [[500, 0], [50, 50]]) {
  test(`new Session refuses exhausted channel capacity (${count}/${parentCount})`, async (t) => {
    const f = await fixture(t);
    f.api.listGuildChannels = async () => Array.from({ length: count }, (_, i) => ({ id: String(999999999999990000n + BigInt(i)), parent_id: i < parentCount ? CATEGORY : null }));
    await f.handler.handle(f.command('new', { project: 'alpha' }));
    assert.equal(f.calls.some((call) => call.operation === 'create-channel'), false);
    assert.match(f.lastText(), /上限/);
  });
}

test('native reasoning selection uses the current model catalog and preserves provider/model', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  const request = f.command('info');
  request.data = { name: 'model' };
  await f.handler.handle(request);
  const menu = f.calls.filter((call) => call.operation === 'edit').at(-1).body.components[1].components[0];
  assert.equal(menu.options[0].value, 'high');
  await f.handler.handle(f.click('reasoning', menu.custom_id.split(':')[2], { values: ['high'] }));
  assert.deepEqual(f.harnessCalls.filter((call) => call.operation === 'model').at(-1), {
    operation: 'model', sessionId: 'existing-session', selection: { provider: 'local', model: 'model', reasoningEffort: 'high' },
  });
});

test('restore reconciles a recorded replacement deleted after local registration', async (t) => {
  const f = await fixture(t);
  await f.store.bindChannelSession(CHANNEL, 'existing-session');
  await f.store.detachChannel(CHANNEL);
  const gone = '777777777777777799';
  await f.store.registerChannel({ channelId: gone, projectId: 'alpha' });
  await f.store.beginOperation({ operationId: 'partial-restore', kind: 'restore-channel', state: 'channel-created',
    payload: { sessionId: 'existing-session', channelId: gone, projectId: 'alpha' } });
  f.api.getChannel = async ({ channelId }) => { assert.equal(channelId, gone); throw Object.assign(new Error('gone'), { status: 404 }); };
  await f.handler.handle(f.command('restore', { session_id: 'existing-session' }));
  const created = f.calls.find((call) => call.operation === 'create-channel');
  assert.ok(created);
  assert.equal(f.store.channel(created.id).sessionId, 'existing-session');
  assert.equal(f.store.channel(gone), null);
});
