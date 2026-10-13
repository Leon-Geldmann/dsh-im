import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Persistent Guild-workbench state for one Discord bot.
 *
 * The store owns the durable mapping the whole feature depends on:
 * Guild -> DSH instance binding, Category -> project, Channel -> Session, plus
 * the interaction-action ledger, multi-step operation recovery records, and the
 * processed-event set that keeps a Gateway replay from submitting twice.
 *
 * Every Discord identifier is kept as a string. Names are display-only and are
 * never used to address a project or compose a filesystem path.
 */

export const WORKBENCH_STORE_VERSION = 1;
const MAX_PROCESSED_EVENTS = 1_000;
const MAX_ACTIONS = 512;

export const CHANNEL_LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DEEP_ARCHIVED: 'deep-archived',
});

export const SESSION_STATE = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
});

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{5,30}$/.test(value);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeText(value, max = 256) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

function emptyState() {
  return {
    version: WORKBENCH_STORE_VERSION,
    guildId: null,
    identity: null,
    projects: {},
    channels: {},
    sessions: {},
    actions: {},
    operations: {},
    processed: [],
  };
}

function normalizeProject(value) {
  if (!value || typeof value !== 'object') return null;
  const projectId = safeText(value.projectId, 64);
  const categoryId = isSnowflake(value.categoryId) ? value.categoryId : null;
  const workspacePath = typeof value.workspacePath === 'string' && value.workspacePath.startsWith('/')
    ? value.workspacePath : null;
  const name = safeText(value.name, 100);
  if (!projectId || !categoryId || !workspacePath || !name) return null;
  return {
    projectId,
    name,
    categoryId,
    workspacePath,
    createdAt: safeText(value.createdAt, 40) ?? new Date(0).toISOString(),
  };
}

function normalizeChannel(value) {
  if (!value || typeof value !== 'object') return null;
  const channelId = isSnowflake(value.channelId) ? value.channelId : null;
  const projectId = safeText(value.projectId, 64);
  if (!channelId || !projectId) return null;
  const lifecycle = Object.values(CHANNEL_LIFECYCLE).includes(value.lifecycle)
    ? value.lifecycle : CHANNEL_LIFECYCLE.ACTIVE;
  return {
    channelId,
    projectId,
    sessionId: cleanString(value.sessionId),
    title: safeText(value.title, 100),
    lifecycle,
    createdAt: safeText(value.createdAt, 40) ?? new Date(0).toISOString(),
    updatedAt: safeText(value.updatedAt, 40) ?? new Date(0).toISOString(),
    lastError: safeText(value.lastError, 500),
  };
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionId = safeText(value.sessionId, 256);
  const channelId = isSnowflake(value.channelId) ? value.channelId : null;
  const projectId = safeText(value.projectId, 64);
  if (!sessionId || !channelId || !projectId) return null;
  const state = Object.values(SESSION_STATE).includes(value.state)
    ? value.state : SESSION_STATE.ACTIVE;
  return {
    sessionId,
    channelId,
    projectId,
    state,
    archivedAt: safeText(value.archivedAt, 40),
    ...(safeText(value.title, 100) ? { title: safeText(value.title, 100) } : {}),
    ...(value.detached === true ? { detached: true } : {}),
    createdAt: safeText(value.createdAt, 40) ?? new Date(0).toISOString(),
  };
}

function normalizeAction(value) {
  if (!value || typeof value !== 'object') return null;
  const actionId = safeText(value.actionId, 64);
  const kind = safeText(value.kind, 64);
  if (!actionId || !kind) return null;
  return {
    actionId,
    kind,
    operatorId: isSnowflake(value.operatorId) ? value.operatorId : null,
    guildId: isSnowflake(value.guildId) ? value.guildId : null,
    channelId: isSnowflake(value.channelId) ? value.channelId : null,
    sessionId: cleanString(value.sessionId),
    payload: value.payload && typeof value.payload === 'object' ? structuredClone(value.payload) : {},
    expiresAt: Number.isSafeInteger(value.expiresAt) ? value.expiresAt : 0,
    consumedAt: Number.isSafeInteger(value.consumedAt) ? value.consumedAt : null,
  };
}

