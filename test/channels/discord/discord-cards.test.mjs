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
  const bridge = new DiscordHarnessBridge({
    bot,
    harness,
    state: stateFixture(),
    logger: { warn() {}, error() {}, debug() {} },
  });
  return { bridge, cards, sent, edits, notices, finish: gate.resolve };
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

test('a multi-select question keeps the text flow instead of unusable buttons', async () => {
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
      respond: async () => { finish(); return { accepted: true }; },
    }),
  });
  const processing = f.bridge.accept(message('m-2', '多选问题'));
  await eventually(() => f.sent.some((entry) => /可以多选/u.test(entry.text)));
  assert.equal(f.cards.length, 0);
  // A press can only name a card that was never delivered, so it is refused as
  // stale; the question itself stays answerable as text.
  await f.bridge.acceptCallback(callback({ data: 'wbq:nonce:0:0' }));
  assert.match(f.notices.at(-1).text, /失效/u);
  f.finish();
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
