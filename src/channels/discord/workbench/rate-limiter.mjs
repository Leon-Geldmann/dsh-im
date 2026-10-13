/**
 * Discord rate limiting built from the response headers Discord actually sends.
 *
 * Routes share the server's bucket ID within each major parameter. A bot
 * global 429 pauses bot-authenticated requests; interaction tokens use their
 * own limits so acknowledgements can proceed during that pause.
 */

import { createHash } from 'node:crypto';

const MAX_TIMER_MS = 2 ** 31 - 1;

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? found[1] : null;
}

function nonNegativeNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function secondsToMs(value) {
  const seconds = nonNegativeNumber(value);
  if (seconds === null || !Number.isSafeInteger(Math.ceil(seconds * 1_000))) return null;
  return Math.ceil(seconds * 1_000);
}

async function defaultSleep(ms, signal) {
  const deadline = Date.now() + ms;
  do {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      // Pending retries keep the process awake; long provider cooldowns are
      // chunked to avoid Node's timer overflow turning them into a 1ms wait.
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now())));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } while (Date.now() < deadline);
}

function isGlobalRateLimit(headers, body) {
  if (body?.global === true) return true;
  const scope = headerValue(headers, 'x-ratelimit-scope');
  if (typeof scope === 'string' && scope.toLowerCase() === 'global') return true;
  const global = headerValue(headers, 'x-ratelimit-global');
  return global === true || global === 'true';
}

/**
 * Collapse one concrete path into a bucket key. Discord's buckets are per
 * major parameter (channel/guild/webhook id) and per route template, so the
 * message id in an edit path must not create a new bucket per message.
 */
export function rateLimitRouteKey(method, path) {
  const segments = String(path).split('?')[0].split('/').filter(Boolean);
  const template = [];
  let major = '';
  const hasMajor = ['channels', 'guilds', 'webhooks', 'interactions'].includes(segments[0]);
  const hasToken = ['webhooks', 'interactions'].includes(segments[0]) && segments.length > 2;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === 1 && hasMajor) {
      major = segment;
      template.push('{major}');
    } else if (index === 2 && hasToken) {
      // Tokens are part of webhook identity, but must never reach logs or
      // diagnostics through a route key.
      major += `:${createHash('sha256').update(segment).digest('hex')}`;
      template.push('{token}');
    } else if (segments[index - 1] === 'reactions') {
      template.push('{emoji}');
    } else if (/^\d{5,30}$/.test(segment)) {
      template.push('{id}');
    } else {
      template.push(segment);
    }
  }
  return `${String(method).toUpperCase()} /${template.join('/')}${major ? `#${major}` : ''}`;
}

export class DiscordRateLimiter {
  #buckets = new Map();
  #sharedBuckets = new Map();
  #globalUntil = 0;
  #tokenGlobalUntil = 0;
  #now;
  #sleep;
  #logger;

  constructor({ now = () => Date.now(), sleep = null, logger = console } = {}) {
    this.#now = now;
    this.#sleep = sleep ?? defaultSleep;
    this.#logger = logger;
  }

  bucket(routeKey) {
    let bucket = this.#buckets.get(routeKey);
    if (!bucket) {
      bucket = { remaining: null, resetAt: 0, id: null, limit: null, windowMs: 0 };
      this.#buckets.set(routeKey, bucket);
    }
    return bucket;
  }

