// Keeps the downloaded message bodies and attachment files under AppSettings.maxBodyCacheMB.
// The message headers always stay. An evicted message downloads again when it is opened.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineContext } from '../context';

const MB = 1024 * 1024;
/** After a cleanup the cache sits a little under the cap, so it does not clean on every download. */
const TARGET_RATIO = 0.9;
const BATCH = 200;

export function attachmentDir(ctx: EngineContext, accountId: string, messageId: number): string {
  return join(ctx.dataDir, 'attachments', accountId, String(messageId));
}

/** Removes the least recently opened bodies (and their attachment files) until under the cap. */
export async function pruneBodyCache(ctx: EngineContext): Promise<number> {
  const cap = ctx.settings().maxBodyCacheMB * MB;
  let total = ctx.messages.bodyCacheBytes();
  if (total <= cap) return 0;
  const target = cap * TARGET_RATIO;
  let evicted = 0;
  while (total > target) {
    const batch = ctx.messages.cachedBodiesOldestFirst(BATCH);
    if (batch.length === 0) break;
    const ids: number[] = [];
    for (const m of batch) {
      if (total <= target) break;
      ids.push(m.id);
      total -= m.bytes;
    }
    ctx.messages.evictBodies(ids);
    for (const m of batch.slice(0, ids.length)) {
      await rm(attachmentDir(ctx, m.accountId, m.id), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    evicted += ids.length;
  }
  if (evicted > 0) ctx.log.info({ evicted }, 'body cache trimmed');
  return evicted;
}