function normalizeOperation(value) {
  if (!value || typeof value !== 'object') return null;
  const operationId = safeText(value.operationId, 64);
  const kind = safeText(value.kind, 64);
  if (!operationId || !kind) return null;
  return {
    operationId,
    kind,
    state: safeText(value.state, 32) ?? 'pending',
    payload: value.payload && typeof value.payload === 'object' ? structuredClone(value.payload) : {},
    createdAt: safeText(value.createdAt, 40) ?? new Date(0).toISOString(),
    updatedAt: safeText(value.updatedAt, 40) ?? new Date(0).toISOString(),
  };
}

function normalizeState(value) {
  const state = emptyState();
  if (!value || typeof value !== 'object') return state;
  if (isSnowflake(value.guildId)) state.guildId = value.guildId;
  if (value.identity && isSnowflake(value.identity.guildId)
    && safeText(value.identity.botId, 256) && safeText(value.identity.instanceId, 256)) {
    state.identity = {
      guildId: value.identity.guildId,
      botId: value.identity.botId,
      instanceId: value.identity.instanceId,
    };
  }
  if (value.projects && typeof value.projects === 'object') {
    for (const entry of Object.values(value.projects)) {
      const project = normalizeProject(entry);
      if (project) state.projects[project.projectId] = project;
    }
  }
  if (value.channels && typeof value.channels === 'object') {
    for (const entry of Object.values(value.channels)) {
      const channel = normalizeChannel(entry);
      if (channel && state.projects[channel.projectId]) state.channels[channel.channelId] = channel;
    }
  }
  if (value.sessions && typeof value.sessions === 'object') {
    for (const entry of Object.values(value.sessions)) {
      const session = normalizeSession(entry);
      if (!session) continue;
      const channel = state.channels[session.channelId];
      // A session mapping only survives when its channel still exists and the
      // pair agrees; a half-written document must not resurrect a route. The
      // exception is a detached record: a deep archive keeps it on purpose so
      // the channel can be recreated for the same Session.
      if (!session.detached && (!channel || channel.sessionId !== session.sessionId)) continue;
      state.sessions[session.sessionId] = session;
    }
  }
  if (value.actions && typeof value.actions === 'object') {
    for (const entry of Object.values(value.actions)) {
      const action = normalizeAction(entry);
      if (action) state.actions[action.actionId] = action;
    }
  }
  if (value.operations && typeof value.operations === 'object') {
    for (const entry of Object.values(value.operations)) {
      const operation = normalizeOperation(entry);
      if (operation) state.operations[operation.operationId] = operation;
    }
  }
  if (Array.isArray(value.processed)) {
    state.processed = value.processed
      .map((entry) => (entry && typeof entry === 'object'
        ? { id: safeText(entry.id, 64), at: safeText(entry.at, 40) }
        : null))
      .filter((entry) => entry?.id)
      .slice(-MAX_PROCESSED_EVENTS);
  }
  return state;
}

