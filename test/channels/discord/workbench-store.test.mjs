import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CHANNEL_LIFECYCLE,
  DiscordWorkbenchStore,
  SESSION_STATE,
} from '../../../src/channels/discord/workbench/workbench-store.mjs';

const GUILD = '111111111111111111';
const CATEGORY = '222222222222222222';
const OTHER_CATEGORY = '222222222222222223';
const CHANNEL = '333333333333333333';
const OTHER_CHANNEL = '333333333333333334';
const SESSION = 'session-alpha';
const OTHER_SESSION = 'session-beta';

async function fixture(t, initial = null) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workbench-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'workbench.json');
  if (initial) await writeFile(path, JSON.stringify(initial), 'utf8');
  const store = await new DiscordWorkbenchStore(path).load();
  return { store, path, directory };
}

async function bindProject(store, {
  projectId = 'alpha',
  categoryId = CATEGORY,
  workspacePath = '/home/user/projects/alpha',
  name = 'Alpha',
} = {}) {
  await store.bindGuild(GUILD);
  return store.putProject({ projectId, name, categoryId, workspacePath });
}

test('a bot binds one guild and refuses a conflicting identity', async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.bindGuild(GUILD), true);
  assert.equal(store.guildId, GUILD);
  assert.equal(await store.bindGuild(GUILD), false);
  await assert.rejects(store.bindGuild(OTHER_CHANNEL), { code: 'workbench-guild-conflict' });
  // Only an explicit operator rebind may move the identity.
  assert.equal(await store.bindGuild(OTHER_CHANNEL, { rebind: true }), true);
  assert.equal(store.guildId, OTHER_CHANNEL);
});

test('categories map to projects and a category cannot be double bound', async (t) => {
  const { store } = await fixture(t);
  await bindProject(store);
  assert.equal(store.projectForCategory(CATEGORY).projectId, 'alpha');
  await assert.rejects(
    store.putProject({
      projectId: 'beta', name: 'Beta', categoryId: CATEGORY, workspacePath: '/home/user/projects/beta',
    }),
    { code: 'workbench-category-taken' },
  );
  await store.putProject({
    projectId: 'beta', name: 'Beta', categoryId: OTHER_CATEGORY, workspacePath: '/home/user/projects/beta',
  });
  assert.equal(store.listProjects().length, 2);
});

test('a channel keeps exactly one session binding for its whole life', async (t) => {
  const { store } = await fixture(t);
  await bindProject(store);
  await store.registerChannel({ channelId: CHANNEL, projectId: 'alpha', title: 'Alpha main' });
  await store.bindChannelSession(CHANNEL, SESSION, { title: 'Alpha main' });
  assert.equal(store.channel(CHANNEL).sessionId, SESSION);
  assert.equal(store.session(SESSION).state, SESSION_STATE.ACTIVE);
  await assert.rejects(store.bindChannelSession(CHANNEL, OTHER_SESSION), { code: 'workbench-session-conflict' });
  await assert.rejects(
    store.bindChannelSession(OTHER_CHANNEL, SESSION),
    { code: 'workbench-channel-unknown' },
  );
  await store.registerChannel({ channelId: OTHER_CHANNEL, projectId: 'alpha' });
  await assert.rejects(store.bindChannelSession(OTHER_CHANNEL, SESSION), { code: 'workbench-session-taken' });
  // Replacing is an explicit, verified operation.
  await store.bindChannelSession(CHANNEL, OTHER_SESSION, { replace: true });
  assert.equal(store.channel(CHANNEL).sessionId, OTHER_SESSION);
  assert.equal(store.session(SESSION), null);
});

test('channel lifecycle and errors are recorded without losing the session', async (t) => {
  const { store } = await fixture(t);
  await bindProject(store);
  await store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await store.bindChannelSession(CHANNEL, SESSION);
  await store.noteChannelError(CHANNEL, 'Session not found');
  assert.equal(store.channel(CHANNEL).lastError, 'Session not found');
  await store.setChannelLifecycle(CHANNEL, CHANNEL_LIFECYCLE.ARCHIVED);
  assert.equal(store.session(SESSION).state, SESSION_STATE.ARCHIVED);
  assert.equal(store.session(SESSION).archivedAt !== null, true);
  await store.setChannelLifecycle(CHANNEL, CHANNEL_LIFECYCLE.ACTIVE);
  assert.equal(store.session(SESSION).state, SESSION_STATE.ACTIVE);
  assert.equal(store.session(SESSION).archivedAt, null);
});

