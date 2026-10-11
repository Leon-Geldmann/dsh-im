import { resolve } from 'node:path';

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
      botId, botConfig, paths, logger, configStore, getController, workspaces, state,
    }) => {
      let workbench = null;
      try {
        workbench = normalizeWorkbenchConfig(botConfig?.workbench);
      } catch (error) {
        // An enabled-but-incomplete workbench block is reported and the bot
        // keeps its legacy Discord behavior.
        logger?.warn?.(`[${botId}] workbench configuration is unusable:`, error?.message ?? error);
        return { workbench: null };
      }
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
         * Bind or clear a channel's Session sync. The workbench channel keeps
         * its Session in workbench.json, so the delivery adapter needs the
         * conversation key binding in the channel state store as well; it is
         * written only while sync is on and removed when it is turned off.
         */
        async setSessionSync({ channelId, sessionId, enabled }) {
          const targetId = `workbench-${channelId}`;
          const conversationKey = `group:${channelId}`;
          if (!enabled) {
            await state.clearSession(conversationKey);
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
          await state.setSession(conversationKey, sessionId);
          await workspaces.setDeliveryTargetSessionSync(botId, targetId, conversationKey);
          return { enabled: true };
        },
      };
      if (!workbench?.enabled) return { workbench, workbenchAdmin };
      const store = await new DiscordWorkbenchStore(
        resolve(paths.bots, botId, 'workbench.json'),
      ).load();
      return { workbench, workbenchStore: store, workbenchAdmin };
    },
  });
}
