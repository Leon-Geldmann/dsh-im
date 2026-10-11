import { randomUUID } from 'node:crypto';

import { textFromHarnessContent } from '../../shared/harness-client.mjs';
import { runCompactCommand } from '../../shared/compact-command.mjs';
import { CHANNEL_LIFECYCLE } from './workbench-store.mjs';
import { buildSessionCard, componentId } from './session-card.mjs';
import {
  ensureProjectDirectory,
  isWorkspacePathError,
  verifyExistingDirectory,
} from './project-registry.mjs';

/**
 * Native workbench commands.
 *
 * These are the only entry points that may change project, channel and Session
 * bindings. They act on the object the operator named, never on the bot's
 * global defaults, and every message they send goes through the channel API
 * with mentions disabled.
 */

const EPHEMERAL = 64;
const ACTION_TTL_MS = 15 * 60_000;
const MAX_HISTORY_MESSAGES = 20;

export const WORKBENCH_COMMANDS = Object.freeze([
  {
    name: 'status',
    description: '查看连接、工作台与会话状态',
  },
  {
    name: 'workbench',
    description: '工作台绑定、白名单与项目根目录',
    options: [
      subcommand('status', '查看工作台状态'),
      subcommand('bind', '把这个服务器绑定为工作台'),
      subcommand('allow', '添加或移除允许操作的用户', [
        option('user', '选择用户', 'USER', { required: true }),
        choiceOption('action', '操作', ['add', 'remove'], { required: true }),
      ]),
      subcommand('root', '添加或移除项目根目录', [
        option('path', '绝对目录路径', 'STRING', { required: true }),
        choiceOption('action', '操作', ['add', 'remove'], { required: true }),
      ]),
    ],
  },
  {
    name: 'project',
    description: '管理项目与频道分组',
    options: [
      subcommand('bind', '把一个分组绑定为项目目录', [
        option('category', '选择分组', 'CHANNEL', { required: true, channelTypes: [4] }),
        option('path', '已存在的绝对目录', 'STRING', { required: true }),
        option('name', '项目显示名称', 'STRING'),
      ]),
      subcommand('new', '新建项目目录与分组', [
        option('name', '项目名称', 'STRING', { required: true }),
        option('path', '项目根目录下的绝对路径', 'STRING', { required: true }),
      ]),
      subcommand('list', '列出项目'),
      subcommand('info', '查看项目详情', [option('project', '项目 ID', 'STRING')]),
    ],
  },
  {
    name: 'session',
    description: '管理频道与会话绑定',
    options: [
      subcommand('new', '新建会话频道', [
        option('name', '频道名称', 'STRING'),
        option('project', '项目 ID（默认当前频道项目）', 'STRING'),
      ]),
      subcommand('open', '把当前频道绑定到已有会话', [
        option('session_id', 'DSH 会话 ID', 'STRING', { required: true }),
      ]),
      subcommand('info', '查看当前频道会话信息'),
      subcommand('history', '查看当前会话历史', [
        option('count', '条数 1-20', 'INTEGER', { minValue: 1, maxValue: MAX_HISTORY_MESSAGES }),
      ]),
      subcommand('archive', '归档当前会话', [
        option('deep', '深度归档（删除频道，保留会话）', 'BOOLEAN'),
      ]),
      subcommand('restore', '恢复已归档会话', [
        option('session_id', 'DSH 会话 ID', 'STRING', { required: true }),
      ]),
      subcommand('sync', '开启或关闭与 DSH 的双向同步', [
        choiceOption('action', '操作', ['on', 'off'], { required: true }),
      ]),
    ],
  },
  {
    name: 'model',
    description: '查看或切换当前会话模型',
  },
  {
    name: 'task',
    description: '控制当前会话的任务',
    options: [
      subcommand('stop', '停止当前任务'),
      subcommand('steer', '给运行中的任务补充指令', [
        option('text', '补充指令', 'STRING', { required: true }),
      ]),
      subcommand('compact', '压缩当前会话上下文'),
    ],
  },
]);

function subcommand(name, description, options = []) {
  return {
    type: 1,
    name,
    description,
    ...(options.length > 0 ? { options } : {}),
  };
}

function option(name, description, type, extra = {}) {
  return { type: optionType(type), name, description, ...extra };
}

function choiceOption(name, description, values, extra = {}) {
  return {
    type: 3,
    name,
    description,
    ...extra,
    choices: values.map((value) => ({ name: value, value })),
  };
}

function optionType(name) {
  return { STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7 }[name];
}

