/**
 * Task admission for the Guild workbench.
 *
 * Admission is implemented here, not by asking the model to wait: one Session
 * runs one task at a time, one project defaults to one task at a time (so two
 * channels in the same working directory cannot edit it together), and the
 * global limit bounds how many tasks run at once. Control operations such as
 * stop and steering do not pass through this queue.
 */

class Semaphore {
  #limit;
  #active = 0;
  #waiters = [];

  constructor(limit) {
    this.#limit = Math.max(1, limit);
  }

  get active() { return this.#active; }
  get waiting() { return this.#waiters.length; }

  setLimit(limit) {
    this.#limit = Math.max(1, limit);
    this.#drain();
  }

  acquire() {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release() {
    this.#active = Math.max(0, this.#active - 1);
    this.#drain();
  }

  #drain() {
    while (this.#active < this.#limit && this.#waiters.length > 0) {
      this.#active += 1;
      this.#waiters.shift()();
    }
  }
}

export class WorkbenchQueue {
  #global;
  #projectLimit;
  #projects = new Map();
  #chains = new Map();
  #pending = new Map();
  #closed = false;

  constructor({ maxConcurrentTasks = 1, projectConcurrency = 1 } = {}) {
    this.#global = new Semaphore(maxConcurrentTasks);
    this.#projectLimit = projectConcurrency;
  }

  #project(projectId) {
    let semaphore = this.#projects.get(projectId);
    if (!semaphore) {
      semaphore = new Semaphore(this.#projectLimit);
      this.#projects.set(projectId, semaphore);
    }
    return semaphore;
  }

  setLimits({ maxConcurrentTasks, projectConcurrency } = {}) {
    if (Number.isSafeInteger(maxConcurrentTasks)) this.#global.setLimit(maxConcurrentTasks);
    if (Number.isSafeInteger(projectConcurrency)) {
      this.#projectLimit = Math.max(1, projectConcurrency);
      for (const semaphore of this.#projects.values()) semaphore.setLimit(this.#projectLimit);
    }
  }

  pendingFor(sessionId) {
    return this.#pending.get(String(sessionId)) ?? 0;
  }

  /**
   * Run one task under the Session chain, the project limit and the global
   * limit. Rejections propagate to the caller unchanged.
   */
  run({ sessionId = null, projectId = null } = {}, task) {
    if (typeof task !== 'function') throw new TypeError('A task function is required');
    const sessionKey = sessionId === null ? null : String(sessionId);
    const previous = sessionKey ? (this.#chains.get(sessionKey) ?? Promise.resolve()) : Promise.resolve();
    if (sessionKey) this.#pending.set(sessionKey, (this.#pending.get(sessionKey) ?? 0) + 1);
    const execution = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.#closed) {
          const error = new Error('The workbench queue is closed');
          error.code = 'workbench-queue-closed';
          throw error;
        }
        await this.#global.acquire();
        const project = projectId ? this.#project(String(projectId)) : null;
        try {
          if (project) await project.acquire();
          try {
            return await task();
          } finally {
            project?.release();
          }
        } finally {
          this.#global.release();
        }
      })
      .finally(() => {
        if (!sessionKey) return;
        const remaining = (this.#pending.get(sessionKey) ?? 1) - 1;
        if (remaining <= 0) this.#pending.delete(sessionKey);
        else this.#pending.set(sessionKey, remaining);
        if (this.#chains.get(sessionKey) === tail) this.#chains.delete(sessionKey);
      });
    const tail = execution.catch(() => undefined);
    if (sessionKey) this.#chains.set(sessionKey, tail);
    return execution;
  }

  status() {
    return {
      active: this.#global.active,
      waiting: this.#global.waiting,
      sessions: [...this.#pending.entries()].map(([sessionId, pending]) => ({ sessionId, pending })),
    };
  }

  close() {
    this.#closed = true;
  }
}