  /** Block until this route (and the global gate) may issue a request. */
  async wait(routeKey, { signal, global = true } = {}) {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.#now();
      const bucket = this.bucket(routeKey);
      this.#refresh(bucket, now);
      const globalWait = Math.max(0, (global ? this.#globalUntil : this.#tokenGlobalUntil) - now);
      const bucketWait = bucket.remaining !== null && bucket.remaining <= 0
        ? Math.max(0, bucket.resetAt - now)
        : 0;
      const delay = Math.max(globalWait, bucketWait);
      if (delay <= 0) {
        if (bucket.remaining !== null && bucket.remaining > 0) bucket.remaining -= 1;
        return;
      }
      this.#logger.debug?.(`[dsh-im:discord] rate limit wait ${delay}ms for ${routeKey}`);
      await this.#sleep(delay, signal);
    }
  }

  /** Fold one response's headers into its bucket. */
  observe(routeKey, headers) {
    const now = this.#now();
    let bucket = this.bucket(routeKey);
    this.#refresh(bucket, now);
    const remaining = nonNegativeNumber(headerValue(headers, 'x-ratelimit-remaining'));
    const resetAfter = secondsToMs(headerValue(headers, 'x-ratelimit-reset-after'));
    const limit = nonNegativeNumber(headerValue(headers, 'x-ratelimit-limit'));
    const bucketId = headerValue(headers, 'x-ratelimit-bucket');
    if (typeof bucketId === 'string' && bucketId) {
      const major = routeKey.includes('#') ? routeKey.slice(routeKey.indexOf('#') + 1) : '';
      const sharedKey = `${bucketId}#${major}`;
      const shared = this.#sharedBuckets.get(sharedKey);
      if (shared && shared !== bucket) {
        this.#refresh(shared, now);
        if (bucket.remaining !== null) {
          shared.remaining = shared.remaining === null
            ? bucket.remaining : Math.min(shared.remaining, bucket.remaining);
        }
        shared.resetAt = Math.max(shared.resetAt, bucket.resetAt);
        bucket = shared;
      } else if (!shared) {
        // A route can move to a new server bucket without moving its peers.
        if (bucket.id && bucket.id !== bucketId) bucket = { ...bucket };
        this.#sharedBuckets.set(sharedKey, bucket);
      }
      bucket.id = bucketId;
      this.#buckets.set(routeKey, bucket);
    }
    // Concurrent responses can arrive out of order. Never restore capacity or
    // shorten an outstanding cooldown from an older response in the window.
    if (remaining !== null) bucket.remaining = bucket.remaining === null
      ? remaining : Math.min(bucket.remaining, remaining);
    if (resetAfter !== null) {
      bucket.resetAt = Math.max(bucket.resetAt, now + resetAfter);
      bucket.windowMs = Math.max(bucket.windowMs, resetAfter);
    }
    if (limit !== null && limit > 0) bucket.limit = limit;
    return bucket;
  }

  #refresh(bucket, now) {
    if (bucket.resetAt > 0 && bucket.resetAt <= now) {
      bucket.remaining = bucket.limit;
      bucket.resetAt = bucket.limit !== null && bucket.windowMs > 0 ? now + bucket.windowMs : 0;
    }
  }

  /**
   * Apply a 429. The caller retries once with the platform's own delay; the
   * limiter decides how long, and whether everything waits.
   */
  async penalize(routeKey, { headers, body, signal, wait = true, global = true } = {}) {
    this.observe(routeKey, headers, { status: 429 });
    const retryAfterMs = secondsToMs(body?.retry_after)
      ?? secondsToMs(headerValue(headers, 'retry-after'))
      ?? secondsToMs(headerValue(headers, 'x-ratelimit-reset-after'))
      ?? 1_000;
    const delay = Math.max(50, retryAfterMs);
    if (isGlobalRateLimit(headers, body)) {
      if (global) this.#globalUntil = Math.max(this.#globalUntil, this.#now() + delay);
      else this.#tokenGlobalUntil = Math.max(this.#tokenGlobalUntil, this.#now() + delay);
      this.#logger.warn?.(`[dsh-im:discord] global rate limit; pausing ${delay}ms`);
    } else {
      const bucket = this.bucket(routeKey);
      bucket.remaining = 0;
      bucket.resetAt = Math.max(bucket.resetAt, this.#now() + delay);
    }
    if (wait) await this.#sleep(delay, signal);
    return delay;
  }

  snapshot() {
    return {
      globalUntil: this.#globalUntil,
      tokenGlobalUntil: this.#tokenGlobalUntil,
      buckets: [...this.#buckets.entries()].map(([route, bucket]) => ({
        route,
        remaining: bucket.remaining,
        resetAt: bucket.resetAt,
      })),
    };
  }
}
