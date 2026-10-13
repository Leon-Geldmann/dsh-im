import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

async function durableWrite(path, content) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
}

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** A complete private snapshot is a prerequisite for removing the Discord entry. */
export async function saveArchiveSnapshot({ root, channel, api, harness, signal }) {
  if (!/^\d{5,30}$/.test(channel?.channelId)) throw new TypeError('Invalid archive channel');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = `${channel.channelId}-${randomUUID()}`;
  const pending = join(root, `${directory}.pending`);
  const complete = join(root, directory);
  await mkdir(pending, { mode: 0o700 });
  const manifest = { version: 1, channel: structuredClone(channel), createdAt: new Date().toISOString(), history: [], messages: [], attachments: [] };
  try {
    if (channel.sessionId) {
      let beforeSeq;
      for (let pageIndex = 0; ; pageIndex += 1) {
        signal?.throwIfAborted();
        if (pageIndex >= 10_000) throw new Error('Archive history limit reached; channel retained');
        const page = await harness.readSessionHistory(channel.sessionId, { maxMessages: 100, beforeSeq, signal });
        if (!Array.isArray(page?.events) || typeof page.hasMore !== 'boolean') throw new Error('Incomplete Harness archive history');
        let oldest = beforeSeq ?? Infinity;
        for (const row of page.events) {
          const seq = row?.event?.seq;
          if (!Number.isSafeInteger(seq) || seq < 0 || (beforeSeq !== undefined && seq >= beforeSeq)) throw new Error('Invalid archive history cursor');
          oldest = Math.min(oldest, seq);
          manifest.history.push(row);
        }
        if (!page.hasMore) break;
        if (!Number.isFinite(oldest) || oldest === beforeSeq) throw new Error('Archive history did not advance');
        beforeSeq = oldest;
      }
      manifest.history.sort((a, b) => a.event.seq - b.event.seq);
    }
    let before;
    for (let pageIndex = 0; ; pageIndex += 1) {
      signal?.throwIfAborted();
      if (pageIndex >= 10_000) throw new Error('Archive message limit reached; channel retained');
      const messages = await api.listChannelMessages({ channelId: channel.channelId, limit: 100, before, signal });
      if (!Array.isArray(messages)) throw new Error('Incomplete Discord archive history');
      if (!messages.length) break;
      let oldest = before;
      for (const message of messages) {
        if (!/^\d{5,30}$/.test(message?.id) || (before && BigInt(message.id) >= BigInt(before))) throw new Error('Invalid Discord archive cursor');
        if (!oldest || BigInt(message.id) < BigInt(oldest)) oldest = message.id;
        // Preserve message content and attachment metadata, without expiring CDN URLs.
        manifest.messages.push({ id: message.id, content: message.content ?? '', authorId: message.author?.id,
          timestamp: message.timestamp, embeds: message.embeds ?? [] });
        for (const attachment of message.attachments ?? []) {
          signal?.throwIfAborted();
          const loaded = await api.downloadAttachment({ url: attachment.url, signal });
          const file = `attachment-${manifest.attachments.length}`;
          let size = 0;
          await durableWrite(join(pending, file), (async function* () {
            for await (const chunk of loaded.stream) {
              signal?.throwIfAborted();
              size += chunk.byteLength;
              yield chunk;
            }
          }()));
          if (!Number.isSafeInteger(attachment.size) || attachment.size !== size) throw new Error('Incomplete archive attachment');
          manifest.attachments.push({ messageId: message.id, id: attachment.id, name: attachment.filename,
            mediaType: attachment.content_type, size, file });
        }
      }
      before = oldest;
    }
    await durableWrite(join(pending, 'manifest.json'), JSON.stringify(manifest));
    await syncDirectory(pending);
    await rename(pending, complete);
    await syncDirectory(root);
    const newestMessageId = manifest.messages.reduce((latest, item) => !latest || BigInt(item.id) > BigInt(latest) ? item.id : latest, null);
    return { directory, createdAt: manifest.createdAt, newestMessageId, messages: manifest.messages.length, attachments: manifest.attachments.length };
  } catch (error) {
    await rm(pending, { recursive: true, force: true });
    throw error;
  }
}
