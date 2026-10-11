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
      return '该频道绑定的会话已不存在，原绑定已保留。请用 /session new 新建会话，或 /session open 重新绑定。';
    case 'workbench-session-unverified':
      return '暂时无法确认会话状态，原绑定已保留，本次消息未提交。请稍后重试。';
    case 'workbench-project-unknown':
      return '该频道所属项目已被移除，消息未提交。请用 /project bind 重新绑定项目。';
    case 'workbench-channel-unknown':
      return '该频道尚未纳入工作台管理，消息未提交。请在项目分组中新建频道，或用 /session new。';
    case 'workbench-session-create-failed':
      return '新会话创建失败，消息未提交。请稍后重试或用 /status 查看连接状态。';
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

  constructor({ store, harness, logger = console, createOptions = {}, queue = null }) {
    if (!store || typeof store.channel !== 'function') {
      throw new TypeError('ChannelSessionRouter requires the workbench store');
    }
    if (!harness) throw new TypeError('ChannelSessionRouter requires the Harness client');
    this.#store = store;
    this.#harness = harness;
    this.#logger = logger;
    this.#createOptions = createOptions;
    this.#queue = queue;
  }

  get store() { return this.#store; }

  /**
   * Wrap the Session's ask in the task queue so project/global concurrency is
   * enforced in code. Control calls (stop, steer, model) go directly to the
   * Harness and never wait behind queued work.
   */
  #withAdmission(session, { sessionId, projectId }) {
    if (!this.#queue || typeof session?.ask !== 'function') return session;
    const ask = session.ask.bind(session);
    return Object.freeze({
      ...session,
      ask: (prompt, options) => this.#queue.run(
        { sessionId, projectId },
        () => ask(prompt, options),
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
  }) {
    const channelId = String(message?.conversationId ?? '');
    const context = this.routingContext(channelId);
    if (!context) {
      throw new WorkbenchRoutingError(
        'workbench-channel-unknown',
        'The channel is not managed by the workbench',
        { channelId },
      );
    }
    const { channel, project } = context;
    if (channel.lifecycle !== 'active') {
      throw new WorkbenchRoutingError(
        'workbench-channel-archived',
        'The channel is archived',
        { channelId },
      );
    }
    const existsOptions = signal ? { signal } : undefined;
    if (channel.sessionId) {
      const session = workspaceSession(this.#harness, channel.sessionId, `group:${channelId}`);
      try {
        await this.#assertPresent({
          sessionId: channel.sessionId,
          sessionExists,
          session,
          signal,
          options: existsOptions,
        });
      } catch (error) {
        await this.#recordRoutingError(channelId, error);
        throw error;
      }
      return {
        sessionId: channel.sessionId,
        session: this.#withAdmission(session, {
          sessionId: channel.sessionId,
          projectId: project.projectId,
        }),
      };
    }

    const sessionId = await this.#createForChannel({
      channelId, project, createSession, signal, titleText,
    });
    return {
      sessionId,
      session: this.#withAdmission(
        workspaceSession(this.#harness, sessionId, `group:${channelId}`),
        { sessionId, projectId: project.projectId },
      ),
      created: true,
    };
  }

  async #createForChannel({ channelId, project, createSession, signal, titleText }) {
    return withSessionBindingLock(this.#store, `channel:${channelId}`, async () => {
      // Re-read inside the lock: a concurrent first message may have bound the
      // channel while this one waited.
      const channel = this.#store.channel(channelId);
      if (channel?.sessionId) return channel.sessionId;
      let sessionId;
      try {
        sessionId = await createSession(this.#harness, {
          workspace: project.workspacePath,
          conversationKey: `group:${channelId}`,
          ...(signal ? { signal } : {}),
          ...this.#createOptions,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = new WorkbenchRoutingError(
          'workbench-session-create-failed',
          'The Harness did not create a Session',
          { channelId },
        );
        failure.cause = error;
        throw failure;
      }
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new WorkbenchRoutingError(
          'workbench-session-create-failed',
          'The Harness returned an invalid Session id',
          { channelId },
        );
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
      return sessionId;
    });
  }

  /**
   * Bind a channel to an existing Session on explicit operator request.
   * Verified before commit so a typo cannot park the channel on a missing id.
   */
  async bindExistingSession(channelId, sessionId, { workspaceSession, sessionExists, signal } = {}) {
    const context = this.routingContext(channelId);
    if (!context) {
      throw new WorkbenchRoutingError(
        'workbench-channel-unknown',
        'The channel is not managed by the workbench',
        { channelId },
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
      replace: true,
      projectId: context.project.projectId,
    });
    return session;
  }
}
