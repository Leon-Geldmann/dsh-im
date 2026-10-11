/**
 * The channel session card: one durable message per managed channel that shows
 * the project, working directory, Session, model and run state, and carries the
 * operator entry points.
 *
 * Every component carries an action id minted in the workbench store, so a
 * click is checked against its operator, Guild, channel, request and expiry
 * before anything runs.
 */

export const WORKBENCH_COMPONENT_PREFIX = 'wb';

const COLOR_RUNNING = 0xF0B232;
const COLOR_IDLE = 0x57F287;
const COLOR_PROBLEM = 0xED4245;

function truncate(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function componentId(kind, actionId) {
  return `${WORKBENCH_COMPONENT_PREFIX}:${kind}:${actionId}`;
}

export function parseComponentId(customId) {
  if (typeof customId !== 'string') return null;
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== WORKBENCH_COMPONENT_PREFIX) return null;
  const [, kind, actionId] = parts;
  if (!kind || !actionId) return null;
  return { kind, actionId };
}

/**
 * Render one session card.
 *
 * @param {object} input
 * @param {object} input.channel Workbench channel record.
 * @param {object} input.project Project record.
 * @param {object|null} input.session Session record (null before the first task).
 * @param {{provider?: string, model?: string, reasoningEffort?: string}|null} input.model
 * @param {{running?: boolean, pending?: number}|null} input.runState
 * @param {object} input.actions Action ids for the components.
 * @param {string|null} input.error Last recorded routing error.
 */
export function buildSessionCard({
  channel, project, session = null, model = null, runState = null,
  actions = {}, error = null, now = new Date().toISOString(),
}) {
  const running = runState?.running === true;
  const queued = Number.isSafeInteger(runState?.pending) ? runState.pending : 0;
  const lifecycle = channel?.lifecycle ?? 'active';
  const color = error ? COLOR_PROBLEM : (running ? COLOR_RUNNING : COLOR_IDLE);
  const stateLine = error
    ? `⚠️ ${truncate(error, 300)}`
    : running ? '🟡 运行中' : '🟢 空闲';
  const lines = [
    `**项目**：${project?.name ?? '未绑定'}`,
    `**工作目录**：\`${project?.workspacePath ?? '未配置'}\``,
    `**会话**：${session?.sessionId ? `\`${truncate(session.sessionId, 60)}\`` : '尚未创建（发送第一条消息时创建）'}`,
    `**模型**：${model ? `${model.provider}/${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}` : '跟随会话'}`,
    `**状态**：${stateLine}${queued > 0 ? `（排队 ${queued}）` : ''}`,
  ];
  if (lifecycle !== 'active') lines.push(`**生命周期**：${lifecycle}`);

  const buttons = [];
  if (actions.refresh) {
    buttons.push(button('刷新', 'refresh', actions.refresh, 'Secondary'));
  }
  if (actions.newSession) {
    buttons.push(button('新会话', 'new-session', actions.newSession, 'Primary'));
  }
  if (actions.stop && running) {
    buttons.push(button('停止', 'stop', actions.stop, 'Danger'));
  }
  if (actions.steer && running) {
    buttons.push(button('补充指令', 'steer', actions.steer, 'Secondary'));
  }
  if (actions.archive && lifecycle === 'active' && session) {
    buttons.push(button('归档', 'archive', actions.archive, 'Secondary'));
  }
  if (actions.restore && lifecycle !== 'active') {
    buttons.push(button('恢复', 'restore', actions.restore, 'Success'));
  }

  const components = [];
  if (buttons.length > 0) components.push({ type: 1, components: buttons });
  if (actions.model && Array.isArray(actions.modelOptions) && actions.modelOptions.length > 0) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: componentId('model', actions.model),
        placeholder: '切换当前会话模型',
        min_values: 1,
        max_values: 1,
        options: actions.modelOptions.slice(0, 25).map((option) => ({
          label: truncate(option.label, 100),
          value: truncate(option.value, 100),
          ...(option.description ? { description: truncate(option.description, 100) } : {}),
          ...(option.selected ? { default: true } : {}),
        })),
      }],
    });
  }

  return {
    embeds: [{
      title: truncate(`会话频道 · ${project?.name ?? '未绑定项目'}`, 250),
      description: lines.join('\n'),
      color,
      footer: { text: `DSH 工作台 · ${channel?.channelId ?? ''}` },
      timestamp: now,
    }],
    components,
    allowed_mentions: { parse: [], replied_user: false },
  };
}

function button(label, kind, actionId, style) {
  return {
    type: 2,
    style: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }[style] ?? 2,
    label,
    custom_id: componentId(kind, actionId),
  };
}

/** Plain-text fallback used when the card cannot be rendered as components. */
export function sessionCardText(card) {
  const embed = card?.embeds?.[0];
  if (!embed) return '会话状态不可用。';
  return `${embed.title}\n${String(embed.description ?? '').replace(/\*\*/gu, '')}`;
}
