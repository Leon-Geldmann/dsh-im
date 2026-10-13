import { withSessionBindingLock } from '../../shared/session-binding-lock.mjs';

/**
 * Channel -> Session routing for the Guild workbench.
 *
 * One managed text channel keeps exactly one DSH Session for its whole life:
 *
 * - a channel that already holds a Session keeps that binding through
 *   reconnects, renames, model switches and plugin restarts;
 * - a Session that is gone (or whose state cannot be read) is reported, never
 *   silently replaced;
 * - the first authorized message in a project channel creates the Session once,
 *   under a per-channel lock, so two concurrent first messages cannot produce
 *   two Sessions.
 */

export class WorkbenchRoutingError extends Error {
  constructor(code, message, { channelId = null, sessionId = null } = {}) {
    super(message);
    this.name = 'WorkbenchRoutingError';
    this.code = code;
    if (channelId) this.channelId = channelId;
    if (sessionId) this.sessionId = sessionId;
  }
}

/** Operator-facing text for a routing refusal, kept beside the codes it explains. */
export function workbenchRoutingMessage(error) {
  switch (error?.code) {
    case 'workbench-channel-archived':
      return '该频道已归档，暂时不能提交新任务。请用 /session restore 恢复会话。';
    case 'workbench-session-missing':
      return '该频道绑定的会话已不存在，原绑定已保留。请检查 DSH 会话，或用原生 /session new 新建会话频道。';
    case 'workbench-session-unverified':
      return '暂时无法确认会话状态，原绑定已保留，本次消息未提交。请稍后重试。';
    case 'workbench-project-unknown':
      return '该频道所属项目已被移除，消息未提交。请用 /project bind 重新绑定项目。';
    case 'workbench-channel-unknown':
      return '该频道尚未纳入工作台管理，消息未提交。请在项目分组中新建频道，或用 /session new。';
    case 'workbench-session-create-failed':
      return '新会话创建或绑定未完成，消息未提交。请用 /status 检查状态；已知会话会重试绑定，结果不明时不会重复创建。';
    case 'workbench-session-create-uncertain':
      return '上次会话创建结果尚未确认，本次消息未提交。为避免重复创建，请先检查 DSH 会话与工作台操作记录。';
    case 'workbench-task-unresolved':
      return '之前的任务仍在运行或提交结果尚未核实，本次消息未提交。请先在 DSH 核对原任务，确认结束后重发。';
    default:
      return null;
  }
}

export class ChannelSessionRouter {
  #store;
  #harness;
  #logger;
  #createOptions;
  #queue;
  #state;

  constructor({ store, harness, state = null, logger = console, createOptions = {}, queue = null }) {
    if (!store || typeof store.channel !== 'function') {
      throw new TypeError('ChannelSessionRouter requires the workbench store');
    }
    if (!harness) throw new TypeError('ChannelSessionRouter requires the Harness client');
    this.#store = store;
    this.#harness = harness;
    this.#logger = logger;
    this.#createOptions = createOptions;
    this.#queue = queue;
    this.#state = state;
  }

  get store() { return this.#store; }

  /**
   * Wrap the Session's ask in the task queue so project/global concurrency is
   * enforced in code. Control calls (stop, steer, model) go directly to the
   * Harness and never wait behind queued work.
   */
  #withAdmission(session, { sessionId, projectId, channelId, validateRoute }) {
    if (!this.#queue || typeof session?.ask !== 'function') return session;
    const ask = session.ask.bind(session);
    return Object.freeze({
      ...session,
      ask: (prompt, options) => this.#queue.run(
        { sessionId, projectId },
        async () => {
          await validateRoute?.();
          const current = this.#store.channel(channelId);
          if (!current || current.lifecycle !== 'active') throw new WorkbenchRoutingError(
            'workbench-channel-archived', 'Channel is no longer active', { channelId, sessionId });
          if (current.sessionId !== sessionId || current.projectId !== projectId) throw new WorkbenchRoutingError(
            'workbench-session-unverified', 'Queued routing context changed', { channelId, sessionId });
          return ask(prompt, options);
        },
      ),
    });
  }

