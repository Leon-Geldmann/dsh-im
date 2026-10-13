import { after } from 'node:test';

// Mock transports have no socket handle. Keep their AbortSignal.timeout() and
// unref'ed production timers observable until tests finish, just as a live
// transport would. --test-timeout still fails genuinely stuck tests.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));
