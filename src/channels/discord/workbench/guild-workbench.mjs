import { classifyWorkbenchMessage, normalizeWorkbenchConfig } from './access.mjs';
import {
  ChannelSessionRouter,
  workbenchRoutingMessage,
} from './channel-session-router.mjs';
import { WorkbenchQueue } from './queue.mjs';

/**
 * Facade that binds the Guild-workbench pieces to one Discord bot runtime.
 *
 * The runtime asks this object three things: whether one inbound message is
 * managed, how a managed conversation resolves its fixed Session, and which
 * typed commands must be refused because they would fight the fixed binding.
 */

const LEGACY_COMMAND_REFUSALS = [
  {
    test: (text) => /^\/new(?:\s|$)/iu.test(text),
    message: '工作台模式下每个频道固定一个会话。请在项目分组中执行 /session new 新建会话频道。',
  },
  {
    test: (text) => /^\/(?:session|sessions)(?:\s|$)/iu.test(text),
    message: '工作台模式下每个频道固定一个会话。请使用 Discord 原生命令管理会话频道。',
  },
  {
    test: (text) => /^\/(?:workspace|ws|conv|conversation|thread|preset|presetlist|presets)(?:\s|$)/iu.test(text),
    message: '工作台模式下项目由频道分组决定。请用 /project 管理项目，避免修改 Bot 全局默认。',
  },
];

export class DiscordGuildWorkbench {
  #config;
  #store;
  #router;
  #ownerUserId;
  #logger;
  #queue;

  constructor({
    config, store, harness, state = null, ownerUserId = null, logger = console, createOptions = {},
    queue = null,
  }) {
    const normalized = normalizeWorkbenchConfig(config);
    if (!normalized?.enabled) throw new TypeError('The Guild workbench requires an enabled configuration');
    if (!store) throw new TypeError('The Guild workbench requires a loaded store');
    this.#config = normalized;
    this.#store = store;
    this.#ownerUserId = ownerUserId;
    this.#logger = logger;
    this.#queue = queue ?? new WorkbenchQueue({
      maxConcurrentTasks: normalized.maxConcurrentTasks,
      projectConcurrency: normalized.projectConcurrency,
      reservations: () => store.listOperations().filter((entry) => entry.kind === 'message-task'
        && ['submitting', 'submitted', 'running', 'submission-unknown'].includes(entry.state))
        .map((entry) => ({
          sessionId: entry.payload.sessionId ?? store.channel(entry.payload.channelId)?.sessionId ?? entry.operationId,
          projectId: store.channel(entry.payload.channelId)?.projectId,
        })),
    });
    this.#router = new ChannelSessionRouter({
      store, harness, state, logger, createOptions, queue: this.#queue,
    });
  }

  get config() { return this.#config; }
  get store() { return this.#store; }
  get router() { return this.#router; }
  get queue() { return this.#queue; }
  get guildId() { return this.#config.guildId; }

  /** Whether the inbound message belongs to workbench routing. */
  classify(message) {
    return classifyWorkbenchMessage(this.#config, message, { ownerUserId: this.#ownerUserId });
  }

  /**
   * Classify one inbound guild message for routing.
   *
   * A plain text/announcement channel inside a mapped Category joins the
   * workbench lazily, on the first authorized message. Threads, voice channels
   * and channels in unmapped categories fall back to the legacy paths.
   */
  classifyChannelMessage(message, { channel = null } = {}) {
    const decision = this.classify(message);
    if (!decision.managed) return decision;
    const channelId = String(message?.channel_id ?? '');
    if (!channelId) return { managed: false, reason: 'channel' };
    if (this.#store.channel(channelId)) {
      return { ...decision, managed: true, channelId, register: false };
    }
    const type = Number(channel?.type);
    if (type !== 0 && type !== 5) return { managed: false, reason: 'channel-type' };
    const categoryId = channel?.parent_id ? String(channel.parent_id) : null;
    const project = categoryId ? this.#store.projectForCategory(categoryId) : null;
    if (!project) return { managed: false, reason: 'channel' };
    return { ...decision, managed: true, channelId, register: true, projectId: project.projectId };
  }

  /** Idempotent lazy registration of a channel inside a mapped Category. */
  async registerChannel({ channelId, projectId, title = null }) {
    const existing = this.#store.channel(channelId);
    if (existing) return existing;
    return this.#store.registerChannel({ channelId, projectId, title });
  }

  /** Prepare project scoping and the fixed binding before tasks or controls. */
  prepareChannel(channelId) {
    return this.#router.prepareChannel(channelId);
  }

  /** Whether one sender may drive workbench operations from a Guild context. */
  isOperator(senderId) {
    return classifyWorkbenchMessage(
      this.#config,
      { guild_id: this.#config.guildId, author: { id: senderId, bot: false } },
      { ownerUserId: this.#ownerUserId },
    ).managed;
  }

  /** Bridge hook: resolve the fixed Session for one managed channel. */
  sessionResolver(context) {
    return this.#router.resolveForAsk(context);
  }

  /** Bridge hook: operator-facing text for a routing refusal. */
  routingMessage(error) {
    return workbenchRoutingMessage(error);
  }

  /**
   * Bridge hook: refuse typed commands whose legacy behavior would fight the
   * fixed channel binding. Returns null for everything else.
   */
  commandOverride(text, { message } = {}) {
    if (typeof text !== 'string' || !text.startsWith('/')) return null;
    const channelId = String(message?.conversationId ?? '');
    if (!this.#store.channel(channelId)) return null;
    const match = LEGACY_COMMAND_REFUSALS.find((entry) => entry.test(text));
    return match ? match.message : null;
  }

  /** Durable status used by /status and the session card. */
  status() {
    const projects = this.#store.listProjects();
    const channels = this.#store.listChannels();
    return {
      enabled: true,
      guildId: this.#config.guildId,
      projects: projects.length,
      channels: channels.length,
      boundChannels: channels.filter((item) => item.sessionId).length,
      allowedOperators: this.#config.allowedUserIds.length,
      projectRoots: [...this.#config.projectRoots],
      maxConcurrentTasks: this.#config.maxConcurrentTasks,
      projectConcurrency: this.#config.projectConcurrency,
    };
  }

  /** Channel + project + session routing facts for one managed channel. */
  describeChannel(channelId) {
    return this.#router.routingContext(String(channelId));
  }
}