/** Flatten a Discord interaction payload into command/subcommand/options. */
export function parseCommandPayload(data) {
  const result = { command: data?.name ?? '', subcommand: null, options: {} };
  for (const entry of data?.options ?? []) {
    if (entry.type === 1 || entry.type === 2) {
      result.subcommand = entry.name;
      for (const child of entry.options ?? []) result.options[child.name] = child.value;
    } else {
      result.options[entry.name] = entry.value;
    }
  }
  return result;
}

function slugify(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  return slug || 'project';
}

function uniqueProjectId(store, base) {
  let candidate = base;
  let suffix = 2;
  while (store.project(candidate)) {
    candidate = `${base.slice(0, 28)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function formatWorkspaceError(error) {
  switch (error?.code) {
    case 'workbench-path-outside-roots':
      return '目录不在已配置的项目根目录内。先用 /workbench root 添加根目录。';
    case 'workbench-root-missing':
      return '配置的项目根目录当前不存在，请先创建或调整根目录。';
    case 'workbench-path-missing':
      return '目录不存在。绑定已有目录请确认路径；新建项目请用 /project new。';
    case 'workbench-path-not-directory':
      return '这个路径不是目录。';
    case 'workbench-path-invalid':
      return '请提供绝对目录路径。';
    default:
      return '目录校验失败，请检查路径与项目根目录配置。';
  }
}

function historyLine(event) {
  const text = textFromHarnessContent(event?.data?.content ?? event?.data?.message?.content);
  if (!text) return null;
  const who = event.type === 'user/message' ? '用户' : '助手';
  const flat = text.replace(/\s+/gu, ' ').trim();
  return `**${who}**：${flat.length > 180 ? `${flat.slice(0, 179)}…` : flat}`;
}

export class WorkbenchCommands {
  #workbench;
  #api;
  #harness;
  #admin;
  #queue;
  #logger;
  #now;
  #models = new Map();

  constructor({
    workbench, api, harness, admin = null, queue = null, logger = console, now = () => Date.now(),
  }) {
    if (!workbench || !api || !harness) {
      throw new TypeError('WorkbenchCommands requires workbench, api and harness');
    }
    this.#workbench = workbench;
    this.#api = api;
    this.#harness = harness;
    this.#admin = admin;
    this.#queue = queue;
    this.#logger = logger;
    this.#now = now;
  }

  get store() { return this.#workbench.store; }

  // ---- application commands ------------------------------------------------

  async executeApplicationCommand(interaction, helpers) {
    const { command, subcommand, options } = parseCommandPayload(interaction.data);
    const context = {
      interaction,
      helpers,
      options,
      operatorId: String(interaction?.member?.user?.id ?? ''),
      guildId: String(interaction.guild_id ?? ''),
      channelId: String(interaction.channel_id ?? ''),
    };
    switch (`${command}:${subcommand ?? ''}`) {
      case 'status:': return this.#status(context);
      case 'workbench:status': return this.#workbenchStatus(context);
      case 'workbench:bind': return this.#workbenchBind(context);
      case 'workbench:allow': return this.#workbenchAllow(context);
      case 'workbench:root': return this.#workbenchRoot(context);
      case 'project:bind': return this.#projectBind(context);
      case 'project:new': return this.#projectNew(context);
      case 'project:list': return this.#projectList(context);
      case 'project:info': return this.#projectInfo(context);
      case 'session:new': return this.#sessionNew(context);
      case 'session:open': return this.#sessionOpen(context);
      case 'session:info': return this.#sessionInfo(context);
      case 'session:history': return this.#sessionHistory(context);
      case 'session:archive': return this.#sessionArchive(context);
      case 'session:restore': return this.#sessionRestore(context);
      case 'session:sync': return this.#sessionSync(context);
      case 'model:': return this.#modelCard(context);
      case 'task:stop': return this.#taskStop(context);
      case 'task:steer': return this.#taskSteer(context);
      case 'task:compact': return this.#taskCompact(context);
      default:
        await helpers.respond({ content: '不支持的命令。', ephemeral: true });
    }
  }

  // ---- component / modal actions ------------------------------------------

  async executeAction({ action, interaction, helpers, values = {} }) {
    const context = {
      interaction,
      helpers,
      action,
      values,
      operatorId: String(interaction?.member?.user?.id ?? ''),
      channelId: String(interaction.channel_id ?? action.channelId ?? ''),
    };
    switch (action.kind) {
      case 'refresh': return this.#refreshCard(context);
      case 'new-session': return this.#newSessionFromCard(context);
      case 'stop': return this.#stopFromCard(context);
      case 'steer': return this.#openSteerModal(context);
      case 'steer-submit': return this.#steerFromModal(context);
      case 'archive': return this.#archiveFromCard(context);
      case 'deep-archive': return this.#deepArchiveFromCard(context);
      case 'restore': return this.#restoreFromCard(context);
      case 'model': return this.#selectModel(context);
      default:
        await helpers.respond({ content: '不支持的操作。', ephemeral: true });
    }
  }

  #requireChannel(context) {
    const channel = this.store.channel(context.channelId);
    if (!channel) {
      throw Object.assign(new Error('该频道尚未纳入工作台管理。'), { code: 'workbench-channel-unknown' });
    }
    const project = this.store.project(channel.projectId);
    return { channel, project };
  }

  async #mintCardActions(channel, project, session, { running }) {
    const mint = async (kind, payload = {}) => {
      const actionId = randomUUID();
      await this.store.putAction({
        actionId,
        kind,
        operatorId: null,
        guildId: this.#workbench.guildId,
        channelId: channel.channelId,
        sessionId: session?.sessionId ?? null,
        payload,
        expiresAt: this.#now() + ACTION_TTL_MS,
      });
      return actionId;
    };
    return {
      refresh: await mint('refresh'),
      newSession: await mint('new-session', { projectId: project?.projectId ?? null }),
      ...(running ? { stop: await mint('stop'), steer: await mint('steer') } : {}),
      ...(channel.lifecycle === CHANNEL_LIFECYCLE.ACTIVE && session
        ? { archive: await mint('archive') } : {}),
      ...(channel.lifecycle !== CHANNEL_LIFECYCLE.ACTIVE
        ? { restore: await mint('restore') } : {}),
      ...(session ? { model: await mint('model') } : {}),
    };
  }

  async renderCard(channelId, { modelOptions = null } = {}) {
    const { channel, project } = this.#requireChannel({ channelId });
    const session = channel.sessionId ? this.store.session(channel.sessionId) : null;
    const running = channel.sessionId
      ? await this.#harness.isSessionRunning(channel.sessionId).catch(() => false)
      : false;
    const actions = await this.#mintCardActions(channel, project, session, { running });
    if (actions.model) {
      actions.modelOptions = modelOptions ?? await this.#modelOptions(channel.sessionId);
    }
    return buildSessionCard({
      channel,
      project,
      session,
      model: this.#modelSelection(channel.sessionId),
      runState: { running, pending: this.#queue?.pendingFor?.(channel.sessionId) ?? 0 },
      actions,
      error: channel.lastError,
    });
  }

  #modelSelection(sessionId) {
    if (!sessionId) return null;
    return this.#models.get(sessionId) ?? null;
  }

  async #modelOptions(sessionId) {
    if (!sessionId) return [];
    try {
      const catalog = await this.#harness.getSessionModels(sessionId);
      const options = [];
      for (const provider of catalog?.providers ?? []) {
        for (const model of provider?.models ?? []) {
          options.push({
            label: `${provider.name ?? provider.provider} · ${model.name ?? model.model}`,
            value: `${provider.provider}/${model.model}`,
            description: model.description,
            selected: model.selected === true,
          });
        }
      }
      return options.slice(0, 25);
    } catch (error) {
      this.#logger.warn?.('[dsh-im:discord] session model catalog unavailable:', error);
      return [];
    }
  }

  async postCard(channelId) {
    const card = await this.renderCard(channelId);
    const message = await this.#api.createMessage({
      channelId,
      content: '',
      components: card.components,
      embeds: card.embeds,
      allowedMentions: { parse: [], replied_user: false },
    });
    return message;
  }

  // ---- status --------------------------------------------------------------

  async #status(context) {
    await context.helpers.defer({ ephemeral: true });
    const harnessOk = await this.#harness.ensureRunning()
      .then(() => true, () => false);
    const workbench = this.#workbench.status();
    const channel = this.store.channel(context.channelId);
    const session = channel?.sessionId ? this.store.session(channel.sessionId) : null;
    const lines = [
      `**Harness**：${harnessOk ? '可连接' : '无法连接'}`,
      `**工作台**：已启用（Guild ${workbench.guildId}）`,
      `**项目**：${workbench.projects} 个，频道 ${workbench.channels} 个（已绑定会话 ${workbench.boundChannels} 个）`,
      `**并发**：全局 ${workbench.maxConcurrentTasks}，同项目 ${workbench.projectConcurrency}`,
      `**当前频道**：${channel ? `项目 ${channel.projectId}，会话 ${session?.sessionId ?? '未创建'}` : '未纳入工作台'}`,
    ];
    await context.helpers.editOriginal({ content: lines.join('\n') });
  }

  async #workbenchStatus(context) {
    const status = this.#workbench.status();
    await context.helpers.respond({
      ephemeral: true,
      content: [
        `Guild：${status.guildId}`,
        `项目：${status.projects}，频道：${status.channels}，已绑定会话：${status.boundChannels}`,
        `白名单用户：${status.allowedOperators}`,
        `项目根目录：${status.projectRoots.join(', ') || '未配置'}`,
      ].join('\n'),
    });
  }

  async #workbenchBind(context) {
    if (!this.#admin?.updateWorkbenchConfig) {
      await context.helpers.respond({ content: '当前部署不支持从 Discord 修改配置。', ephemeral: true });
      return;
    }
    await context.helpers.defer({ ephemeral: true });
    const current = this.#workbench.store.guildId;
    if (current && current !== context.guildId) {
      await context.helpers.editOriginal({
        content: `该机器人已绑定另一个服务器（${current}）。如需换绑，请先清除现有绑定。`,
      });
      return;
    }
    // The store binding and the persisted configuration must agree; the store
    // is written first so a crash cannot leave a half-bound runtime.
    await this.store.bindGuild(context.guildId);
    await this.#admin.updateWorkbenchConfig({ enabled: true, guildId: context.guildId });
    await context.helpers.editOriginal({
      content: '已绑定当前服务器。正在重连以启用工作台；稍后可用 /workbench status 确认。',
    });
    await this.#admin.reconnect?.().catch?.(() => undefined);
  }

  async #workbenchAllow(context) {
    if (!this.#admin?.updateWorkbenchConfig) {
      await context.helpers.respond({ content: '当前部署不支持从 Discord 修改配置。', ephemeral: true });
      return;
    }
    const userId = String(context.options.user ?? '');
    const action = context.options.action;
    const allowed = new Set(this.#workbench.config.allowedUserIds);
    if (action === 'add') allowed.add(userId);
    else allowed.delete(userId);
    await this.#admin.updateWorkbenchConfig({ allowedUserIds: [...allowed] });
    await context.helpers.respond({
      ephemeral: true,
      content: action === 'add'
        ? `已允许 <@${userId}> 操作（重连后生效）。`
        : `已移除 <@${userId}>（重连后生效）。`,
    });
    await this.#admin.reconnect?.().catch?.(() => undefined);
  }

  async #workbenchRoot(context) {
    if (!this.#admin?.updateWorkbenchConfig) {
      await context.helpers.respond({ content: '当前部署不支持从 Discord 修改配置。', ephemeral: true });
      return;
    }
    const path = String(context.options.path ?? '').trim();
    const action = context.options.action;
    const roots = new Set(this.#workbench.config.projectRoots);
    if (action === 'add') roots.add(path);
    else roots.delete(path);
    await this.#admin.updateWorkbenchConfig({ projectRoots: [...roots] });
    await context.helpers.respond({
      ephemeral: true,
      content: `项目根目录已更新（重连后生效）：${[...roots].join(', ') || '无'}`,
    });
    await this.#admin.reconnect?.().catch?.(() => undefined);
  }

  // ---- projects ------------------------------------------------------------

  async #projectBind(context) {
    await context.helpers.defer({ ephemeral: true });
    const categoryId = String(context.options.category ?? '');
    const path = String(context.options.path ?? '');
    const name = String(context.options.name ?? '').trim() || `Project ${path.split('/').filter(Boolean).at(-1) ?? ''}`.trim();
    try {
      const category = await this.#api.getChannel({ channelId: categoryId });
      if (Number(category?.type) !== 4) throw new Error('not a category');
    } catch {
      await context.helpers.editOriginal({ content: '请选择一个服务器分组（Category）。' });
      return;
    }
    let workspacePath;
    try {
      workspacePath = await verifyExistingDirectory(path, this.#workbench.config.projectRoots);
    } catch (error) {
      await context.helpers.editOriginal({
        content: isWorkspacePathError(error) ? formatWorkspaceError(error) : '无法绑定该目录。',
      });
      return;
    }
    const projectId = uniqueProjectId(this.store, slugify(name));
    try {
      await this.store.putProject({ projectId, name, categoryId, workspacePath });
    } catch (error) {
      await context.helpers.editOriginal({
        content: error?.code === 'workbench-category-taken'
          ? '这个分组已经绑定了一个项目。' : '项目绑定失败。',
      });
      return;
    }
    await context.helpers.editOriginal({
      content: `已绑定项目 **${name}**（ID \`${projectId}\`）\n目录：\`${workspacePath}\`\n在该分组中新建文字频道即可开始使用。`,
    });
  }

  async #projectNew(context) {
    await context.helpers.defer({ ephemeral: false });
    const name = String(context.options.name ?? '').trim();
    const path = String(context.options.path ?? '').trim();
    if (!name) {
      await context.helpers.editOriginal({ content: '请提供项目名称。' });
      return;
    }
    let workspacePath;
    try {
      workspacePath = await ensureProjectDirectory(path, this.#workbench.config.projectRoots);
    } catch (error) {
      await context.helpers.editOriginal({
        content: isWorkspacePathError(error) ? formatWorkspaceError(error) : '无法创建项目目录。',
      });
      return;
    }
    let category;
    try {
      category = await this.#api.createGuildChannel({
        guildId: this.#workbench.guildId,
        name: `${name} · DSH`,
        type: 4,
      });
    } catch (error) {
      await context.helpers.editOriginal({ content: '创建分组失败，请检查机器人权限（管理频道）。' });
      this.#logger.warn?.('[dsh-im:discord] project category creation failed:', error);
      return;
    }
    const projectId = uniqueProjectId(this.store, slugify(name));
    try {
      await this.store.putProject({
        projectId, name, categoryId: String(category.id), workspacePath,
      });
    } catch (error) {
      // The Discord category exists but the mapping failed: remove the empty
      // category again rather than leaving an orphan the operator cannot see.
      await this.#api.deleteChannel({ channelId: String(category.id) }).catch(() => undefined);
      await context.helpers.editOriginal({ content: '项目登记失败，已回滚新建的分组。' });
      this.#logger.warn?.('[dsh-im:discord] project registration failed:', error);
      return;
    }
    await context.helpers.editOriginal({
      content: `已创建项目 **${name}**（ID \`${projectId}\`）\n目录：\`${workspacePath}\`\n分组：<#${category.id}>\n用 /session new 在项目里创建会话频道。`,
    });
  }

  async #projectList(context) {
    const projects = this.store.listProjects();
    await context.helpers.respond({
      ephemeral: true,
      content: projects.length === 0 ? '还没有项目。用 /project new 创建。' : projects
        .map((project) => `• **${project.name}**（\`${project.projectId}\`）\n  <#${project.categoryId}> → \`${project.workspacePath}\``)
        .join('\n'),
    });
  }

  async #projectInfo(context) {
    const requested = context.options.project
      ? this.store.project(String(context.options.project))
      : this.#workbench.describeChannel(context.channelId)?.project ?? null;
    if (!requested) {
      await context.helpers.respond({ ephemeral: true, content: '未找到项目。请提供项目 ID。' });
      return;
    }
    const channels = this.store.listChannels(requested.projectId);
    await context.helpers.respond({
      ephemeral: true,
      content: [
        `**${requested.name}**（\`${requested.projectId}\`）`,
        `分组：<#${requested.categoryId}>`,
        `目录：\`${requested.workspacePath}\``,
        `频道：${channels.length} 个（已绑定会话 ${channels.filter((item) => item.sessionId).length} 个）`,
      ].join('\n'),
    });
  }

  // ---- sessions ------------------------------------------------------------

  async #sessionNew(context) {
    await context.helpers.defer({ ephemeral: false });
    const projectId = context.options.project
      ? String(context.options.project)
      : this.store.channel(context.channelId)?.projectId;
    const project = projectId ? this.store.project(projectId) : null;
    if (!project) {
      await context.helpers.editOriginal({
        content: '当前频道不属于任何项目。请先在项目分组中操作，或用 /project new 创建项目。',
      });
      return;
    }
    const name = String(context.options.name ?? '').trim()
      || `${project.name} · ${new Date(this.#now()).toISOString().slice(5, 16).replace('T', ' ')}`;
    const operationId = randomUUID();
    await this.store.beginOperation({
      operationId,
      kind: 'create-session-channel',
      state: 'channel-creating',
      payload: { projectId: project.projectId, name },
    });
    let channel;
    try {
      channel = await this.#api.createGuildChannel({
        guildId: this.#workbench.guildId,
        name: name.slice(0, 100),
        type: 0,
        parentId: project.categoryId,
        topic: `DSH 工作台会话 · ${project.name}`,
      });
    } catch (error) {
      await this.store.completeOperation(operationId);
      await context.helpers.editOriginal({
        content: '创建频道失败。请检查机器人的“管理频道”权限与服务器频道数量上限。',
      });
      this.#logger.warn?.('[dsh-im:discord] session channel creation failed:', error);
      return;
    }
    await this.store.updateOperation(operationId, {
      state: 'channel-created',
      payload: { projectId: project.projectId, name, channelId: String(channel.id) },
    });
    await this.store.registerChannel({
      channelId: String(channel.id),
      projectId: project.projectId,
      title: name,
    });
    let sessionId;
    try {
      sessionId = await this.#harness.createSession({ workspace: project.workspacePath });
    } catch (error) {
      // Half-success: the channel exists but holds no Session. It stays
      // registered so the next message there retries Session creation instead
      // of leaving an unmanaged channel behind.
      await this.store.noteChannelError(String(channel.id), '会话创建失败，将在下次收到消息时重试。');
      await this.store.completeOperation(operationId);
      await context.helpers.editOriginal({
        content: `频道 <#${channel.id}> 已创建，但会话创建失败。请在该频道发送消息重试，或用 /status 查看连接状态。`,
      });
      this.#logger.warn?.('[dsh-im:discord] session creation failed after channel creation:', error);
      return;
    }
    await this.store.bindChannelSession(String(channel.id), sessionId, { title: name });
    await this.store.completeOperation(operationId);
    await context.helpers.editOriginal({
      content: `已创建会话频道 <#${channel.id}>\n会话：\`${sessionId}\`\n目录：\`${project.workspacePath}\``,
    });
    await this.postCard(String(channel.id)).catch((error) => {
      this.#logger.warn?.('[dsh-im:discord] session card delivery failed:', error);
    });
  }

  async #sessionOpen(context) {
    await context.helpers.defer({ ephemeral: true });
    const sessionId = String(context.options.session_id ?? '').trim();
    const { workspaceSession, sessionExists } = this.#sessionHelpers();
    try {
      await this.#workbench.router.bindExistingSession(context.channelId, sessionId, {
        workspaceSession, sessionExists,
      });
    } catch (error) {
      await context.helpers.editOriginal({
        content: error?.code === 'workbench-session-missing'
          ? '该会话不存在。请确认会话 ID 与所在工作区。'
          : error?.code === 'workbench-session-taken'
            ? '该会话已绑定到其它频道。' : '绑定失败，请稍后重试。',
      });
      return;
    }
    await context.helpers.editOriginal({ content: `已把当前频道绑定到会话 \`${sessionId}\`。` });
    await this.postCard(context.channelId).catch(() => undefined);
  }

  #sessionHelpers() {
    // workspace-session keeps its helpers private; the router accepts the same
    // shapes, so build them from the Harness client here.
    return {
      workspaceSession: (sessionId, key) => this.#harness.workspaceSession(sessionId, key),
      sessionExists: async (session, options) => (options === undefined
        ? session.sessionExists()
        : session.sessionExists(options)),
    };
  }

  async #sessionInfo(context) {
    await context.helpers.defer({ ephemeral: true });
    let card;
    try {
      card = await this.renderCard(context.channelId);
    } catch {
      await context.helpers.editOriginal({ content: '当前频道尚未纳入工作台管理。' });
      return;
    }
    await context.helpers.editOriginal({
      content: card.embeds[0].description,
      components: card.components,
    });
  }

  async #sessionHistory(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '当前频道还没有会话。' });
      return;
    }
    const count = Number.isSafeInteger(context.options.count) ? context.options.count : 5;
    try {
      const page = await this.#harness.readSessionHistory(channel.sessionId, {
        maxMessages: count,
        timeoutMs: 10_000,
      });
      const events = Array.isArray(page?.events) ? page.events.map((entry) => entry?.event) : [];
      const lines = events.map(historyLine).filter(Boolean).slice(-count);
      await context.helpers.editOriginal({
        content: lines.length > 0 ? lines.join('\n') : '暂无可显示的历史消息。',
      });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:discord] history read failed:', error);
      await context.helpers.editOriginal({ content: '读取会话历史失败，请稍后重试。' });
    }
  }

  async #sessionArchive(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel) {
      await context.helpers.editOriginal({ content: '当前频道尚未纳入工作台管理。' });
      return;
    }
    if (context.options.deep === true) {
      const actionId = randomUUID();
      await this.store.putAction({
        actionId,
        kind: 'deep-archive',
        operatorId: context.operatorId,
        guildId: context.guildId,
        channelId: channel.channelId,
        sessionId: channel.sessionId,
        expiresAt: this.#now() + ACTION_TTL_MS,
      });
      await context.helpers.editOriginal({
        content: '深度归档会删除这个 Discord 频道，但保留 DSH 会话与历史。确认后点击按钮。',
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: 4,
            label: '确认深度归档',
            custom_id: componentId('deep-archive', actionId),
          }],
        }],
      });
      return;
    }
    await this.store.setChannelLifecycle(channel.channelId, CHANNEL_LIFECYCLE.ARCHIVED);
    await context.helpers.editOriginal({
      content: '已归档当前会话频道。频道会保留，但不再接受新任务；用 /session restore 恢复。',
    });
  }

  async #sessionRestore(context) {
    await context.helpers.defer({ ephemeral: true });
    const sessionId = String(context.options.session_id ?? '').trim();
    const session = this.store.session(sessionId);
    if (!session) {
      await context.helpers.editOriginal({ content: '未找到该会话的归档记录。' });
      return;
    }
    const project = this.store.project(session.projectId);
    if (!project) {
      await context.helpers.editOriginal({ content: '会话所属项目已被移除，无法恢复频道。' });
      return;
    }
    let channel = this.store.channel(session.channelId);
    if (channel) {
      await this.store.setChannelLifecycle(channel.channelId, CHANNEL_LIFECYCLE.ACTIVE);
      await context.helpers.editOriginal({ content: `已恢复频道 <#${channel.channelId}>。` });
      await this.postCard(channel.channelId).catch(() => undefined);
      return;
    }
    const operationId = randomUUID();
    await this.store.beginOperation({
      operationId, kind: 'restore-channel', state: 'channel-creating', payload: { sessionId },
    });
    try {
      const previousTitle = this.store.channel(session.channelId)?.title;
      channel = await this.#api.createGuildChannel({
        guildId: this.#workbench.guildId,
        name: (session.title ?? previousTitle ?? `恢复会话 ${sessionId.slice(0, 8)}`).slice(0, 100),
        type: 0,
        parentId: project.categoryId,
        topic: `DSH 工作台会话 · 恢复`,
      });
    } catch (error) {
      await this.store.completeOperation(operationId);
      this.#logger.warn?.('[dsh-im:discord] restore channel creation failed:', error);
      await context.helpers.editOriginal({ content: '创建恢复频道失败，请检查频道数量上限与权限。' });
      return;
    }
    await this.store.registerChannel({
      channelId: String(channel.id),
      projectId: project.projectId,
      title: session.title ?? `恢复会话 ${sessionId.slice(0, 8)}`,
    });
    await this.store.bindChannelSession(String(channel.id), sessionId, {
      title: session.title ?? `恢复会话 ${sessionId.slice(0, 8)}`,
    });
    await this.store.setChannelLifecycle(String(channel.id), CHANNEL_LIFECYCLE.ACTIVE);
    await this.store.completeOperation(operationId);
    await context.helpers.editOriginal({
      content: `已在原项目创建频道 <#${channel.id}> 并恢复会话 \`${sessionId}\`。`,
    });
    await this.postCard(String(channel.id)).catch(() => undefined);
  }

  /**
   * Turn Session sync on or off for the current channel. Sync mirrors DSH
   * web/client activity for this fixed Session into the channel and lets an
   * approval raised by another client be answered here.
   */
  async #sessionSync(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '当前频道还没有会话，先发送一条消息或用 /session new。' });
      return;
    }
    if (!this.#admin?.setSessionSync) {
      await context.helpers.editOriginal({ content: '当前部署不支持从 Discord 修改同步设置。' });
      return;
    }
    const enabled = context.options.action === 'on';
    try {
      await this.#admin.setSessionSync({
        channelId: channel.channelId,
        sessionId: channel.sessionId,
        enabled,
      });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:discord] session sync toggle failed:', error);
      await context.helpers.editOriginal({ content: '同步设置未能保存，请稍后重试。' });
      return;
    }
    await context.helpers.editOriginal({
      content: enabled
        ? '已开启双向同步：DSH 网页/客户端在此会话产生的新消息与结果会发送到这个频道。'
        : '已关闭双向同步。',
    });
  }

  // ---- model ---------------------------------------------------------------

  async #modelCard(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '当前频道还没有会话。' });
      return;
    }
    const card = await this.renderCard(context.channelId);
    const selectRow = card.components.find((row) => row.components?.[0]?.type === 3);
    if (!selectRow) {
      await context.helpers.editOriginal({ content: '暂时无法读取模型目录。' });
      return;
    }
    await context.helpers.editOriginal({
      content: `当前会话模型：\`${this.#modelSelection(channel.sessionId)?.model ?? '跟随会话默认'}\``,
      components: [selectRow],
    });
  }

  async #selectModel(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    const rawValue = context.interaction?.data?.values?.[0];
    const [provider, model] = String(rawValue ?? '').split('/');
    if (!channel?.sessionId || !provider || !model) {
      await context.helpers.editOriginal({ content: '无法识别所选模型。' });
      return;
    }
    try {
      await this.#harness.selectSessionModel(channel.sessionId, { provider, model });
      this.#models.set(channel.sessionId, { provider, model });
      await context.helpers.editOriginal({ content: `已切换当前会话模型：\`${provider}/${model}\`` });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:discord] model switch failed:', error);
      await context.helpers.editOriginal({ content: '切换模型失败，请确认模型可用后重试。' });
    }
  }

  // ---- tasks ---------------------------------------------------------------

  async #taskStop(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '当前频道还没有会话。' });
      return;
    }
    const stopped = await this.#harness.stopActiveTurn(channel.sessionId, { owner: this })
      .catch(() => false);
    await context.helpers.editOriginal({
      content: stopped ? '已发送停止请求。' : '当前没有可停止的任务。',
    });
  }

  async #taskSteer(context) {
    const text = String(context.options.text ?? '').trim();
    if (!text) {
      await context.helpers.respond({ content: '请提供补充指令。', ephemeral: true });
      return;
    }
    await context.helpers.defer({ ephemeral: true });
    await this.#applySteer(context, text);
  }

  async #applySteer(context, text) {
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '当前频道还没有会话。' });
      return;
    }
    const applied = await this.#harness.steerActiveTurn(channel.sessionId, text, { owner: this })
      .catch(() => false);
    await context.helpers.editOriginal({
      content: applied ? '补充指令已提交给运行中的任务。' : '当前没有可补充指令的运行中任务。',
    });
  }

  async #taskCompact(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '当前频道还没有会话。' });
      return;
    }
    const adapter = { sessionFor: () => channel.sessionId };
    const result = await runCompactCommand('/compact', this.#harness, adapter, `group:${channel.channelId}`);
    await context.helpers.editOriginal({ content: result?.message ?? '上下文压缩已提交。' });
  }

  // ---- card actions --------------------------------------------------------

  async #refreshCard(context) {
    await context.helpers.defer({ ephemeral: true });
    const card = await this.renderCard(context.channelId);
    await context.helpers.editOriginal({
      content: card.embeds[0].description,
      components: card.components,
    });
  }

  async #newSessionFromCard(context) {
    const channel = this.store.channel(context.channelId);
    await this.#sessionNew({
      ...context,
      options: { project: channel?.projectId, name: undefined },
    });
  }

  async #stopFromCard(context) {
    await context.helpers.defer({ ephemeral: true });
    const sessionId = context.action?.sessionId;
    const stopped = sessionId
      ? await this.#harness.stopActiveTurn(sessionId, { owner: this }).catch(() => false)
      : false;
    await context.helpers.editOriginal({ content: stopped ? '已停止。' : '当前没有可停止的任务。' });
  }

  async #steerFromModal(context) {
    const text = String(context.values?.steer_text ?? '').trim();
    if (!text) {
      await context.helpers.respond({ content: '没有收到补充指令。', ephemeral: true });
      return;
    }
    await context.helpers.defer({ ephemeral: true });
    await this.#applySteer(context, text);
  }

  /**
   * Open the steering modal. The card button's action is consumed by the
   * click; the modal carries a fresh action so its submit is checked on its
   * own (operator, channel, expiry) instead of reusing a spent id.
   */
  async #openSteerModal(context) {
    const actionId = randomUUID();
    await this.store.putAction({
      actionId,
      kind: 'steer-submit',
      operatorId: context.operatorId,
      guildId: this.#workbench.guildId,
      channelId: context.channelId,
      sessionId: context.action?.sessionId ?? null,
      expiresAt: this.#now() + ACTION_TTL_MS,
    });
    await context.helpers.modal(steerModal(actionId));
  }

  async #archiveFromCard(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel) {
      await context.helpers.editOriginal({ content: '频道不在工作台管理中。' });
      return;
    }
    await this.store.setChannelLifecycle(channel.channelId, CHANNEL_LIFECYCLE.ARCHIVED);
    await this.#refreshCard({ ...context, helpers: context.helpers });
  }

  async #deepArchiveFromCard(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel) {
      await context.helpers.editOriginal({ content: '频道不在工作台管理中。' });
      return;
    }
    await this.store.setChannelLifecycle(channel.channelId, CHANNEL_LIFECYCLE.DEEP_ARCHIVED);
    try {
      await this.#api.deleteChannel({ channelId: channel.channelId });
    } catch (error) {
      this.#logger.warn?.('[dsh-im:discord] deep archive could not delete the channel:', error);
      await this.store.noteChannelError(channel.channelId, '深度归档：频道删除失败，将重试。');
    }
    await this.store.detachChannel(channel.channelId);
    await context.helpers.editOriginal({
      content: `已深度归档。会话 \`${channel.sessionId ?? '（无）'}\` 已保留，可用 /session restore 恢复。`,
    });
  }

  async #restoreFromCard(context) {
    await context.helpers.defer({ ephemeral: true });
    const channel = this.store.channel(context.channelId);
    if (!channel?.sessionId) {
      await context.helpers.editOriginal({ content: '频道没有可恢复的会话。' });
      return;
    }
    await this.#sessionRestore({ ...context, options: { session_id: channel.sessionId } });
  }
}

/** Modal payload for collecting a steering instruction. */
export function steerModal(actionId) {
  return {
    type: 9,
    data: {
      title: '补充指令',
      custom_id: componentId('steer', actionId),
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: 'steer_text',
          label: '补充给当前任务的指令',
          style: 2,
          max_length: 1_800,
          required: true,
        }],
      }],
    },
  };
}

export { slugify, formatWorkspaceError };