export class DiscordWorkbenchStore {
  #path;
  #state = emptyState();
  #writeQueue = Promise.resolve();

  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('workbench store path is required');
    this.#path = path;
  }

  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = emptyState();
      await this.persist();
    }
    return this;
  }

  get guildId() { return this.#state.guildId; }
  get inboxDirectory() { return join(dirname(this.#path), 'inbox'); }
  get archiveDirectory() { return join(dirname(this.#path), 'archives'); }

  snapshot() { return structuredClone(this.#state); }

  async bindIdentity({ guildId, botId, instanceId }) {
    if (!isSnowflake(guildId) || !safeText(botId, 256) || !safeText(instanceId, 256)) {
      throw new TypeError('Guild, bot and DSH instance identity are required');
    }
    const current = this.#state.identity;
    if ((this.#state.guildId && this.#state.guildId !== guildId)
      || (current && (current.guildId !== guildId || current.botId !== botId
        || current.instanceId !== instanceId))) {
      const error = new Error('The workbench belongs to a different Guild, bot or DSH instance.');
      error.code = 'workbench-identity-conflict';
      throw error;
    }
    this.#state.guildId = guildId;
    this.#state.identity = { guildId, botId, instanceId };
    await this.persist();
  }

  /**
   * Bind this store to one Guild. A different Guild is refused so a copied
   * configuration can never silently point the bot at another server.
   */
  async bindGuild(guildId, { rebind = false } = {}) {
    if (!isSnowflake(guildId)) throw new TypeError('A Discord Guild ID is required');
    const current = this.#state.guildId;
    if (this.#state.identity && this.#state.identity.guildId !== guildId) {
      throw Object.assign(new Error('The persisted workbench identity cannot be rebound.'), {
        code: 'workbench-identity-conflict',
      });
    }
    if (current && current !== guildId && !rebind) {
      const error = new Error('This bot is already bound to another Discord server.');
      error.code = 'workbench-guild-conflict';
      error.boundGuildId = current;
      throw error;
    }
    if (current === guildId) return false;
    this.#state.guildId = guildId;
    await this.persist();
    return true;
  }

  project(projectId) { return this.#state.projects[projectId] ?? null; }

  projectForCategory(categoryId) {
    if (!isSnowflake(categoryId)) return null;
    return Object.values(this.#state.projects).find((item) => item.categoryId === categoryId) ?? null;
  }

  listProjects() { return Object.values(this.#state.projects); }

  async putProject(value) {
    const project = normalizeProject(value);
    if (!project) throw new TypeError('Invalid workbench project');
    const current = this.project(project.projectId);
    if (current && (current.workspacePath !== project.workspacePath
      || current.categoryId !== project.categoryId) && this.listChannels(project.projectId).length > 0) {
      throw Object.assign(new Error('The project already has fixed channels; its directory and category cannot change.'), {
        code: 'workbench-project-conflict',
      });
    }
    const clash = this.projectForCategory(project.categoryId);
    if (clash && clash.projectId !== project.projectId) {
      const error = new Error('This Discord category is already bound to another project.');
      error.code = 'workbench-category-taken';
      error.projectId = clash.projectId;
      throw error;
    }
    this.#state.projects[project.projectId] = project;
    await this.persist();
    return project;
  }

  async removeProject(projectId) {
    const project = this.project(projectId);
    if (!project) return false;
    delete this.#state.projects[projectId];
    for (const channel of Object.values(this.#state.channels)) {
      if (channel.projectId !== projectId) continue;
      if (channel.sessionId) delete this.#state.sessions[channel.sessionId];
      delete this.#state.channels[channel.channelId];
    }
    await this.persist();
    return true;
  }

  channel(channelId) { return this.#state.channels[String(channelId)] ?? null; }

  session(sessionId) { return this.#state.sessions[String(sessionId)] ?? null; }

  listChannels(projectId = null) {
    const channels = Object.values(this.#state.channels);
    return projectId ? channels.filter((item) => item.projectId === projectId) : channels;
  }

  /** A Session belongs to at most one workbench channel. */
  channelForSession(sessionId) {
    const entry = this.session(sessionId);
    return entry ? this.channel(entry.channelId) : null;
  }

  async registerChannel({
    channelId, projectId, title = null, createdAt = new Date().toISOString(),
  }) {
    if (!isSnowflake(channelId)) throw new TypeError('A Discord channel ID is required');
    if (!this.project(projectId)) {
      const error = new Error('The project is not registered.');
      error.code = 'workbench-project-unknown';
      throw error;
    }
    const existing = this.channel(channelId);
    if (existing) {
      if (existing.projectId !== projectId) {
        const error = new Error('This channel is already registered to another project.');
        error.code = 'workbench-channel-taken';
        error.projectId = existing.projectId;
        throw error;
      }
      return existing;
    }
    const channel = {
      channelId,
      projectId,
      sessionId: null,
      title: safeText(title, 100),
      lifecycle: CHANNEL_LIFECYCLE.ACTIVE,
      createdAt,
      updatedAt: createdAt,
      lastError: null,
    };
    this.#state.channels[channelId] = channel;
    await this.persist();
    return channel;
  }

  /**
   * Commit a channel -> Session binding. Rebinding an occupied channel is
   * refused unless it is the same pair. Even a missing Session keeps its
   * original binding; opening a different Session requires a different channel.
   */
  async bindChannelSession(channelId, sessionId, {
    title = null, projectId = null, at = new Date().toISOString(),
  } = {}) {
    const channel = this.channel(channelId);
    if (!channel) {
      const error = new Error('The channel is not registered.');
      error.code = 'workbench-channel-unknown';
      throw error;
    }
    if (!cleanString(sessionId)) throw new TypeError('A Session ID is required');
    if (channel.sessionId && channel.sessionId !== sessionId) {
      const error = new Error('The channel already holds a Session binding.');
      error.code = 'workbench-session-conflict';
      error.sessionId = channel.sessionId;
      throw error;
    }
    const owner = this.session(sessionId);
    // A detached record is the restore index of a deep archive: rebinding it to
    // a freshly created channel is exactly what reopening does.
    if (owner && owner.channelId !== channelId && owner.detached !== true) {
      const error = new Error('The Session is already bound to another channel.');
      error.code = 'workbench-session-taken';
      error.channelId = owner.channelId;
      throw error;
    }
    const previous = channel.sessionId;
    channel.sessionId = sessionId;
    channel.updatedAt = at;
    channel.lastError = null;
    if (title) channel.title = safeText(title, 100) ?? channel.title;
    this.#state.sessions[sessionId] = {
      sessionId,
      channelId,
      projectId: projectId ?? channel.projectId,
      state: SESSION_STATE.ACTIVE,
      archivedAt: null,
      createdAt: at,
    };
    if (previous && previous !== sessionId) delete this.#state.sessions[previous];
    await this.persist();
    return channel;
  }

  async setChannelLifecycle(channelId, lifecycle, { at = new Date().toISOString() } = {}) {
    const channel = this.channel(channelId);
    if (!channel) return false;
    if (!Object.values(CHANNEL_LIFECYCLE).includes(lifecycle)) {
      throw new TypeError('Unknown channel lifecycle');
    }
    channel.lifecycle = lifecycle;
    channel.updatedAt = at;
    const session = channel.sessionId ? this.session(channel.sessionId) : null;
    if (session) {
      session.state = lifecycle === CHANNEL_LIFECYCLE.ACTIVE
        ? SESSION_STATE.ACTIVE : SESSION_STATE.ARCHIVED;
      session.archivedAt = lifecycle === CHANNEL_LIFECYCLE.ACTIVE ? null : at;
    }
    await this.persist();
    return true;
  }

  async noteChannelError(channelId, message, { at = new Date().toISOString() } = {}) {
    const channel = this.channel(channelId);
    if (!channel) return false;
    channel.lastError = safeText(message, 500);
    channel.updatedAt = at;
    await this.persist();
    return true;
  }

  /**
   * Remove a channel from the routing table while keeping its Session record:
   * a deep archive must preserve the restore index that lets a channel be recreated
   * for the same Session.
   */
  async detachChannel(channelId, { at = new Date().toISOString() } = {}) {
    const channel = this.channel(channelId);
    if (!channel) return false;
    if (channel.sessionId) {
      const session = this.session(channel.sessionId);
      if (session) {
        session.state = SESSION_STATE.ARCHIVED;
        session.archivedAt = at;
        session.detached = true;
        // Keep the display title so a later restore can name the new channel.
        if (channel.title) session.title = channel.title;
      }
    }
    delete this.#state.channels[channelId];
    await this.persist();
    return true;
  }

  // ---- interaction actions -------------------------------------------------

  action(actionId) { return this.#state.actions[String(actionId)] ?? null; }

  async putAction({
    actionId, kind, operatorId = null, guildId = null, channelId = null,
    sessionId = null, payload = {}, expiresAt,
  }) {
    const action = normalizeAction({
      actionId, kind, operatorId, guildId, channelId, sessionId, payload, expiresAt,
    });
    if (!action) throw new TypeError('Invalid workbench action');
    this.#state.actions[action.actionId] = action;
    const entries = Object.values(this.#state.actions);
    if (entries.length > MAX_ACTIONS) {
      entries
        .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
        .slice(0, entries.length - MAX_ACTIONS)
        .forEach((entry) => delete this.#state.actions[entry.actionId]);
    }
    await this.persist();
    return action;
  }

  /**
   * Take one action exactly once. The ledger entry is consumed synchronously so
   * two clicks arriving in the same tick cannot both win; the caller receives
   * the real state instead of a boolean so it can report it.
   */
  takeAction(actionId, {
    now = Date.now(), operatorId = null, guildId = null, channelId = null,
  } = {}) {
    const action = this.action(actionId);
    if (!action) return { ok: false, reason: 'unknown', action: null };
    if (action.consumedAt !== null) return { ok: false, reason: 'consumed', action };
    if (action.expiresAt && now > action.expiresAt) return { ok: false, reason: 'expired', action };
    if (action.operatorId && action.operatorId !== operatorId) {
      return { ok: false, reason: 'operator', action };
    }
    if (action.guildId && action.guildId !== guildId) {
      return { ok: false, reason: 'scope', action };
    }
    if (action.channelId && action.channelId !== channelId) {
      return { ok: false, reason: 'scope', action };
    }
    action.consumedAt = now;
    void this.persist().catch(() => undefined);
    return { ok: true, reason: 'ok', action };
  }

  async claimAction(actionId, context = {}) {
    const result = this.takeAction(actionId, context);
    if (result.ok) await this.persist();
    return result;
  }

  async pruneActions(now = Date.now(), { retainMs = 300_000 } = {}) {
    let removed = 0;
    for (const [id, action] of Object.entries(this.#state.actions)) {
      const stale = action.expiresAt && action.expiresAt + retainMs < now;
      const consumed = action.consumedAt !== null && action.consumedAt + retainMs < now;
      if (!stale && !consumed) continue;
      delete this.#state.actions[id];
      removed += 1;
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  // ---- multi-step operations ----------------------------------------------

  operation(operationId) { return this.#state.operations[String(operationId)] ?? null; }

  listOperations() { return Object.values(this.#state.operations); }

  async beginOperation({
    operationId, kind, state = 'pending', payload = {}, at = new Date().toISOString(),
  }) {
    const operation = normalizeOperation({ operationId, kind, state, payload, createdAt: at, updatedAt: at });
    if (!operation) throw new TypeError('Invalid workbench operation');
    this.#state.operations[operation.operationId] = operation;
    await this.persist();
    return operation;
  }

  async updateOperation(operationId, patch = {}, { at = new Date().toISOString() } = {}) {
    const operation = this.operation(operationId);
    if (!operation) return null;
    const updated = normalizeOperation({
      ...operation,
      ...patch,
      operationId,
      kind: operation.kind,
      createdAt: operation.createdAt,
      updatedAt: at,
    });
    this.#state.operations[operationId] = updated;
    await this.persist();
    return updated;
  }

  async completeOperation(operationId) {
    if (!this.operation(operationId)) return false;
    delete this.#state.operations[operationId];
    await this.persist();
    return true;
  }

  // ---- processed events ----------------------------------------------------

  hasProcessed(id) { return this.#state.processed.some((entry) => entry.id === String(id)); }

  async markProcessed(id, { at = new Date().toISOString() } = {}) {
    const value = safeText(id, 64);
    if (!value || this.hasProcessed(value)) return false;
    this.#state.processed.push({ id: value, at });
    if (this.#state.processed.length > MAX_PROCESSED_EVENTS) {
      this.#state.processed.splice(0, this.#state.processed.length - MAX_PROCESSED_EVENTS);
    }
    await this.persist();
    return true;
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.#state = emptyState();
  }

  persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
