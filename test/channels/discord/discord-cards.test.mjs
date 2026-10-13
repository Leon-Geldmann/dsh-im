import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';

/**
 * Question and approval cards in a Discord channel: buttons carry opaque ids,
 * the shared bridge owns the pending request, and every press is acknowledged
 * through the interaction callback rather than a new channel message.
 */

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, value) { sessions.set(key, value); return true; },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    async unmarkSeen(id) { seen.delete(id); return true; },
  };
}

function message(messageId, content, overrides = {}) {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'group',
    conversationId: '222222222222222201',
    content,
    addressed: true,
    requiresMention: false,
    replyTarget: { channelId: '222222222222222201' },
    reactionTarget: { channelId: '222222222222222201', messageId },
    ...overrides,
  };
}

function callback(overrides = {}) {
  return {
    conversationId: '222222222222222201',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'group',
    messageId: 'card-message',
    callbackQueryId: 'interaction-1',
    interactionId: 'interaction-1',
    interactionToken: 'interaction-token',
    data: '',
    ...overrides,
  };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fixture({ interaction, askAnswer = async () => 'done' } = {}) {
  const gate = deferred();
  const cards = [];
  const sent = [];
  const edits = [];
  const notices = [];
  let nextCard = 1;
  const bot = {
    async sendText(target, text) {
      sent.push({ target, text });
      return { providerMessageIds: [] };
    },
    async sendTyping() {},
    async sendInteractionCard(target, { text, markup }) {
      const id = `card-${nextCard}`;
      nextCard += 1;
      cards.push({ target, text, markup, id, kind: 'question' });
      return { providerMessageIds: [id] };
    },
    async updateInteractionCard(target, messageId, { markup }) {
      edits.push({ messageId, markup });
    },
    async sendApprovalCard(target, { text, markup }) {
      const id = `approval-${nextCard}`;
      nextCard += 1;
      cards.push({ target, text, markup, id, kind: 'approval' });
      return { providerMessageIds: [id] };
    },
    async updateApprovalCard(target, messageId, { markup }) {
      edits.push({ messageId, markup });
    },
    async answerInteractionCallback(queryId, text, payload) {
      notices.push({ queryId, text, payload });
    },
  };
  const harness = {
    async createSession() { return 'session-one'; },
    async sessionExists() { return true; },
    workspaceSession(sessionId) {
      return {
        sessionId,
        sessionExists: async () => true,
        // A real turn stays open while the question is pending; the gate keeps
        // the mock turn open until the test's answer callback releases it.
        ask: async (text, options) => {
          if (interaction) await options.onInteraction(interaction(sessionId, gate.resolve));
          if (interaction) await gate.promise;
          return askAnswer();
        },
      };
    },
  };
  const state = stateFixture();
  const bridge = new DiscordHarnessBridge({
    bot,
    harness,
    state,
    logger: { warn() {}, error() {}, debug() {} },
  });
  return { bridge, state, cards, sent, edits, notices, finish: gate.resolve };
}

test('a question with options is delivered as buttons and submits the pressed label', async () => {
  const answered = [];
  const f = fixture({
    interaction: (sessionId, finish) => ({
      kind: 'question',
      interactionId: 'question-1',
      rpcId: 'question-1',
      sessionId,
      payload: {
        type: 'question/requested',
        sessionId,
        questions: [{
          id: 'pick',
          header: '选择',
          question: '选一个颜色',
          options: [{ label: '红色' }, { label: '绿色' }],
        }],
      },
      respond: async (result) => { answered.push(result); finish(); return { accepted: true }; },
    }),
  });
  const processing = f.bridge.accept(message('m-1', '开始提问'));
  await eventually(() => f.cards.length === 1);
  assert.equal(f.cards[0].kit, undefined);
  assert.equal(f.cards[0].markup.rows.length, 2);
  assert.match(f.cards[0].text, /选一个颜色/u);
  assert.equal(f.cards[0].id, 'card-1');

  const data = f.cards[0].markup.rows[1][0].id;
  await f.bridge.acceptCallback(callback({ data }));
  await eventually(() => answered.length === 1);
  assert.deepEqual(answered[0].value.answer.answers, [{ id: 'pick', selected: ['绿色'] }]);
  assert.equal(f.notices.length >= 1, true);
  assert.match(f.notices.at(-1).text, /绿色/u);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].messageId, 'card-1');
  assert.deepEqual(f.edits[0].markup, { inline_keyboard: [] });
  await processing;
});

