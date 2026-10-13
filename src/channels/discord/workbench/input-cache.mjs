import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Save authorized inputs before waiting for a task slot or an expiring CDN. */
export async function cacheWorkbenchInputs(message, { root, messageId, signal, imageLimits = {} }) {
  if (!/^\d{5,30}$/.test(messageId)) throw new TypeError('A Discord message ID is required');
  const inputs = ['files', 'images'].flatMap((kind) => (
    (message[kind] ?? []).map((source, index) => ({ kind, source, index }))
  ));
  if (inputs.length === 0) return { message, attachments: [], cleanup: async () => {} };
  const directory = join(root, `${messageId}-${randomUUID()}`);
  const cleanup = () => rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prepared = { ...message, files: [...(message.files ?? [])], images: [...(message.images ?? [])] };
  const attachments = [];
  try {
    for (const { kind, source, index } of inputs) {
      signal?.throwIfAborted();
      const fileName = `${kind}-${index}`;
      const path = join(directory, fileName);
      const loaded = source.data ?? await source.load({ signal,
        ...(kind === 'images' ? { maxBytes: imageLimits.maxImageBytes } : {}) });
      const raw = Buffer.isBuffer(loaded) || loaded instanceof Uint8Array
        ? loaded : loaded?.data ?? loaded?.buffer;
      const stream = raw instanceof Uint8Array ? [raw] : loaded?.stream ?? loaded;
      if (!stream?.[Symbol.asyncIterator] && !stream?.[Symbol.iterator]) {
        throw new TypeError('The attachment has no readable bytes');
      }
      let size = 0;
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile((async function* () {
          for await (const chunk of stream) {
            signal?.throwIfAborted();
            size += chunk.byteLength;
            yield chunk;
          }
        }()));
      } finally {
        await handle.close();
      }
      const descriptor = { kind, name: source.name ?? loaded?.name ?? 'attachment',
        mediaType: source.mediaType ?? loaded?.mediaType, size,
        cache: `${directory.split('/').at(-1)}/${fileName}` };
      attachments.push(descriptor);
      prepared[kind][index] = {
        ...source, size,
        load: async ({ signal: loadSignal } = {}) => {
          loadSignal?.throwIfAborted();
          return kind === 'images' ? readFile(path, { signal: loadSignal })
            : { stream: createReadStream(path, { signal: loadSignal }) };
        },
      };
    }
    return { message: prepared, attachments, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
