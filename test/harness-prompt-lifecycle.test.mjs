import assert from 'node:assert/strict';
import test from 'node:test';

import { HarnessClient } from '../src/channels/shared/harness-client.mjs';

function fixture({ promptResult, historyError } = {}) {
  const events = [{ event: { seq: 9, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } }];
  const prompts = [];
  const success = (rpcId, value) => ({ rpcId, result: { ok: true, value } });
  const client = new HarnessClient({
    workspace: '/tmp/dsh-lifecycle-test',
    apiProxy: {
      host: { describe: ({ rpcId }) => success(rpcId, {}) },
      workspace: { list: ({ rpcId }) => success(rpcId, { items: [], archivedSessionIds: [] }) },
      sessions: {
        history({ rpcId }) {
          if (prompts.length && historyError) throw historyError;
          return success(rpcId, { events: [...events], hasMore: false });
        },
        async prompt({ rpcId, payload }) {
          prompts.push({ rpcId, payload });
          if (promptResult) return promptResult(rpcId);
          events.push(
            { event: { seq: 10, type: 'turn/start', data: { turn: 4 } } },
            { event: { seq: 11, type: 'user/message', data: { turn: 4, source: { rpcId } } } },
            { event: { seq: 12, type: 'assistant/message', data: {
              turn: 4, step: 0, message: { content: [{ type: 'text', text: 'Answer' }] },
            } } },
            { event: { seq: 13, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } } },
          );
          return success(rpcId, {});
        },
      },
    },
    fetchImpl() { assert.fail('must use the Host API'); },
  });
  return { client, prompts };
}

test('ask awaits submitting before RPC and reports the same identity through observed completion', async () => {
  const { client, prompts } = fixture();
  const states = [];
  const answer = await client.ask('session', 'hello', {
    onPromptState: async (state) => {
      states.push(state);
      if (state.state === 'submitting') {
        await Promise.resolve();
        assert.equal(prompts.length, 0, 'the durable callback must precede submission');
      }
      if (state.state === 'submitted') assert.equal(prompts.length, 1);
    },
  });
  assert.equal(answer, 'Answer');
  assert.deepEqual(states.map(({ state }) => state), ['submitting', 'submitted', 'completed']);
  assert.equal(states[0].promptRpcId, prompts[0].rpcId);
  assert.equal(states[0].baselineSeq, 9);
  assert.equal(states[2].promptRpcId, prompts[0].rpcId);
  assert.equal(states[2].turn, 4);
  assert.equal(states[2].lastSeq, 13);
  assert.equal(states[2].text, 'Answer');
});

test('a failing pre-submit journal callback prevents the prompt', async () => {
  const { client, prompts } = fixture();
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState(state) {
    states.push(state);
    if (state.state === 'submitting') throw new Error('journal disk unavailable');
  } }), /journal disk unavailable/);
  assert.equal(prompts.length, 0);
  assert.equal(states.at(-1).state, 'failed');
  assert.equal(states.at(-1).submissionState, 'not-submitted');
  assert.equal(states.at(-1).uncertain, false);
});

test('a transport failure after dispatch reports unknown commit and never retries', async () => {
  const { client, prompts } = fixture({ promptResult() { throw new Error('connection lost after commit'); } });
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState: (state) => states.push(state) }));
  assert.equal(prompts.length, 1);
  assert.equal(states.at(-1).state, 'failed');
  assert.equal(states.at(-1).submissionState, 'unknown');
  assert.equal(states.at(-1).uncertain, true);
  assert.equal(states.at(-1).promptRpcId, prompts[0].rpcId);
});

test('a definitive Host rejection reports rejected rather than uncertain commit', async () => {
  const { client, prompts } = fixture({ promptResult: (rpcId) => ({
    rpcId, result: { ok: false, error: { code: 'invalid-content', message: 'Rejected' } },
  }) });
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState: (state) => states.push(state) }));
  assert.equal(prompts.length, 1);
  assert.equal(states.at(-1).submissionState, 'rejected');
  assert.equal(states.at(-1).uncertain, false);
});

test('an observation failure after prompt acceptance preserves submitted identity', async () => {
  const { client, prompts } = fixture({ historyError: new Error('history unavailable') });
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState: (state) => states.push(state) }));
  assert.equal(prompts.length, 1);
  assert.equal(states.at(-1).state, 'failed');
  assert.equal(states.at(-1).submissionState, 'submitted');
  assert.equal(states.at(-1).uncertain, false);
  assert.equal(states.at(-1).turnFinished, false);
});

test('a failing submitted checkpoint never retries an accepted prompt', async () => {
  const { client, prompts } = fixture();
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState(state) {
    states.push(state);
    if (state.state === 'submitted') throw new Error('accepted checkpoint unavailable');
  } }), /accepted checkpoint unavailable/);
  assert.equal(prompts.length, 1);
  assert.equal(states.at(-1).state, 'failed');
  assert.equal(states.at(-1).submissionState, 'submitted');
  assert.equal(states.at(-1).promptRpcId, prompts[0].rpcId);
});

test('a failing completed checkpoint retains the observed result for recovery', async () => {
  const { client, prompts } = fixture();
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState(state) {
    states.push(state);
    if (state.state === 'completed') throw new Error('completed checkpoint unavailable');
  } }), /completed checkpoint unavailable/);
  assert.equal(prompts.length, 1);
  assert.equal(states.at(-1).state, 'failed');
  assert.equal(states.at(-1).completionObserved, true);
  assert.equal(states.at(-1).turnFinished, true);
  assert.equal(states.at(-1).text, 'Answer');
});

test('an internal RPC error retains commit uncertainty without retrying', async () => {
  const { client, prompts } = fixture({ promptResult: (rpcId) => ({
    rpcId, result: { ok: false, error: { code: 'internal', message: 'Commit status unavailable' } },
  }) });
  const states = [];
  await assert.rejects(client.ask('session', 'hello', { onPromptState: (state) => states.push(state) }));
  assert.equal(prompts.length, 1);
  assert.equal(states.at(-1).submissionState, 'unknown');
  assert.equal(states.at(-1).uncertain, true);
});

test('validation before submission reports a failed checkpoint without a prompt', async () => {
  const { client, prompts } = fixture();
  const states = [];
  await assert.rejects(client.ask('session', [], { onPromptState: (state) => states.push(state) }), /prompt content/);
  assert.equal(prompts.length, 0);
  assert.equal(states.at(-1).state, 'failed');
  assert.equal(states.at(-1).submissionState, 'not-submitted');
  assert.equal(states.at(-1).uncertain, false);
});
