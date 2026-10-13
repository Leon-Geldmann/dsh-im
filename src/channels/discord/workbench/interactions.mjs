import { parseComponentId } from './session-card.mjs';

/**
 * Native Discord interaction handling for the Guild workbench.
 *
 * Every interaction is answered within Discord's first-response deadline:
 * quick answers use an immediate reply, anything that touches the Harness is
 * deferred and later edits the original response. Components and modals carry
 * only a stored action id; the operator, Guild, channel, request and expiry are
 * checked against the workbench store before the action runs, so a replay,
 * a stale click or a click forwarded from another channel cannot execute.
 */

const EPHEMERAL = 64;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_DEFERRED = 5;

export const INTERACTION_TYPE = Object.freeze({
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
});

export const ACTION_REFUSAL_TEXT = Object.freeze({
  unknown: '这个操作已失效，请刷新会话信息卡后重试。',
  consumed: '这个操作已经执行过了。',
  expired: '这个操作已过期，请刷新会话信息卡后重试。',
  operator: '这个操作不属于你。',
  scope: '这个操作不属于当前频道。',
});

function interactionUser(interaction) {
  return String(interaction?.member?.user?.id ?? interaction?.user?.id ?? '');
}

function interactionGuild(interaction) {
  return typeof interaction?.guild_id === 'string' && interaction.guild_id
    ? interaction.guild_id : null;
}

/** Flatten a modal submit payload into field values keyed by component id. */
export function modalValues(interaction) {
  const values = {};
  for (const row of interaction?.data?.components ?? []) {
    for (const component of row?.components ?? []) {
      const id = component?.custom_id;
      if (typeof id !== 'string' || !id) continue;
      if (typeof component.value === 'string') values[id] = component.value;
      if (Array.isArray(component.values)) values[id] = component.values;
    }
  }
  return values;
}

export class DiscordInteractionHandler {
  #workbench;
  #api;
  #applicationId;
  #commands;
  #logger;
  #now;

  constructor({
    workbench, api, applicationId, commands, logger = console, now = () => Date.now(),
  }) {
    if (!workbench || !api || !applicationId || !commands) {
      throw new TypeError('DiscordInteractionHandler requires workbench, api, applicationId and commands');
    }
    this.#workbench = workbench;
    this.#api = api;
    this.#applicationId = applicationId;
    this.#commands = commands;
    this.#logger = logger;
    this.#now = now;
  }