test('a native multi-select submits the selected set once and refuses invalid values', async () => {
  const answered = [];
  const f = fixture({
    interaction: (sessionId, finish) => ({
      kind: 'question',
      interactionId: 'question-multi',
      rpcId: 'question-multi',
      sessionId,
      payload: {
        type: 'question/requested',
        sessionId,
        questions: [{
          id: 'pick',
          question: '可以多选',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
      respond: async (result) => { answered.push(result); finish(); return { accepted: true }; },
    }),
  });
  const processing = f.bridge.accept(message('m-2', '多选问题'));
  await eventually(() => f.cards.length === 1);
  const select = f.cards[0].markup.components[0].components[0];
  assert.equal(select.type, 3);
  assert.equal(select.max_values, 2);
  await f.bridge.acceptCallback(callback({ data: select.custom_id, values: ['99'] }));
  assert.match(f.notices.at(-1).text, /失效/u);
  assert.equal(answered.length, 0);
  await f.bridge.acceptCallback(callback({ data: select.custom_id, values: ['0', '1'] }));
  assert.deepEqual(answered[0].value.answer.answers, [{ id: 'pick', selected: ['A', 'B'] }]);
  await f.bridge.acceptCallback(callback({ data: select.custom_id, values: ['0'] }));
  assert.equal(answered.length, 1);
  await processing;
});

test('an approval renders approve-once / reject buttons and rejects on press', async () => {
  const answered = [];
  const f = fixture({
    interaction: (sessionId, finish) => ({
      kind: 'approval',
      interactionId: 'approval-1',
      rpcId: 'approval-1',
      sessionId,
      payload: {
        type: 'approval/requested',
        sessionId,
        approvalId: 'approval-1',
        toolName: 'bash',
        callId: 'call-1',
      },
      toolCall: { name: 'bash', callId: 'call-1', arguments: '{}' },
      respond: async (result) => { answered.push(result); finish(); return { accepted: true }; },
    }),
  });
  const processing = f.bridge.accept(message('m-3', '请审批'));
  await eventually(() => f.cards.some((card) => card.kind === 'approval'));
  const card = f.cards.find((entry) => entry.kind === 'approval');
  assert.deepEqual(card.markup.rows[0].map((button) => button.label), ['批准一次', '拒绝']);

  const rejectId = card.markup.rows[0][1].id;
  await f.bridge.acceptApprovalCallback(callback({ data: rejectId }));
  await eventually(() => answered.length === 1);
  assert.equal(answered[0].ok, true);
  assert.equal(answered[0].value.outcome, 'rejected');

  // A second press reports the real state instead of submitting again.
  await f.bridge.acceptApprovalCallback(callback({ data: rejectId }));
  await eventually(() => f.notices.length >= 2);
  assert.match(f.notices.at(-1).text, /已失效|已处理/u);
  assert.equal(f.edits.length, 1);
  assert.deepEqual(f.edits[0].markup, { rows: [] });
  await processing;
});

test('approval presses from another actor are refused', async () => {
  const answered = [];
  const f = fixture({
    interaction: (sessionId, finish) => ({
      kind: 'approval',
      interactionId: 'approval-2',
      rpcId: 'approval-2',
      sessionId,
      payload: {
        type: 'approval/requested',
        sessionId,
        approvalId: 'approval-2',
        toolName: 'bash',
        callId: 'call-2',
      },
      toolCall: { name: 'bash', callId: 'call-2', arguments: '{}' },
      respond: async (result) => { answered.push(result); finish(); return { accepted: true }; },
    }),
  });
  const processing = f.bridge.accept(message('m-4', '请审批'));
  await eventually(() => f.cards.some((card) => card.kind === 'approval'));
  const card = f.cards.find((entry) => entry.kind === 'approval');
  const approveId = card.markup.rows[0][0].id;
  await f.bridge.acceptApprovalCallback(callback({ data: approveId, senderId: 'actor-b' }));
  assert.equal(answered.length, 0);
  assert.match(f.notices.at(-1).text, /已处理或已失效/u);
  f.finish();
  await processing;
});

for (const [label, overrides] of [
  ['another channel', { conversationId: '222222222222222299' }],
  ['another conversation kind', { kind: 'direct' }],
  ['a bot actor', { senderIsBot: true }],
]) {
  test(`an approval token cannot be used from ${label}`, async (t) => {
    const answered = [];
    const f = fixture({ interaction: (sessionId, finish) => ({
      kind: 'approval', interactionId: 'scoped-approval', rpcId: 'scoped-approval', sessionId,
      payload: { type: 'approval/requested', sessionId, approvalId: 'scoped-approval', toolName: 'bash', callId: 'call-scoped' },
      toolCall: { name: 'bash', callId: 'call-scoped', arguments: '{}' },
      respond: async (result) => { answered.push(result); finish(); return { accepted: true }; },
    }) });
    const processing = f.bridge.accept(message('scope-message', 'approval'));
    t.after(async () => { f.finish(); await processing; });
    await eventually(() => f.cards.some((card) => card.kind === 'approval'));
    const data = f.cards.find((card) => card.kind === 'approval').markup.rows[0][0].id;
    await f.bridge.acceptApprovalCallback(callback({ data, ...overrides }));
    assert.equal(answered.length, 0);
    await f.bridge.acceptApprovalCallback(callback({ data }));
    assert.equal(answered.length, 1, 'a refused press must leave the original request usable');
  });
}

for (const journalOwned of [false, true]) {
  test(`prompt timeout ${journalOwned ? 'keeps recovery in the workbench journal' : 'retains legacy deferred recovery'}`, async (t) => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DiscordStateStore } = await import('../../../src/channels/discord/state-store.mjs');
    const root = await mkdtemp(join(tmpdir(), 'workbench-recovery-owner-'));
    const state = await new DiscordStateStore(join(root, 'state.json')).load();
    const controller = new AbortController();
    await state.setSession('group:222222222222222201', 'session-one');
    const harness = {
      workspaceSession: () => ({ sessionExists: async () => true, ask: async () => {
        throw Object.assign(new Error('timeout'), { code: 'harness-reply-timeout', details: {
          sessionId: 'session-one', promptRpcId: 'prompt-one', baselineSeq: -1, turn: 0,
        } });
      } }),
      rpc: async () => ({ events: [], hasMore: false }),
    };
    const bridge = new DiscordHarnessBridge({ harness, state, signal: controller.signal,
      bot: { sendText: async () => ({ providerMessageIds: [] }) },
      logger: { warn() {}, error() {}, debug() {} },
    });
    t.after(async () => { controller.abort(); await bridge.waitForIdle(); await rm(root, { recursive: true, force: true }); });
    await bridge.accept(message('timeout-message', 'long job', journalOwned ? { onPromptState: async () => {} } : {}));
    await bridge.waitForIdle();
    assert.equal(state.deferredEntries().length, journalOwned ? 0 : 1);
  });
}

test('an approval cannot follow a changed Session binding', async (t) => {
  const answered = [];
  const f = fixture({ interaction: (sessionId, finish) => ({
    kind: 'approval', interactionId: 'bound-approval', rpcId: 'bound-approval', sessionId,
    payload: { type: 'approval/requested', sessionId, approvalId: 'bound-approval', toolName: 'bash', callId: 'bound-call' },
    toolCall: { name: 'bash', callId: 'bound-call', arguments: '{}' },
    respond: async (result) => { answered.push(result); finish(); return { accepted: true }; },
  }) });
  const processing = f.bridge.accept(message('bound-message', 'approval'));
  t.after(async () => { f.finish(); await processing; });
  await eventually(() => f.cards.some((card) => card.kind === 'approval'));
  const data = f.cards.find((card) => card.kind === 'approval').markup.rows[0][0].id;
  await f.state.setSession('group:222222222222222201', 'different-session');
  await f.bridge.acceptApprovalCallback(callback({ data }));
  assert.equal(answered.length, 0);
});

test('a Web-originated approval renders native buttons and retires after Web wins', async () => {
  const f = fixture();
  const completion = deferred();
  const answered = [];
  const key = 'group:222222222222222201';
  await f.state.setSession(key, 'session-one');
  await f.bridge.presentSessionSyncApproval({
    kind: 'approval', interactionId: 'web-approval', rpcId: 'web-approval', sessionId: 'session-one',
    payload: { type: 'approval/requested', sessionId: 'session-one', approvalId: 'web-approval', toolName: 'bash', callId: 'web-call' },
    toolCall: { name: 'bash', callId: 'web-call', arguments: '{}' },
    respond: async (result) => { answered.push(result); return { accepted: true }; },
  }, { key, actor: 'actor-a', target: { channelId: '222222222222222201' }, send: async () => {}, validate: async () => {} },
  { completion: completion.promise });
  assert.equal(f.cards.length, 1);
  const data = f.cards[0].markup.rows[0][0].id;
  completion.resolve('approved');
  await f.bridge.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
  await f.bridge.acceptApprovalCallback(callback({ data }));
  assert.equal(answered.length, 0);
  assert.match(f.notices.at(-1).text, /已处理|已失效/);
});
