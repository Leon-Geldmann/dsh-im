/**
 * Discord rate limiting built from the response headers Discord actually sends.
 *
 * Each route (method + path template + major parameter) keeps its own bucket.
 * Requests wait for their own bucket only, and a global 429 pauses every
 * bucket, so heavy progress edits on one message cannot delay a stop request on
 * another route.
 */

const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_INTERVAL_MS = 250;

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? found[1] : null;
}

function secondsToMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(seconds * 1_000)));
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
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === 1 && ['channels', 'guilds', 'webhooks'].includes(segments[0])) major = segment;
    if (/^\d{5,30}$/.test(segment)) {
      template.push(segment === major ? '{major}' : '{id}');
    } else {
      template.push(segment);
    }
  }
  return `${String(method).toUpperCase()} /${template.join('/')}${major ? `#${major}` : ''}`;
}

export class DiscordRateLimiter {
  #buckets = new Map();
  #globalUntil = 0;
  #now;
  #sleep;
  #logger;

  constructor({ now = () => Date.now(), sleep = null, logger = console } = {}) {
    this.#now = now;
    this.#sleep = sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      // Deliberately not unref'd: a scheduled retry is real pending work, and
      // an unref'd timer lets the process (or a test runner) exit while the
      // request is still waiting for its bucket.
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    this.#logger = logger;
  }

  bucket(routeKey) {
    let bucket = this.#buckets.get(routeKey);
    if (!bucket) {
      bucket = { remaining: null, resetAt: 0, id: null };
      this.#buckets.set(routeKey, bucket);
    }
    return bucket;
  }

  /** Block until this route (and the global gate) may issue a request. */
  async wait(routeKey, { signal } = {}) {
    for (;;) {
      const now = this.#now();
      const bucket = this.bucket(routeKey);
      const globalWait = Math.max(0, this.#globalUntil - now);
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
  observe(routeKey, headers, { status = 200 } = {}) {
    const bucket = this.bucket(routeKey);
    const remaining = Number(headerValue(headers, 'x-ratelimit-remaining'));
    const resetAfter = secondsToMs(headerValue(headers, 'x-ratelimit-reset-after'));
    const bucketId = headerValue(headers, 'x-ratelimit-bucket');
    if (typeof bucketId === 'string' && bucketId) bucket.id = bucketId;
    if (Number.isFinite(remaining)) bucket.remaining = Math.max(0, remaining);
    if (resetAfter !== null) bucket.resetAt = this.#now() + resetAfter;
    if (Number.isFinite(remaining) && remaining > 1 && resetAfter === null
      && status < 400 && bucket.resetAt < this.#now()) {
      // No reset window was advertised; space this route out slightly instead
      // of hammering it.
      bucket.resetAt = this.#now() + DEFAULT_INTERVAL_MS;
    }
    return bucket;
  }

  /**
   * Apply a 429. The caller retries once with the platform's own delay; the
   * limiter decides how long, and whether everything waits.
   */
  async penalize(routeKey, { headers, body, signal } = {}) {
    const retryAfterMs = secondsToMs(body?.retry_after ?? headerValue(headers, 'retry-after'))
      ?? Number(headerValue(headers, 'x-ratelimit-reset-after')) * 1_000
      ?? 1_000;
    const delay = Math.min(MAX_RETRY_AFTER_MS, Math.max(50, Math.round(retryAfterMs)));
    if (isGlobalRateLimit(headers, body)) {
      this.#globalUntil = Math.max(this.#globalUntil, this.#now() + delay);
      this.#logger.warn?.(`[dsh-im:discord] global rate limit; pausing ${delay}ms`);
    } else {
      const bucket = this.bucket(routeKey);
      bucket.remaining = 0;
      bucket.resetAt = Math.max(bucket.resetAt, this.#now() + delay);
    }
    await this.#sleep(delay, signal);
    return delay;
  }

  snapshot() {
    return {
      globalUntil: this.#globalUntil,
      buckets: [...this.#buckets.entries()].map(([route, bucket]) => ({
        route,
        remaining: bucket.remaining,
        resetAt: bucket.resetAt,
      })),
    };
  }
}
