import { HarnessReplyTracker } from '../../shared/harness-client.mjs';

const KIND = 'message-task';
const TERMINAL = new Set(['delivered', 'failed', 'interrupted', 'cancelled']);
const STATES = new Set([
  'queued', 'submitting', 'submitted', 'running', 'completed', 'submission-unknown',
  'interrupted', 'failed', 'cancelled', 'delivering', 'delivery-unknown', 'delivered',
]);
const storeQueues = new WeakMap();

function operationId(messageId) {
  if (typeof messageId !== 'string' || !/^\d{5,30}$/.test(messageId)) {
    throw new TypeError('A Discord messageId is required');
  }
  return `message-${messageId}`;
}

function facts(patch) {
  const result = {};
  for (const key of ['sessionId', 'promptRpcId', 'errorCode', 'deliveryMessageId']) {
    if (patch[key] === null || (typeof patch[key] === 'string' && patch[key].length <= 256)) {
      result[key] = patch[key];
    }
  }
  for (const key of ['baselineSeq', 'turn', 'lastSeq']) {
    if (patch[key] === null || (Number.isSafeInteger(patch[key]) && patch[key] >= (key === 'turn' ? 0 : -1))) {
      result[key] = patch[key];
    }
  }
  for (const key of ['uncertain', 'turnFinished', 'completionObserved']) {
    if (typeof patch[key] === 'boolean') result[key] = patch[key];
  }
  if (['not-submitted', 'rejected', 'unknown', 'submitted'].includes(patch.submissionState)) {
    result.submissionState = patch.submissionState;
  }
  if (typeof patch.text === 'string') result.text = patch.text;
  if (typeof patch.noticeState === 'string') result.noticeState = patch.noticeState;
  if (Array.isArray(patch.attachments)) result.attachments = patch.attachments.map((item) => ({
    kind: item.kind, name: item.name, mediaType: item.mediaType, size: item.size, cache: item.cache,
  }));
  if (Array.isArray(patch.deliveryMessageIds)) {
    result.deliveryMessageIds = patch.deliveryMessageIds.filter((id) => typeof id === 'string' && /^\d{5,30}$/.test(id));
  }
  return result;
}

function outcome(entry, status = entry.state) {
  const payload = entry.payload;
  return {
    operationId: entry.operationId,
    messageId: payload.messageId,
    channelId: payload.channelId,
    operatorId: payload.operatorId,
    sessionId: payload.sessionId ?? null,
    promptRpcId: payload.promptRpcId ?? null,
    baselineSeq: payload.baselineSeq ?? null,
    turn: payload.turn ?? null,
    lastSeq: payload.lastSeq ?? null,
    status,
    text: payload.text ?? null,
    requiresResubmission: status === 'queued',
  };
}

/** Durable submission identity and result checkpoints; recovery never replays prompts. */
export class WorkbenchTaskJournal {
  #store;
  #harness;

  constructor({ store, harness } = {}) {
    if (!store || ['beginOperation', 'updateOperation', 'listOperations', 'completeOperation']
      .some((method) => typeof store[method] !== 'function')) {
      throw new TypeError('A workbench operation store is required');
    }
    this.#store = store;
    this.#harness = harness;
  }

