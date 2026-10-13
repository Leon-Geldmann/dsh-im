import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DiscordConfigStore } from '../../../../src/channels/discord/config-store.mjs';
import { DiscordController } from '../../../../src/channels/discord/discord-controller.mjs';
import { DiscordHarnessClient } from '../../../../src/channels/discord/harness-client.mjs';
import { DiscordRuntime } from '../../../../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../../../../src/channels/discord/state-store.mjs';
import {
  normalizeWorkbenchConfig,
  sanitizeWorkbenchConfig,
} from '../../../../src/channels/discord/workbench/access.mjs';
import { DiscordWorkbenchStore } from '../../../../src/channels/discord/workbench/workbench-store.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'discord',
    ConfigStore: DiscordConfigStore,
    StateStore: DiscordStateStore,
    HarnessClient: DiscordHarnessClient,
    Controller: DiscordController,
    Runtime: DiscordRuntime,
    runtimeOptionsForBot: async ({
      botId, botConfig, paths, configStore, getController, workspaces, state,
    }) => {
      const workbench = normalizeWorkbenchConfig(botConfig?.workbench);
      let store = null;
      const workbenchAdmin = {
        /**
         * Persist one workbench configuration patch. The caller decides when a
         * reconnect applies it; nothing here mutates the running runtime.
         */
        async updateWorkbenchConfig(patch) {
          const current = configStore.get(botId);
          if (!current) throw new Error('The Discord bot configuration is missing.');
          const next = sanitizeWorkbenchConfig({ ...(current.workbench ?? {}), ...patch });
          await configStore.save({ ...current, workbench: next ?? { enabled: false } });
          return next;
        },
        async reconnect() {
          await getController()?.reconnectBot?.(botId);
        },
        /**
         * Sync controls proactive delivery only. Control commands always need
         * the workbench's fixed Session in the conversation state store.
         */
        async setSessionSync({ channelId, sessionId, enabled }) {
          const targetId = `workbench-${channelId}`;
          const conversationKey = `group:${channelId}`;
          const boundSessionId = store?.channel(String(channelId))?.sessionId;
          if (!boundSessionId || boundSessionId !== sessionId) {
            const error = new Error('Session sync requires the managed channel Session binding.');
            error.code = 'workbench-session-conflict';
            throw error;
          }
          await state.setSession(conversationKey, boundSessionId);
          if (!enabled) {
            if (workspaces.deliveryTargetFor(botId, targetId)) {
              await workspaces.setDeliveryTargetSessionSync(botId, targetId, null);
            }
            return { enabled: false };
          }
          if (!workspaces.deliveryTargetFor(botId, targetId)) {
            await workspaces.createDeliveryTarget(botId, {
              targetId,
              kind: 'channel',
              route: { channelId },
              name: `工作台 ${channelId}`,
            });
          }
          await workspaces.setDeliveryTargetSessionSync(botId, targetId, conversationKey);
          return { enabled: true };
        },
      };
      if (!workbench?.enabled) return { workbench, workbenchAdmin };
      store = await new DiscordWorkbenchStore(
        resolve(paths.bots, botId, 'workbench.json'),
      ).load();
      const dshHome = await realpath(resolve(
        config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      ));
      await store.bindIdentity({ guildId: workbench.guildId, botId, instanceId: `dsh-home:${dshHome}` });
      return { workbench, workbenchStore: store, workbenchAdmin };
    },
  });
}
