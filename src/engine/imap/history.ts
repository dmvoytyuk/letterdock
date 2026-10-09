// "Keep mail on this PC for" (Account.syncDays) after it changes.
//  - Narrowing removes older rows from this PC only. Nothing is ever deleted on the server.
//  - Widening fetches the older headers down to the new window.
// Contacts learned from the removed mail are kept on purpose.
import { rm } from 'node:fs/promises';
import type { ImapFlow } from 'imapflow';
import type { FolderId } from '../../shared/ipc';
import type { EngineContext } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import { attachmentDir } from '../messages/bodyCache';
import { fetchedToHeader, type FetchedLike } from './parse';
import { chunk, FETCH_BATCH } from './syncDiff';
import { addSnippets, fetchHeaders, learnContacts } from './syncFolder';

const DAY_MS = 86_400_000;
/** Most messages one widening fetches per folder (a very large window continues with "load older"). */
export const WIDEN_MAX_PER_FOLDER = 5000;

/** kv key: this account still has to fetch older mail for a wider window. */
export const widenKey = (accountId: string): string => `history_widen:${accountId}`;

export function setWidenPending(ctx: EngineContext, accountId: string, on: boolean): void {
  if (on) {
    ctx.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(widenKey(accountId), '1');
  } else {
    ctx.db.prepare('DELETE FROM kv WHERE k = ?').run(widenKey(accountId));
  }
}

export function isWidenPending(ctx: EngineContext, accountId: string): boolean {
  return ctx.db.prepare('SELECT 1 FROM kv WHERE k = ?').get(widenKey(accountId)) !== undefined;
}

/** Remove this account's mail older than the window from the PC. Returns the number removed. */
export async function pruneToWindow(
  ctx: EngineContext,
  accountId: string,
  syncDays: number,
): Promise<number> {
  const cutoff = ctx.now() - syncDays * DAY_MS;
  const keep = ctx.pendingOps?.messageIdsWithFlagOps(accountId) ?? new Set<number>();
  const byFolder = ctx.messages.pruneOlderThan(accountId, cutoff, keep);
  let total = 0;
  const all: number[] = [];
  for (const [folderId, ids] of byFolder) {
    total += ids.length;
    all.push(...ids);
    // The next "load older" starts below what is left.
    const min = ctx.messages.minUid(folderId);
    const st = ctx.folders.syncState(folderId);
    if (st) {
      ctx.folders.saveSyncState(folderId, {
        oldestSyncedUid: min ?? st.uidnext ?? st.oldestSyncedUid,
        historyComplete: false,
      });
    }
    ctx.folders.recomputeCounts(folderId);
    ctx.hub.changed({ folderIds: [folderId], removed: ids });
  }
  if (total > 0) {
    ctx.hub.touchCounts();
    for (const id of all) {
      await rm(attachmentDir(ctx, accountId, id), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    ctx.log.info({ accountId, removed: total, syncDays }, 'removed mail older than the window from this PC');
  }
  return total;
}

/** Fetch headers older than what we have, down to the window. Needs an open connection. */
export async function widenFolder(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  syncDays: number,
  /** True when the window was narrowed meanwhile: stop and leave the cursors alone. */
  cancelled: () => boolean = () => false,
): Promise<number> {
  const state = ctx.folders.syncState(folder.id);
  if (!state || state.uidvalidity === null || state.oldestSyncedUid === null) return 0;
  if (state.oldestSyncedUid <= 1) {
    ctx.folders.saveSyncState(folder.id, { historyComplete: true });
    return 0;
  }
  const mb = await client.mailboxOpen(folder.path, { readOnly: true });
  if (Number(mb.uidValidity) !== state.uidvalidity) return 0; // a normal sync rebuilds the folder
  const oldest = state.oldestSyncedUid;
  const since = new Date(ctx.now() - syncDays * DAY_MS);
  const found = ((await client.search({ since }, { uid: true })) || []).filter((u) => u < oldest);
  const picks = [...found].sort((a, b) => b - a).slice(0, WIDEN_MAX_PER_FOLDER);
  let fetched = 0;
  for (const batch of chunk(picks, FETCH_BATCH)) {
    if (cancelled()) return fetched;
    const rows: FetchedLike[] = await fetchHeaders(client, batch);
    const { added, updated } = ctx.messages.upsertHeaders(
      rows.map((m) => fetchedToHeader(folder.account_id, folder.id, m)),
    );
    fetched += added.length;
    learnContacts(ctx, added);
    await addSnippets(ctx, client, folder, rows, added);
    ctx.folders.recomputeCounts(folder.id);
    ctx.hub.touchCounts();
    ctx.hub.changed({ folderIds: [folder.id], added, updated });
    ctx.hub.emit({
      type: 'sync:progress',
      accountId: folder.account_id,
      folderId: folder.id as FolderId,
      phase: 'older',
      done: Math.min(fetched, picks.length),
      total: picks.length,
    });
  }
  if (cancelled()) return fetched;
  if (picks.length > 0) {
    // Mail older than the window may still be on the server: "load older" continues from here.
    ctx.folders.saveSyncState(folder.id, { oldestSyncedUid: Math.min(...picks), historyComplete: false });
  }
  ctx.hub.emit({
    type: 'sync:progress',
    accountId: folder.account_id,
    folderId: folder.id,
    phase: 'idle',
    done: 0,
    total: null,
  });
  return fetched;
}
