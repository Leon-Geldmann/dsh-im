import { createHash } from 'node:crypto';
import { t } from '../shared/i18n.mjs';
import { fetchFileStream } from '../shared/file-download.mjs';
import { DiscordRateLimiter, rateLimitRouteKey } from './workbench/rate-limiter.mjs';

const DEFAULT_BASE_URL = 'https://discord.com/api/v10/';
const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;
const DISCORD_PERMISSION_ERRORS = new Set([50001, 50013]);
const DISCORD_TOO_LARGE_ERRORS = new Set([40005]);

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requestSignal(signal, timeoutMs) {
  // A referenced timer, not AbortSignal.timeout: an in-flight request that is
  // waiting on its timeout must keep the process awake. An unref'd timer lets
  // the event loop drain first, and the fetch would then never settle. The
  // caller must dispose() it once the request settles so the referenced timer
  // does not outlive the operation.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function positiveTimeout(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function preserveProviderMetadata(target, source) {
  if (source?.providerCode !== undefined) target.providerCode = source.providerCode;
  if (source?.retry_after !== undefined) {
    target.retry_after = source.retry_after;
    target.retryAfter = source.retry_after;
  }
  if (Number.isInteger(source?.status)) target.status = source.status;
  return target;
}

function discordArtifactProviderError(cause) {
  const providerCode = Number(cause?.providerCode);
  const status = Number(cause?.status);
  const message = cleanString(cause?.message) ?? '';
  let code = 'artifact-provider-rejected';
  let summary = 'Discord rejected the attachment.';
  if (status === 401 || status === 403 || DISCORD_PERMISSION_ERRORS.has(providerCode)) {
    code = 'artifact-permission-required';
    summary = 'Discord denied permission to send the attachment.';
  } else if (status === 413 || DISCORD_TOO_LARGE_ERRORS.has(providerCode)
    || /(?:request|attachment|file).{0,24}too large/i.test(message)) {
    code = 'artifact-too-large';
    summary = 'The attachment exceeds Discord\'s size limit.';
  } else if (status === 429) {
    code = 'artifact-rate-limited';
    summary = 'Discord rate-limited attachment delivery.';
  } else if (status >= 500) {
    code = 'artifact-delivery-uncertain';
    summary = 'Discord attachment delivery result is uncertain.';
  }
  const error = new Error(summary, { cause });
  error.code = code;
  return preserveProviderMetadata(error, cause);
}

function uncertainDiscordDelivery(cause) {
  const error = new Error('Discord attachment delivery result is uncertain', { cause });
  error.code = 'artifact-delivery-uncertain';
  return preserveProviderMetadata(error, cause);
}

function safeMentions(value) {
  return { parse: [], replied_user: false, ...value };
}

function messageBody(body) {
  return { ...body, allowed_mentions: safeMentions(body?.allowed_mentions) };
}

function snowflake(value, name) {
  const id = cleanString(value);
  if (!id || !/^\d{5,30}$/.test(id)) throw new TypeError(`Invalid Discord ${name}`);
  return id;
}

function reactionEmoji(value) {
  const emoji = cleanString(value);
  if (!emoji) throw new TypeError('A Discord reaction emoji is required');
  return emoji;
}

