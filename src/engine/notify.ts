// Decides which freshly synced Inbox messages deserve a "new mail" notification (ARCHITECTURE 5.4).
// Rules: never during or right after the first download of a mailbox, only unread mail that really
// arrived recently, and never for messages we moved ourselves (undo, "not spam").
import type { MessageHeader } from '../shared/ipc';
import type { EngineContext } from './context';
import type { FolderRow } from './db/repos/folderRepo';
import type { SyncResult } from './imap/syncFolder';

/** Mail older than this when we notice it is not announced (e.g. the app was closed all day). */
export const NOTIFY_MAX_AGE_MS = 60 * 60_000;
const RECENT_MOVE_MS = 2 * 60_000;

function getKv(ctx: EngineContext, key: string): string | null {
  const r = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return r?.v ?? null;
}

function setKv(ctx: EngineContext, key: string, value: string): void {
  ctx.db
    .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, value);
}

export function newMailToAnnounce(
  ctx: EngineContext,
  folder: FolderRow,
  res: Pick<SyncResult, 'kind' | 'newUnread'>,
): MessageHeader[] {
  if (folder.role !== 'inbox') return [];
  const key = `notify_since:${folder.account_id}`;
  if (res.kind === 'initial') {
    // Everything downloaded now is old news.
    setKv(ctx, key, String(ctx.now()));
    return [];
  }
  if (res.newUnread.length === 0) return [];
  // No marker yet = this mailbox was synced before notifications existed: start from now.
  if (getKv(ctx, key) === null) {
    setKv(ctx, key, String(ctx.now()));
    return [];
  }
  const now = ctx.now();
  // Compare with the clock, not with the first sync: servers set INTERNALDATE to the second and
  // their clocks can differ from ours by a little.
  const floor = now - NOTIFY_MAX_AGE_MS;
  // Forget old entries while we are here.
  for (const [k, t] of ctx.recentMoves) if (now - t > RECENT_MOVE_MS) ctx.recentMoves.delete(k);

  const out: MessageHeader[] = [];
  for (const id of res.newUnread) {
    const row = ctx.messages.row(id);
    if (!row || row.flag_seen === 1 || row.flag_deleted === 1) continue;
    if (row.internal_ms < floor) continue;
    if (row.message_id && ctx.recentMoves.has(`${row.account_id}|${row.message_id}`)) continue;
    const [h] = ctx.messages.headers([id]);
    if (h) out.push(h);
  }
  return out;
}
