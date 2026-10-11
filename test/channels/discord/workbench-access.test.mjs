import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyWorkbenchMessage,
  isWorkbenchOperator,
  normalizeWorkbenchConfig,
} from '../../../src/channels/discord/workbench/access.mjs';

const GUILD = '111111111111111111';
const OTHER_GUILD = '111111111111111112';
const OWNER = '444444444444444444';
const OPERATOR = '555555555555555555';
const STRANGER = '666666666666666666';

const message = (overrides = {}) => ({
  guild_id: GUILD,
  author: { id: OPERATOR, bot: false },
  ...overrides,
});

test('an enabled workbench requires a guild binding and normalizes its limits', () => {
  assert.equal(normalizeWorkbenchConfig(undefined), null);
  assert.throws(
    () => normalizeWorkbenchConfig({ enabled: true }),
    { code: 'workbench-config-incomplete' },
  );
  const config = normalizeWorkbenchConfig({
    enabled: true,
    guildId: GUILD,
    allowedUserIds: [OPERATOR, OPERATOR, 'nope', STRANGER],
    projectRoots: ['/srv/projects', '/srv/projects', 'relative/path', 'tcp://example'],
    maxConcurrentTasks: 99,
    projectConcurrency: 2,
  });
  assert.deepEqual(config.allowedUserIds, [OPERATOR, STRANGER]);
  assert.deepEqual(config.projectRoots, ['/srv/projects']);
  assert.equal(config.maxConcurrentTasks, 1);
  assert.equal(config.projectConcurrency, 2);
});

test('a disabled block stays disabled and keeps its stored binding for later', () => {
  const config = normalizeWorkbenchConfig({ enabled: false, guildId: GUILD });
  assert.equal(config.enabled, false);
  assert.equal(config.guildId, GUILD);
});

test('only the application owner or an allowlisted operator is admitted', () => {
  const config = normalizeWorkbenchConfig({ enabled: true, guildId: GUILD, allowedUserIds: [OPERATOR] });
  assert.equal(isWorkbenchOperator(config, OWNER, { ownerUserId: OWNER }), true);
  assert.equal(isWorkbenchOperator(config, OPERATOR, { ownerUserId: OWNER }), true);
  assert.equal(isWorkbenchOperator(config, STRANGER, { ownerUserId: OWNER }), false);
  assert.equal(isWorkbenchOperator(config, OWNER), false);
  assert.equal(isWorkbenchOperator({ ...config, enabled: false }, OPERATOR), false);
});

test('messages from another guild, bots, and strangers never enter workbench routing', () => {
  const config = normalizeWorkbenchConfig({
    enabled: true, guildId: GUILD, allowedUserIds: [OPERATOR],
  });
  assert.equal(classifyWorkbenchMessage(config, message()).managed, true);
  assert.equal(
    classifyWorkbenchMessage(config, message({ guild_id: OTHER_GUILD })).reason,
    'guild',
  );
  assert.equal(
    classifyWorkbenchMessage(config, message({ author: { id: OPERATOR, bot: true } })).reason,
    'bot',
  );
  assert.equal(
    classifyWorkbenchMessage(config, message({ author: { id: STRANGER, bot: false } })).reason,
    'not-operator',
  );
  const ownerMessage = message({ author: { id: OWNER, bot: false } });
  assert.equal(
    classifyWorkbenchMessage(config, ownerMessage, { ownerUserId: OWNER }).managed,
    true,
  );
  assert.equal(classifyWorkbenchMessage(null, message()).managed, false);
  assert.equal(classifyWorkbenchMessage(config, { guild_id: GUILD }).managed, false);
});