  /**
   * Synchronous routing facts for one channel. Returns null when the channel is
   * not managed; throws when it is managed but its project is gone.
   */
  routingContext(channelId) {
    const channel = this.#store.channel(String(channelId));
    if (!channel) return null;
    const project = this.#store.project(channel.projectId);
    if (!project) {
      throw new WorkbenchRoutingError(
        'workbench-project-unknown',
        'The channel project is no longer registered',
        { channelId: channel.channelId },
      );
    }
    return { channel, project };
  }

  async #setControlBinding(channelId, sessionId, state) {
    if (!sessionId || !state) return;
    if (await state.setSession(`group:${channelId}`, sessionId) === false) {
      throw new WorkbenchRoutingError(
        'workbench-session-unverified',
        'The workspace scope refused the managed Session binding',
        { channelId, sessionId },
      );
    }
  }

  /** Align only this conversation; adopting a Session can change the bot default. */
  async prepareChannel(channelId, { state = this.#state } = {}) {
    const id = String(channelId);
    // Commands may already hold the creation/binding lock when they prepare.
    return withSessionBindingLock(this.#store, `prepare:${id}`, async () => {
      const context = this.routingContext(id);
      if (!context) {
        throw new WorkbenchRoutingError(
          'workbench-channel-unknown',
          'The channel is not managed by the workbench',
          { channelId: id },
        );
      }
      const key = `group:${id}`;
      if (typeof this.#harness.currentConversationWorkspace === 'function'
        && this.#harness.currentConversationWorkspace(key) !== context.project.workspacePath) {
        await this.#harness.switchConversationWorkspace(key, context.project.workspacePath);
      }
      await this.#setControlBinding(id, context.channel.sessionId, state);
      return context;
    });
  }

  /**
   * Prove a bound Session still exists. A failed lookup is not evidence of
   * absence: it raises its own code so the caller can keep the mapping and tell
   * the operator to retry rather than rebuild.
   */
  async #assertPresent({ sessionId, sessionExists, session, signal, options }) {
    let present;
    try {
      present = await sessionExists(session, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new WorkbenchRoutingError(
        'workbench-session-unverified',
        'The Session state could not be read',
        { sessionId },
      );
    }
    if (present !== true) {
      throw new WorkbenchRoutingError(
        'workbench-session-missing',
        'The bound Session does not exist',
        { sessionId },
      );
    }
  }

  async #recordRoutingError(channelId, error) {
    try {
      await this.#store.noteChannelError(channelId, error.message);
    } catch (writeError) {
      this.#logger.warn?.('[dsh-im:discord] workbench routing error was not persisted:', writeError);
    }
  }

  /**
   * Resolve the Session a message in this channel must go to, creating it on
   * the first authorized message of a registered channel.
   */
  async resolveForAsk({
    message, sessionExists, createSession, workspaceSession, signal, titleText = null,
    state = this.#state,
  }) {
    const channelId = String(message?.conversationId ?? '');
    const context = await this.prepareChannel(channelId, { state });
    const { channel, project } = context;
    if (channel.lifecycle !== 'active') {
      throw new WorkbenchRoutingError(
        'workbench-channel-archived',
        'The channel is archived',
        { channelId },
      );
    }
    const { sessionId, created } = await this.#createForChannel({
      channelId, project, createSession, signal, titleText,
    });
    await this.#setControlBinding(channelId, sessionId, state);
    const session = workspaceSession(this.#harness, sessionId, `group:${channelId}`);
    if (!created) {
      try {
        await this.#assertPresent({
          sessionId,
          sessionExists,
          session,
          signal,
          options: signal ? { signal } : undefined,
        });
      } catch (error) {
        await this.#recordRoutingError(channelId, error);
        throw error;
      }
    }
    return {
      sessionId,
      session: this.#withAdmission(session, { sessionId, projectId: project.projectId,
        channelId, validateRoute: message?.validateWorkbenchRoute }),
      created,
    };
  }

  /** Native creation and lazy first-message creation share the same journal. */
  async createForChannel(channelId, { titleText = null } = {}) {
    const { project } = this.routingContext(String(channelId));
    const result = await this.#createForChannel({
      channelId: String(channelId), project, titleText,
      createSession: (harness, options) => harness.createSession(options),
    });
    await this.#setControlBinding(String(channelId), result.sessionId, this.#state);
    return result;
  }

  async #createForChannel({ channelId, project, createSession, signal, titleText }) {
    return withSessionBindingLock(this.#store, `channel:${channelId}`, async () => {
      // Re-read inside the lock: a concurrent first message may have bound the
      // channel while this one waited.
      const channel = this.#store.channel(channelId);
      const operationId = `session-create:${channelId}`;
      const operation = this.#store.operation(operationId);
      if (channel?.sessionId && !operation) return { sessionId: channel.sessionId, created: false };
      let sessionId = operation?.payload?.sessionId;
      if (operation && (typeof sessionId !== 'string' || !sessionId)) {
        throw new WorkbenchRoutingError(
          'workbench-session-create-uncertain',
          'An earlier Session creation has no confirmed result',
          { channelId },
        );
      }
      let created = false;
      if (!operation) {
        // Commit intent before the irreversible request. A lost response must
        // never turn the next message into another create request.
        await this.#store.beginOperation({
          operationId,
          kind: 'create-channel-session',
          state: 'session-creating',
          payload: { channelId, projectId: project.projectId, workspacePath: project.workspacePath },
        });
        try {
          sessionId = await createSession(this.#harness, {
            ...this.#createOptions,
            workspace: project.workspacePath,
            conversationKey: `group:${channelId}`,
            ...(signal ? { signal } : {}),
          });
          if (typeof sessionId !== 'string' || !sessionId) {
            sessionId = null;
            throw new TypeError('The Harness returned an invalid Session id');
          }
          // The id must reach disk before binding: a failed bind can then be
          // retried for this same Session after a process restart.
          await this.#store.updateOperation(operationId, {
            state: 'session-created',
            payload: { channelId, projectId: project.projectId, workspacePath: project.workspacePath, sessionId },
          });
          created = true;
        } catch (error) {
          if (signal?.aborted) throw error;
          const failure = new WorkbenchRoutingError(
            'workbench-session-create-failed',
            'The Session creation result could not be confirmed and persisted',
            { channelId, sessionId },
          );
          failure.cause = error;
          throw failure;
        }
      }
      try {
        await this.#store.bindChannelSession(channelId, sessionId, {
          title: titleText ?? channel?.title ?? null,
        });
      } catch (error) {
        // The Session exists in the Harness either way; surface the binding
        // failure instead of pretending the channel is ready.
        const failure = new WorkbenchRoutingError(
          'workbench-session-create-failed',
          'The Session could not be bound to the channel',
          { channelId, sessionId },
        );
        failure.cause = error;
        throw failure;
      }
      await this.#store.completeOperation(operationId);
      return { sessionId, created };
    });
  }

  /**
   * Bind a channel to an existing Session on explicit operator request.
   * Verified before commit so a typo cannot park the channel on a missing id.
   */
  async bindExistingSession(channelId, sessionId, { workspaceSession, sessionExists, signal } = {}) {
    channelId = String(channelId);
    const context = await this.prepareChannel(channelId);
    if (context.channel.sessionId && context.channel.sessionId !== sessionId) {
      throw new WorkbenchRoutingError(
        'workbench-session-conflict',
        'A managed channel cannot change its Session binding',
        { channelId, sessionId: context.channel.sessionId },
      );
    }
    const session = workspaceSession(this.#harness, sessionId, `group:${channelId}`);
    await this.#assertPresent({
      sessionId,
      sessionExists,
      session,
      signal,
      options: signal ? { signal } : undefined,
    });
    const owner = this.#store.channelForSession(sessionId);
    if (owner && owner.channelId !== channelId) {
      throw new WorkbenchRoutingError(
        'workbench-session-taken',
        'The Session is already bound to another channel',
        { channelId, sessionId },
      );
    }
    await this.#store.bindChannelSession(channelId, sessionId, {
      projectId: context.project.projectId,
    });
    await this.#setControlBinding(channelId, sessionId, this.#state);
    return session;
  }
}
