import { isAbsolute, resolve } from 'node:path';

/**
 * Guild-workbench configuration and operator admission.
 *
 * The workbench is an explicit opt-in layer on top of the existing Discord
 * channel: one bot, one Guild, and an operator allowlist that is checked before
 * any attachment download, Session creation, or Harness call. Seeing a channel
 * is never treated as permission to run a DSH task.
 */

const MAX_ALLOWED_USERS = 100;
const MAX_PROJECT_ROOTS = 20;
const MAX_CONCURRENCY = 8;

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{5,30}$/.test(value);
}

function cleanPath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\x00-\x1f\x7f]/.test(text)) return null;
  if (!isAbsolute(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  return resolve(text);
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONCURRENCY
    ? value : fallback;
}

/**
 * Validate the persisted `workbench` block of one bot configuration.
 * Returns null when the block is absent or unusable, so a damaged value can
 * never half-enable the feature.
 */
export function normalizeWorkbenchConfig(value) {
  const sanitized = sanitizeWorkbenchConfig(value);
  if (!sanitized) return null;
  if (sanitized.enabled && !sanitized.guildId) {
    const error = new Error('Discord workbench is enabled without a Guild binding.');
    error.code = 'workbench-config-incomplete';
    throw error;
  }
  return sanitized;
}

/**
 * Lenient form used while persisting configuration: unknown and invalid
 * values are dropped, but an enabled block without a binding is kept so the
 * runtime can report the exact problem instead of silently disabling itself.
 */
export function sanitizeWorkbenchConfig(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const enabled = value.enabled === true;
  const guildId = isSnowflake(value.guildId) ? value.guildId : null;
  const allowedUserIds = Array.isArray(value.allowedUserIds)
    ? [...new Set(value.allowedUserIds.filter(isSnowflake))].slice(0, MAX_ALLOWED_USERS)
    : [];
  const projectRoots = Array.isArray(value.projectRoots)
    ? [...new Set(value.projectRoots.map(cleanPath).filter(Boolean))].slice(0, MAX_PROJECT_ROOTS)
    : [];
  return {
    enabled,
    guildId,
    allowedUserIds,
    projectRoots,
    maxConcurrentTasks: positiveLimit(value.maxConcurrentTasks, 1),
    projectConcurrency: positiveLimit(value.projectConcurrency, 1),
  };
}

/**
 * Operator admission for one Guild message or interaction.
 *
 * `ownerUserId` is the Discord application owner recorded by the channel
 * controller. An explicit allowlist entry is the only other way in.
 */
export function isWorkbenchOperator(config, senderId, { ownerUserId = null } = {}) {
  if (!config?.enabled || !isSnowflake(senderId)) return false;
  if (ownerUserId && senderId === ownerUserId) return true;
  return config.allowedUserIds.includes(senderId);
}

/**
 * Decide whether one inbound guild message belongs to workbench routing.
 * The caller keeps legacy behavior for everything this refuses.
 */
export function classifyWorkbenchMessage(config, message, { ownerUserId = null } = {}) {
  if (!config?.enabled) return { managed: false, reason: 'disabled' };
  const guildId = typeof message?.guild_id === 'string' ? message.guild_id : null;
  if (!guildId || guildId !== config.guildId) return { managed: false, reason: 'guild' };
  if (message?.author?.bot === true) return { managed: false, reason: 'bot' };
  const senderId = String(message?.author?.id ?? '');
  if (!isWorkbenchOperator(config, senderId, { ownerUserId })) {
    return { managed: false, reason: 'not-operator' };
  }
  return { managed: true, guildId, senderId };
}