  // Serialize across journals sharing a store, including the write awaited by accept.
  #run(call) {
    const pending = (storeQueues.get(this.#store) ?? Promise.resolve()).then(call);
    storeQueues.set(this.#store, pending.catch(() => undefined));
    return pending;
  }

  #find(id) {
    return this.#store.listOperations().find((entry) => entry.operationId === id) ?? null;
  }

  accept({ messageId, channelId, operatorId, sessionId = null }) {
    const id = operationId(messageId);
    if (![channelId, operatorId].every((value) => typeof value === 'string' && /^\d{5,30}$/.test(value))
      || (sessionId !== null && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256))) {
      throw new TypeError('Valid channelId, operatorId and sessionId are required');
    }
    return this.#run(async () => {
      const existing = this.#find(id);
      if (existing) return { accepted: false, entry: structuredClone(existing) };
      const entry = await this.#store.beginOperation({
        operationId: id, kind: KIND, state: 'queued',
        payload: { messageId, channelId, operatorId, sessionId },
      });
      return { accepted: true, entry: structuredClone(entry) };
    });
  }

  async #update(id, state, patch = {}) {
    if (!STATES.has(state)) throw new TypeError('Invalid workbench task state');
    const entry = this.#find(id);
    if (!entry || entry.kind !== KIND) throw new Error('Workbench task is not accepted');
    const updated = await this.#store.updateOperation(id, {
      state, payload: { ...entry.payload, ...facts(patch) },
    });
    return structuredClone(updated);
  }

  update(messageId, state, patch = {}) {
    const id = operationId(messageId);
    return this.#run(() => this.#update(id, state, patch));
  }

  promptLifecycle(messageId) {
    operationId(messageId);
    return async (event) => {
      let state;
      if (event.state === 'submitting') state = 'submitting';
      else if (event.state === 'submitted') state = 'running';
      else if (event.state === 'completed' || event.completionObserved === true) state = 'completed';
      else if (event.state === 'failed') {
        if (event.uncertain === true || event.submissionState === 'unknown') state = 'submission-unknown';
        else if (event.submissionState === 'submitted' && event.turnFinished !== true) state = 'running';
        else state = 'failed';
      } else throw new TypeError('Invalid Harness prompt lifecycle state');
      return this.update(messageId, state, event);
    };
  }

  async #history(payload, signal) {
    const events = new Map();
    let beforeSeq;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      signal.throwIfAborted();
      const page = await this.#harness.rpc('session.history', {
        sessionId: payload.sessionId, maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }, 10_000, { signal });
      if (!Array.isArray(page?.events) || typeof page.hasMore !== 'boolean') {
        throw new Error('Invalid Harness history page');
      }
      let oldest = beforeSeq ?? Infinity;
      for (const entry of page.events) {
        const event = entry?.event;
        if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0
          || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object'
          || (beforeSeq !== undefined && event.seq >= beforeSeq)) {
          throw new Error('Invalid Harness history event');
        }
        events.set(event.seq, event);
        oldest = Math.min(oldest, event.seq);
      }
      const tracker = new HarnessReplyTracker({
        promptRpcId: payload.promptRpcId, afterSeq: payload.baselineSeq, finalAnswerOnly: true,
      });
      tracker.consumeAll([...events.values()]);
      if (tracker.turn !== null || !page.hasMore || oldest <= payload.baselineSeq + 1) return tracker;
      if (!Number.isFinite(oldest) || oldest === beforeSeq) throw new Error('Harness history did not advance');
      beforeSeq = oldest;
    }
    throw new Error('Harness history identity could not be verified');
  }

  async #running(sessionId, signal) {
    const result = await this.#harness.rpc('session.list', {}, 10_000, { signal });
    if (!Array.isArray(result?.items) || result.items.some((item) => (
      typeof item?.sessionId !== 'string' || typeof item.running !== 'boolean'
    ))) throw new Error('Invalid Harness session list');
    return result.items.find((item) => item.sessionId === sessionId)?.running ?? false;
  }

  async #recoverEntry(entry, callerSignal) {
    const id = entry.operationId;
    const payload = entry.payload;
    if (entry.state === 'queued') return outcome(entry);
    if (['delivering', 'delivery-unknown'].includes(entry.state)) {
      return outcome(await this.#update(id, 'delivery-unknown'));
    }
    if (entry.state === 'completed' && typeof payload.text === 'string') return outcome(entry);
    if (!payload.sessionId || !payload.promptRpcId
      || !Number.isSafeInteger(payload.baselineSeq) || payload.baselineSeq < -1) {
      return outcome(await this.#update(id, 'submission-unknown'));
    }
    const timeout = AbortSignal.timeout(10_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let tracker;
    try {
      tracker = await this.#history(payload, signal);
    } catch (error) {
      callerSignal?.throwIfAborted();
      return outcome(await this.#update(id, 'submission-unknown'));
    }
    if (tracker.turn === null) return outcome(await this.#update(id, 'submission-unknown'));
    if (!tracker.finished) {
      try {
        if (await this.#running(payload.sessionId, signal)) {
          return outcome(await this.#update(id, 'running', { turn: tracker.turn, lastSeq: tracker.lastSeq }));
        }
        // The turn may have ended after the first history snapshot but before the idle probe.
        tracker = await this.#history(payload, signal);
        if (tracker.turn === null) return outcome(await this.#update(id, 'submission-unknown'));
      } catch (error) {
        callerSignal?.throwIfAborted();
        // An unavailable liveness probe cannot prove the identified turn was interrupted.
        return outcome(await this.#update(id, 'running', { turn: tracker.turn, lastSeq: tracker.lastSeq }));
      }
    }
    const reason = tracker.reason?.kind ?? tracker.reason;
    const state = tracker.finished && reason === 'completed' ? 'completed' : 'interrupted';
    return outcome(await this.#update(id, state, {
      turn: tracker.turn, lastSeq: tracker.lastSeq,
      ...(state === 'completed' ? { text: tracker.finalAnswer, completionObserved: true, turnFinished: true } : {}),
    }));
  }

  recover({ signal, excludeMessageIds = new Set() } = {}) {
    return this.#run(async () => {
      signal?.throwIfAborted();
      const entries = this.#store.listOperations().filter((entry) => entry.kind === KIND
        && !TERMINAL.has(entry.state) && !excludeMessageIds.has(entry.payload.messageId));
      const results = [];
      for (const entry of entries) {
        signal?.throwIfAborted();
        results.push(await this.#recoverEntry(entry, signal));
      }
      return results;
    });
  }
}