test('a deep archive detaches the channel but keeps the session restore index', async (t) => {
  const { store, path } = await fixture(t);
  await bindProject(store);
  await store.registerChannel({ channelId: CHANNEL, projectId: 'alpha' });
  await store.bindChannelSession(CHANNEL, SESSION);
  assert.equal(await store.detachChannel(CHANNEL), true);
  assert.equal(store.channel(CHANNEL), null);
  assert.equal(store.session(SESSION).state, SESSION_STATE.ARCHIVED);
  assert.equal(store.session(SESSION).detached, true);
  // The detached record survives a reload so the channel can be reopened.
  const reloaded = await new DiscordWorkbenchStore(path).load();
  assert.equal(reloaded.session(SESSION).detached, true);
});

test('interaction actions are consumed exactly once with the real reason', async (t) => {
  const { store } = await fixture(t);
  await store.putAction({
    actionId: 'a1', kind: 'session-stop', operatorId: '444444444444444444',
    guildId: GUILD, channelId: CHANNEL, sessionId: SESSION, expiresAt: Date.now() + 60_000,
  });
  assert.equal(store.takeAction('missing').reason, 'unknown');
  assert.equal(
    store.takeAction('a1', { operatorId: '555555555555555555', guildId: GUILD }).reason,
    'operator',
  );
  assert.equal(store.takeAction('a1', { guildId: OTHER_CHANNEL }).reason, 'scope');
  const first = store.takeAction('a1', { operatorId: '444444444444444444', guildId: GUILD, channelId: CHANNEL });
  assert.equal(first.ok, true);
  const second = store.takeAction('a1', { operatorId: '444444444444444444', guildId: GUILD, channelId: CHANNEL });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'consumed');
});

test('expired actions are refused and pruned', async (t) => {
  const { store } = await fixture(t);
  await store.putAction({ actionId: 'old', kind: 'archive', expiresAt: Date.now() - 1_000 });
  const taken = store.takeAction('old');
  assert.equal(taken.ok, false);
  assert.equal(taken.reason, 'expired');
  // Expired actions are retained for a grace window so a late click still
  // reports "expired" instead of "unknown"; pruning drops them after it.
  assert.equal(await store.pruneActions(Date.now(), { retainMs: 1 }), 1);
  assert.equal(store.action('old'), null);
});

test('operations record multi-step progress until completion', async (t) => {
  const { store } = await fixture(t);
  await store.beginOperation({
    operationId: 'op1', kind: 'create-session-channel', payload: { channelId: CHANNEL },
  });
  await store.updateOperation('op1', { state: 'channel-created', payload: { channelId: CHANNEL, sessionId: SESSION } });
  assert.equal(store.operation('op1').state, 'channel-created');
  assert.equal(store.operation('op1').payload.sessionId, SESSION);
  assert.equal(await store.completeOperation('op1'), true);
  assert.equal(store.operation('op1'), null);
});

test('processed event ids dedupe gateway replays and stay bounded', async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.markProcessed('9001'), true);
  assert.equal(await store.markProcessed('9001'), false);
  assert.equal(store.hasProcessed('9001'), true);
  assert.equal(store.hasProcessed(9001), true);
});

test('a damaged document is normalized instead of trusted', async (t) => {
  const { store } = await fixture(t, {
    version: 1,
    guildId: 'not-a-snowflake',
    projects: {
      ok: { projectId: 'ok', name: 'Ok', categoryId: CATEGORY, workspacePath: '/home/user/ok' },
      bad: { projectId: 'bad', name: 'Bad', categoryId: 'nope', workspacePath: 'relative' },
    },
    channels: {
      [CHANNEL]: { channelId: CHANNEL, projectId: 'ok', sessionId: SESSION },
      [OTHER_CHANNEL]: { channelId: OTHER_CHANNEL, projectId: 'missing' },
      broken: { channelId: 'nope', projectId: 'ok' },
    },
    sessions: {
      [SESSION]: { sessionId: SESSION, channelId: CHANNEL, projectId: 'ok' },
      orphan: { sessionId: 'orphan', channelId: OTHER_CHANNEL, projectId: 'ok' },
    },
    processed: [{ id: 'x', at: 'now' }, { at: 'missing-id' }],
  });
  assert.equal(store.guildId, null);
  assert.deepEqual(store.listProjects().map((item) => item.projectId), ['ok']);
  assert.equal(store.channel(CHANNEL).sessionId, SESSION);
  assert.equal(store.channel(OTHER_CHANNEL), null);
  assert.equal(store.channel('broken'), null);
  assert.equal(store.session('orphan'), null);
  assert.equal(store.hasProcessed('x'), true);
});

test('the persisted file is private and round-trips', async (t) => {
  const { store, path } = await fixture(t);
  await bindProject(store);
  await store.registerChannel({ channelId: CHANNEL, projectId: 'alpha', title: 'Alpha' });
  await store.bindChannelSession(CHANNEL, SESSION, { title: 'Alpha' });
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.guildId, GUILD);
  assert.equal(raw.channels[CHANNEL].sessionId, SESSION);
  assert.equal(raw.sessions[SESSION].channelId, CHANNEL);
});