export function validDiscordToken(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

export class DiscordApi {
  #token;
  #fetch;
  #baseUrl;
  #fileUploadTimeoutMs;
  #rateLimiter;

  constructor({
    token,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    fileUploadTimeoutMs = DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
    rateLimiter = null,
  }) {
    if (!validDiscordToken(token)) throw new TypeError('Discord Bot Token is invalid');
    if (typeof fetchImpl !== 'function') throw new TypeError('DiscordApi requires fetch');
    this.#token = token.trim();
    this.#fetch = fetchImpl;
    this.#baseUrl = new URL(baseUrl);
    this.#fileUploadTimeoutMs = positiveTimeout(fileUploadTimeoutMs, 'fileUploadTimeoutMs');
    this.#rateLimiter = rateLimiter ?? new DiscordRateLimiter();
  }

  get rateLimiter() { return this.#rateLimiter; }

  getCurrentUser(options = {}) {
    return this.#request('users/@me', { ...options, method: 'GET' });
  }

  getCurrentApplication(options = {}) {
    return this.#request('applications/@me', { ...options, method: 'GET' });
  }

  getGatewayBot(options = {}) {
    return this.#request('gateway/bot', { ...options, method: 'GET' });
  }

  getChannel({ channelId, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, {
      method: 'GET',
      signal,
    });
  }

  listChannelMessages({ channelId, limit = 100, before, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid message limit');
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', snowflake(before, 'message id'));
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages?${query}`, {
      method: 'GET', signal,
    });
  }

  downloadAttachment({ url, signal } = {}) {
    return fetchFileStream(url, {
      fetchImpl: this.#fetch, signal,
      allowedHosts: ['cdn.discordapp.com', 'media.discordapp.net'],
    });
  }

  getMessage({ channelId, messageId, signal } = {}) {
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`,
      { method: 'GET', signal },
    );
  }

  startThreadFromMessage({ channelId, messageId, name, signal } = {}) {
    const threadName = cleanString(name);
    if (!threadName || [...threadName].length > 100) {
      throw new TypeError('Discord thread name must contain 1-100 characters');
    }
    if (signal?.aborted) throw abortReason(signal);
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}/threads`,
      {
        method: 'POST',
        signal,
        body: { name: threadName },
      },
    );
  }

  createMessage({
    channelId, content, replyToMessageId, signal,
    components, embeds, flags, allowedMentions, nonce,
  }) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/messages`, {
      method: 'POST',
      signal,
      body: {
        content,
        allowed_mentions: safeMentions(allowedMentions),
        ...(components ? { components } : {}),
        ...(embeds ? { embeds } : {}),
        ...(Number.isInteger(flags) ? { flags } : {}),
        ...(nonce ? { nonce, enforce_nonce: true } : {}),
        ...(replyToMessageId ? {
          message_reference: {
            message_id: snowflake(replyToMessageId, 'message id'),
            channel_id: snowflake(channelId, 'channel id'),
            fail_if_not_exists: false,
          },
        } : {}),
      },
    });
  }

  async createFileMessage({ channelId, file, replyToMessageId, signal }) {
    if (!file || typeof file !== 'object'
      || typeof file.fileName !== 'string' || !file.fileName
      || !Buffer.isBuffer(file.bytes)) {
      throw new TypeError('A Discord attachment is required');
    }
    const targetChannelId = snowflake(channelId, 'channel id');
    const deliverySeed = cleanString(file.deliveryKey) ?? cleanString(file.artifactId);
    const nonce = deliverySeed
      ? createHash('sha256').update(JSON.stringify([targetChannelId, deliverySeed])).digest('hex').slice(0, 25)
      : undefined;
    const payload = new FormData();
    payload.append('payload_json', JSON.stringify({
      allowed_mentions: { parse: [], replied_user: false },
      attachments: [{ id: 0, filename: file.fileName }],
      ...(nonce ? { nonce, enforce_nonce: true } : {}),
      ...(replyToMessageId ? {
        message_reference: {
          message_id: snowflake(replyToMessageId, 'message id'),
          channel_id: snowflake(channelId, 'channel id'),
          fail_if_not_exists: false,
        },
      } : {}),
    }));
    payload.append(
      'files[0]',
      new Blob([file.bytes], { type: file.mediaType ?? 'application/octet-stream' }),
      file.fileName,
    );
    if (signal?.aborted) throw abortReason(signal);
    const upload = requestSignal(signal, this.#fileUploadTimeoutMs);
    try {
      return await this.#request(`channels/${targetChannelId}/messages`, {
        method: 'POST',
        signal: upload.signal,
        timeoutMs: this.#fileUploadTimeoutMs,
        body: payload,
        multipart: true,
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error?.code?.startsWith?.('discord-')) {
        throw discordArtifactProviderError(error);
      }
      throw uncertainDiscordDelivery(error);
    } finally {
      upload.dispose();
    }
  }

  editMessage({
    channelId, messageId, content, signal, components, embeds, allowedMentions,
  }) {
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`,
      {
        method: 'PATCH',
        signal,
        body: {
          content,
          allowed_mentions: safeMentions(allowedMentions),
          ...(components ? { components } : {}),
          ...(embeds ? { embeds } : {}),
        },
      },
    );
  }

  sendTyping({ channelId, signal }) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}/typing`, {
      method: 'POST',
      signal,
      expectBody: false,
    });
  }

  async addOwnReaction({ channelId, messageId, emoji, signal } = {}) {
    const normalizedEmoji = reactionEmoji(emoji);
    await this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`
        + `/reactions/${encodeURIComponent(normalizedEmoji)}/@me`,
      {
        method: 'PUT',
        signal,
        expectBody: false,
        retry: false,
      },
    );
    return normalizedEmoji;
  }

  removeOwnReaction({ channelId, messageId, emoji, signal } = {}) {
    const normalizedEmoji = reactionEmoji(emoji);
    return this.#request(
      `channels/${snowflake(channelId, 'channel id')}/messages/${snowflake(messageId, 'message id')}`
        + `/reactions/${encodeURIComponent(normalizedEmoji)}/@me`,
      {
        method: 'DELETE',
        signal,
        expectBody: false,
        retry: false,
      },
    );
  }

  // ---- Guild workbench surface --------------------------------------------

  getGuild({ guildId, signal } = {}) {
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}`, { method: 'GET', signal });
  }

  listGuildChannels({ guildId, signal } = {}) {
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/channels`, {
      method: 'GET',
      signal,
    });
  }

  createGuildChannel({
    guildId, name, type = 0, parentId, topic, position, signal,
  } = {}) {
    const channelName = cleanString(name);
    if (!channelName || [...channelName].length > 100) {
      throw new TypeError('Discord channel name must contain 1-100 characters');
    }
    if (![0, 4, 5].includes(Number(type))) {
      throw new TypeError('Discord channel type is not supported here');
    }
    return this.#request(`guilds/${snowflake(guildId, 'guild id')}/channels`, {
      method: 'POST',
      signal,
      body: {
        name: channelName,
        type: Number(type),
        ...(parentId ? { parent_id: snowflake(parentId, 'category id') } : {}),
        ...(typeof topic === 'string' ? { topic: topic.slice(0, 1024) } : {}),
        ...(Number.isInteger(position) ? { position } : {}),
      },
    });
  }

  modifyChannel({ channelId, name, parentId, topic, position, signal, nsfw } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, {
      method: 'PATCH',
      signal,
      body: {
        ...(name === undefined ? {} : { name }),
        ...(parentId === undefined
          ? {}
          : { parent_id: parentId === null ? null : snowflake(parentId, 'category id') }),
        ...(topic === undefined
          ? {}
          : { topic: topic === null ? null : String(topic).slice(0, 1024) }),
        ...(position === undefined ? {} : { position }),
        ...(nsfw === undefined ? {} : { nsfw }),
      },
    });
  }

  deleteChannel({ channelId, signal } = {}) {
    return this.#request(`channels/${snowflake(channelId, 'channel id')}`, {
      method: 'DELETE',
      signal,
    });
  }

  /**
   * Replace this application's command set for one Guild. Guild-scoped
   * commands propagate immediately, which matters for a personal install.
   */
  bulkOverwriteGuildCommands({ applicationId, guildId, commands, signal } = {}) {
    if (!Array.isArray(commands)) throw new TypeError('Discord commands must be an array');
    return this.#request(
      `applications/${snowflake(applicationId, 'application id')}`
        + `/guilds/${snowflake(guildId, 'guild id')}/commands`,
      { method: 'PUT', signal, body: commands },
    );
  }

  createInteractionResponse({
    interactionId, interactionToken, body, signal, withResponse = false,
  } = {}) {
    const token = cleanString(interactionToken);
    if (!token) throw new TypeError('An interaction token is required');
    const query = withResponse ? '?with_response=true' : '';
    return this.#request(
      `interactions/${snowflake(interactionId, 'interaction id')}/${token}/callback${query}`,
      {
        method: 'POST', signal, retry: false,
        body: [4, 7].includes(body?.type) ? { ...body, data: messageBody(body.data) } : body,
      },
    );
  }

  /** Replace the message created by a deferred interaction response. */
  editInteractionResponse({ applicationId, interactionToken, body, signal } = {}) {
    const token = cleanString(interactionToken);
    if (!token) throw new TypeError('An interaction token is required');
    return this.#request(
      `webhooks/${snowflake(applicationId, 'application id')}/${token}/messages/@original`,
      { method: 'PATCH', signal, body: messageBody(body) },
    );
  }

  createFollowupMessage({
    applicationId, interactionToken, body, signal, wait = false,
  } = {}) {
    const token = cleanString(interactionToken);
    if (!token) throw new TypeError('An interaction token is required');
    return this.#request(
      `webhooks/${snowflake(applicationId, 'application id')}/${token}${wait ? '?wait=true' : ''}`,
      { method: 'POST', signal, body: messageBody(body) },
    );
  }

  async #request(path, {
    method,
    body,
    signal,
    timeoutMs = 15_000,
    expectBody = true,
    retry = true,
    multipart = false,
  }) {
    const routeKey = rateLimitRouteKey(method, path);
    // Token-authenticated interaction endpoints have their own limits. Bot
    // global cooldowns must not consume the three-second acknowledgement window.
    const tokenAuthenticated = /^(?:interactions|webhooks)\//.test(path);
    signal?.throwIfAborted();
    await this.#rateLimiter.wait(routeKey, { signal, global: !tokenAuthenticated });
    signal?.throwIfAborted();
    const timeout = requestSignal(signal, timeoutMs);
    let response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers: {
          ...(tokenAuthenticated ? {} : { authorization: `Bot ${this.#token}` }),
          ...(multipart ? {} : { 'content-type': 'application/json' }),
          'user-agent': 'DeepSeek-Harness-dsh-im (https://github.com/xmanrui/dsh-im, 1.1.0)',
        },
        ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
        signal: timeout.signal,
        redirect: 'error',
      });
    } catch (error) {
      timeout.dispose();
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      throw new Error(`Discord ${method} transport failed`, { cause: error });
    }

    this.#rateLimiter.observe(routeKey, response.headers, { status: response.status });
    let parsed = null;
    try {
      if (response.status !== 204 && (expectBody || !response.ok)) {
        try {
          parsed = await response.json();
        } catch (cause) {
          if (expectBody && response.ok) {
            const error = new Error(`Discord ${method} returned invalid JSON`, { cause });
            error.status = response?.status;
            throw error;
          }
        }
      }
    } finally {
      timeout.dispose();
    }
    if (response.status === 429) {
      // Schedule from the platform's own bucket state instead of a fixed
      // backoff; the limiter also pauses every bucket on a global limit.
      await this.#rateLimiter.penalize(routeKey, {
        headers: response.headers,
        body: parsed,
        signal,
        wait: retry,
        global: !tokenAuthenticated,
      });
      if (retry) {
        return this.#request(path, {
          method, body, signal, timeoutMs, expectBody, retry: false, multipart,
        });
      }
    }
    if (!response.ok) {
      const error = new Error(cleanString(parsed?.message) ?? `Discord API failed with HTTP ${response.status}`);
      error.code = `discord-${response.status}`;
      error.status = response.status;
      if (Number.isInteger(parsed?.code) || typeof parsed?.code === 'string') {
        error.providerCode = parsed.code;
      }
      const retryAfter = Number(parsed?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        error.retry_after = retryAfter;
        error.retryAfter = retryAfter;
      }
      throw error;
    }
    return expectBody ? parsed : null;
  }
}