  /** Entry point for the Gateway INTERACTION_CREATE event. */
  async handle(interaction) {
    const type = Number(interaction?.type);
    let helpers;
    try {
      if (type === INTERACTION_TYPE.PING) {
        await this.#api.createInteractionResponse({
          interactionId: interaction.id,
          interactionToken: interaction.token,
          body: { type: RESPONSE_PONG },
        });
        return;
      }
      if (![INTERACTION_TYPE.APPLICATION_COMMAND,
        INTERACTION_TYPE.MESSAGE_COMPONENT,
        INTERACTION_TYPE.MODAL_SUBMIT].includes(type)) {
        return;
      }
      helpers = this.#helpers(interaction);
      const guildId = interactionGuild(interaction);
      const operatorId = interactionUser(interaction);
      if (!guildId || guildId !== this.#workbench.guildId) {
        await helpers.respond({ content: '这个机器人只在绑定的服务器中响应。', ephemeral: true });
        return;
      }
      if (!this.#workbench.isOperator(operatorId)) {
        await helpers.respond({ content: '你没有执行该操作的权限。', ephemeral: true });
        return;
      }
      if (type === INTERACTION_TYPE.APPLICATION_COMMAND) {
        if (!await this.#workbench.store.markProcessed(`interaction:${interaction.id}`)) {
          await helpers.respond({ content: '这条命令已经接收，未重复执行。', ephemeral: true });
          return;
        }
        await this.#commands.executeApplicationCommand(interaction, helpers);
        return;
      }
      const parsed = parseComponentId(interaction?.data?.custom_id);
      if (!parsed) {
        await helpers.respond({ content: '无法识别的操作。', ephemeral: true });
        return;
      }
      const stored = this.#workbench.store.action(parsed.actionId);
      const channelId = String(interaction.channel_id ?? interaction?.message?.channel_id ?? '');
      const modalSubmit = stored?.kind === 'steer-submit';
      if (stored && (parsed.kind !== stored.kind
        || modalSubmit !== (type === INTERACTION_TYPE.MODAL_SUBMIT)
        || (type === INTERACTION_TYPE.MESSAGE_COMPONENT
          && Number(interaction.data?.component_type) !== (['model', 'reasoning'].includes(stored.kind) ? 3 : 2)))) {
        await helpers.respond({ content: ACTION_REFUSAL_TEXT.unknown, ephemeral: true });
        return;
      }
      if (!channelId || (stored?.channelId && stored.channelId !== channelId)) {
        await helpers.respond({ content: ACTION_REFUSAL_TEXT.scope, ephemeral: true });
        return;
      }
      const channel = this.#workbench.store.channel(channelId);
      if (stored && !['refresh', 'new-session'].includes(stored.kind)
        && (!channel || stored.sessionId !== channel.sessionId)) {
        await helpers.respond({ content: ACTION_REFUSAL_TEXT.unknown, ephemeral: true });
        return;
      }
      const taken = await this.#workbench.store.claimAction(parsed.actionId, {
        now: this.#now(),
        operatorId,
        guildId,
        channelId,
      });
      if (!taken.ok) {
        await helpers.respond({
          content: ACTION_REFUSAL_TEXT[taken.reason] ?? ACTION_REFUSAL_TEXT.unknown,
          ephemeral: true,
        });
        return;
      }
      if (type === INTERACTION_TYPE.MODAL_SUBMIT) {
        await this.#commands.executeAction({
          action: taken.action,
          interaction,
          helpers,
          values: modalValues(interaction),
        });
        return;
      }
      await this.#commands.executeAction({ action: taken.action, interaction, helpers });
    } catch (error) {
      this.#logger.error?.('[dsh-im:discord] interaction handling failed:', error);
      try {
        helpers ??= this.#helpers(interaction);
        const failure = { content: '操作失败，请稍后重试。', ephemeral: true };
        if (helpers.deferred) await helpers.editOriginal(failure);
        else if (helpers.responded) await helpers.followup(failure);
        else await helpers.respond(failure);
      } catch (replyError) {
        this.#logger.warn?.('[dsh-im:discord] interaction failure reply was not delivered:', replyError);
      }
    }
  }

  #helpers(interaction) {
    const base = {
      interactionId: interaction.id,
      interactionToken: interaction.token,
    };
    let responded = false;
    let deferred = false;
    const api = this.#api;
    const applicationId = typeof this.#applicationId === 'function'
      ? (this.#applicationId(interaction) ?? interaction?.application_id)
      : (interaction?.application_id ?? this.#applicationId);
    return {
      get responded() { return responded; },
      get deferred() { return deferred; },
      async respond({ content, components, embeds, ephemeral = false, flags } = {}) {
        if (responded || deferred) return false;
        responded = true;
        await api.createInteractionResponse({
          ...base,
          body: {
            type: RESPONSE_CHANNEL_MESSAGE,
            data: {
              ...(content === undefined ? {} : { content }),
              ...(components ? { components } : {}),
              ...(embeds ? { embeds } : {}),
              allowed_mentions: { parse: [], replied_user: false },
              ...(ephemeral ? { flags: flags ?? EPHEMERAL } : flags ? { flags } : {}),
            },
          },
        });
        return true;
      },
      async defer({ ephemeral = false } = {}) {
        if (responded || deferred) return false;
        deferred = true;
        await api.createInteractionResponse({
          ...base,
          body: {
            type: RESPONSE_DEFERRED,
            ...(ephemeral ? { data: { flags: EPHEMERAL } } : {}),
          },
        });
        return true;
      },
      /** Answer a component interaction with a modal (type 9). */
      async modal(payload) {
        if (responded || deferred) return false;
        responded = true;
        await api.createInteractionResponse({
          ...base,
          body: { type: 9, data: payload?.data ?? payload },
        });
        return true;
      },
      async editOriginal({ content, components, embeds } = {}) {
        return api.editInteractionResponse({
          applicationId,
          interactionToken: interaction.token,
          body: {
            ...(content === undefined ? {} : { content }),
            ...(components ? { components } : {}),
            ...(embeds ? { embeds } : {}),
            allowed_mentions: { parse: [], replied_user: false },
          },
        });
      },
      async followup({ content, components, embeds, ephemeral = false } = {}) {
        return api.createFollowupMessage({
          applicationId,
          interactionToken: interaction.token,
          body: {
            ...(content === undefined ? {} : { content }),
            ...(components ? { components } : {}),
            ...(embeds ? { embeds } : {}),
            allowed_mentions: { parse: [], replied_user: false },
            ...(ephemeral ? { flags: EPHEMERAL } : {}),
          },
        });
      },
    };
  }
}
