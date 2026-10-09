// Gmail (X-GM-THRID) and OBJECTID servers (THREADID) tell which messages belong together. New mail
// gets that id in the header sync; this fills it in for mail stored earlier (DESIGN-SPEC 3.10.1).
import type { ImapFlow } from 'imapflow';
import type { EngineContext } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import { toSequenceSet } from './syncDiff';

const BATCH = 300;

function getKv(ctx: EngineContext, key: string): string | null {
  const r = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return r?.v ?? null;
}

export function threadIdsDoneKey(folder: FolderRow): string {
  return `thrid_done:${folder.id}:${folder.uidvalidity ?? 0}`;
}

export function threadIdsDone(ctx: EngineContext, folder: FolderRow): boolean {
  return getKv(ctx, threadIdsDoneKey(folder)) === '1';
}

export function serverHasThreadIds(client: ImapFlow): boolean {
  return client.capabilities.has('X-GM-EXT-1') || client.capabilities.has('OBJECTID');
}

/**
 * One page: ask the server for the conversation id of stored rows that do not have it yet.
 * Returns how many rows it looked at (0 = this folder is done), or null if the server cannot tell.
 */
export async function backfillThreadIdsBatch(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  below: { uid: number },
): Promise<number | null> {
  if (!serverHasThreadIds(client)) return null;
  const todo = ctx.messages.threads.gmailTodo(folder.id, BATCH, below.uid);
  if (todo.length === 0) return 0;
  below.uid = Math.min(...todo.map((t) => t.uid));
  const byUid = new Map(todo.map((t) => [t.uid, t.id]));
  const rows = (await client.fetchAll(
    toSequenceSet([...byUid.keys()]),
    { uid: true, threadId: true },
    { uid: true },
  )) as unknown as { uid: number; threadId?: string }[];
  const items: { id: number; gmThrid: string }[] = [];
  for (const r of rows) {
    const id = byUid.get(r.uid);
    if (id !== undefined && r.threadId) items.push({ id, gmThrid: String(r.threadId) });
  }
  if (items.length > 0) {
    ctx.messages.touchThreads(ctx.messages.threads.setGmailThreads(folder.account_id, items));
    ctx.hub.touchThreads();
  }
  return todo.length;
}

export function markThreadIdsDone(ctx: EngineContext, folder: FolderRow): void {
  ctx.db
    .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(threadIdsDoneKey(folder), '1');
}