export async function inspectDiscordToken(token, options = {}) {
  const api = new DiscordApi({ token, ...options });
  const bot = await api.getCurrentUser();
  if (!bot?.id || bot?.bot !== true) throw new Error('Discord token does not belong to a bot');
  return {
    platformId: String(bot.id),
    name: cleanString(bot.global_name) ?? cleanString(bot.username) ?? t('Discord机器人'),
    username: cleanString(bot.username),
  };
}

/** Owner lookup is optional metadata, bounded separately from Gateway startup. */
export async function inspectDiscordOwner(token, {
  platformId,
  timeoutMs = 5_000,
  signal,
  ...options
} = {}) {
  const api = new DiscordApi({ token, ...options });
  const lookup = requestSignal(signal, positiveTimeout(timeoutMs, 'owner lookup timeout'));
  const request = { signal: lookup.signal, retry: false };
  let application;
  let bot;
  try {
    application = await api.getCurrentApplication(request);
    bot = application?.bot ?? await api.getCurrentUser(request);
  } finally {
    lookup.dispose();
  }
  if ((!application?.bot && bot?.bot !== true) || bot?.bot === false
    || snowflake(bot?.id, 'bot id') !== platformId) {
    throw new Error('Discord application does not belong to the configured bot');
  }
  // A team application belongs to its team owner, not every developer or the
  // synthetic application owner that Discord can return for team applications.
  const ownerUserId = snowflake(application?.team != null
    ? application.team.owner_user_id
    : application?.owner?.id, 'owner id');
  if (ownerUserId === platformId || (application?.owner?.bot === true && application?.team == null)) {
    throw new Error('Discord application owner is not a human identity');
  }
  lookup.signal.throwIfAborted();
  return ownerUserId;
}
