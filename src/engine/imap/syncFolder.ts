// Folder sync (ARCHITECTURE.md 5.4): initial, incremental (CONDSTORE + fallback), load older.
import type { ImapFlow } from 'imapflow';
import type { FolderId } from '../../shared/ipc';
import type { EngineContext } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import { fillSnippets } from './snippets';
import { fetchedToHeader, flagsToSet, type FetchedLike } from './parse';
import {
  checkUidValidity,
  chunk,
  diffFlags,
  FETCH_BATCH,
  findExpunged,
  INITIAL_MAX_INBOX,
  INITIAL_MAX_OTHER,
  mailboxUnchanged,
  OLDER_PAGE,
  pickInitialUids,
  toSequenceSet,
  type RemoteFlags,
} from './syncDiff';

export interface SyncResult {
  added: number[];
  updated: number[];
  removed: number[];
  /** Unseen messages added by an incremental sync (basis for M4 notifications). */
  newUnread: number[];
  kind: 'initial' | 'incremental' | 'unchanged';
}

const HEADER_QUERY = {
  uid: true,
  flags: true,
  internalDate: true,
  size: true,
  envelope: true,
  bodyStructure: true,
  headers: ['references'],
  // Gmail (X-GM-THRID) and servers with OBJECTID (THREADID) tell their own conversation id; for other
  // servers imapflow leaves the item out. (DESIGN-SPEC 3.10.1)
  threadId: true,
};

export async function fetchHeaders(client: ImapFlow, uids: number[]): Promise<FetchedLike[]> {
  if (uids.length === 0) return [];
  const rows = await client.fetchAll(toSequenceSet(uids), HEADER_QUERY, { uid: true });
  return rows as unknown as FetchedLike[];
}

/** Fill list snippets for freshly added rows (bounded peek; never fails the sync). */
export async function addSnippets(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  fetched: FetchedLike[],
  added: number[],
): Promise<void> {
  if (added.length === 0) return;
  const addedSet = new Set(added);
  const idByUid = new Map<number, number>();
  for (const m of fetched) {
    const id = ctx.messages.idAt(folder.id, m.uid);
    if (id !== null && addedSet.has(id)) idByUid.set(m.uid, id);
  }
  const ids = await fillSnippets(ctx, client, fetched, idByUid).catch(() => []);
  if (ids.length > 0) ctx.hub.changed({ folderIds: [folder.id], updated: ids });
}

/** Feed newly added messages to the contacts index. Never fails the sync. */
export function learnContacts(ctx: EngineContext, addedIds: number[]): void {
  if (addedIds.length === 0) return;
  try {
    ctx.contacts.observe(ctx.messages.contactSourcesByIds(addedIds));
  } catch (e) {
    ctx.log.debug({ err: String((e as Error)?.message ?? e) }, 'contacts update failed');
  }
}

/**
 * Store fetched headers. In a Drafts folder, a row that is only a second copy of a draft we show
 * already (same Message-ID) is dropped again, so the list never shows a draft twice.
 */
function upsertFetched(
  ctx: EngineContext,
  folder: FolderRow,
  fetched: FetchedLike[],
): { added: number[]; updated: number[] } {
  const r = ctx.messages.upsertHeaders(
    fetched.map((m) => fetchedToHeader(folder.account_id, folder.id, m)),
  );
  if (folder.role === 'drafts' && ctx.drafts && r.added.length > 0) {
    const gone = new Set(ctx.drafts.reconcile(folder.id, r.added));
    if (gone.size > 0) {
      r.added = r.added.filter((id) => !gone.has(id));
      r.updated = r.updated.filter((id) => !gone.has(id));
    }
  }
  return r;
}

function emptyResult(kind: SyncResult['kind']): SyncResult {
  return { added: [], updated: [], removed: [], newUnread: [], kind };
}

export async function syncFolder(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  syncDays: number,
): Promise<SyncResult> {
  const mb = await client.mailboxOpen(folder.path, { readOnly: true });
  const uidValidity = Number(mb.uidValidity);
  const state = ctx.folders.syncState(folder.id)!;
  const decision = checkUidValidity(state.uidvalidity, uidValidity);

  let result: SyncResult;
  try {
    result = await runSync();
  } finally {
    emitIdle(ctx, folder);
  }
  ctx.folders.recomputeCounts(folder.id);
  ctx.hub.touchCounts();
  return result;

  async function runSync(): Promise<SyncResult> {
  let result: SyncResult;
  if (decision === 'reset') {
    ctx.log.warn({ folderId: folder.id }, 'UIDVALIDITY changed; purging folder');
    const removed = ctx.messages.purgeFolder(folder.id);
    ctx.folders.resetSyncState(folder.id);
    ctx.hub.changed({ folderIds: [folder.id], removed });
    result = await initialSync(ctx, client, folder, mb, syncDays);
  } else if (decision === 'first' || state.uidnext === null) {
    result = await initialSync(ctx, client, folder, mb, syncDays);
  } else {
    result = await incrementalSync(ctx, client, folder, mb, state);
  }
  return result;
  }
}

/** Tell the UI that foreground work on this folder is over (the list bar and "Getting your mail" depend on it). */
function emitIdle(ctx: EngineContext, folder: FolderRow): void {
  ctx.hub.emit({
    type: 'sync:progress',
    accountId: folder.account_id,
    folderId: folder.id,
    phase: 'idle',
    done: 0,
    total: null,
  });
}

type Mailbox = Awaited<ReturnType<ImapFlow['mailboxOpen']>>;

async function initialSync(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  mb: Mailbox,
  syncDays: number,
): Promise<SyncResult> {
  const res = emptyResult('initial');
  const since = new Date(ctx.now() - syncDays * 86_400_000);
  const found = mb.exists > 0 ? (await client.search({ since }, { uid: true })) || [] : [];
  const max = folder.role === 'inbox' ? INITIAL_MAX_INBOX : INITIAL_MAX_OTHER;
  const picks = pickInitialUids(found, max);
  let done = 0;
  for (const batch of chunk(picks, FETCH_BATCH)) {
    const fetched = await fetchHeaders(client, batch);
    const { added, updated } = upsertFetched(ctx, folder, fetched);
    learnContacts(ctx, added);
    res.added.push(...added);
    res.updated.push(...updated);
    // Counts follow the rows at once, so the sidebar never lags behind the list.
    ctx.folders.recomputeCounts(folder.id);
    ctx.hub.touchCounts();
    done += batch.length;
    ctx.hub.changed({ folderIds: [folder.id], added, updated });
    await addSnippets(ctx, client, folder, fetched, added);
    ctx.hub.emit({
      type: 'sync:progress',
      accountId: folder.account_id,
      folderId: folder.id,
      phase: 'initial',
      done,
      total: picks.length,
    });
  }
  // Only now do we persist cursors, so an interrupted sync restarts cleanly.
  ctx.folders.saveSyncState(folder.id, {
    uidvalidity: Number(mb.uidValidity),
    uidnext: mb.uidNext,
    highestmodseq: mb.highestModseq !== undefined ? mb.highestModseq.toString() : null,
    serverExists: mb.exists,
    lastSyncAt: ctx.now(),
    oldestSyncedUid: picks.length > 0 ? Math.min(...picks) : mb.uidNext,
    historyComplete: mb.exists <= picks.length,
  });
  return res;
}

async function incrementalSync(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  mb: Mailbox,
  state: NonNullable<ReturnType<EngineContext['folders']['syncState']>>,
): Promise<SyncResult> {
  const res = emptyResult('incremental');
  const serverModseq = mb.highestModseq !== undefined ? mb.highestModseq.toString() : null;
  if (
    mailboxUnchanged(
      {
        uidValidity: Number(mb.uidValidity),
        uidNext: mb.uidNext,
        highestModseq: serverModseq,
        exists: mb.exists,
      },
      {
        uidnext: state.uidnext,
        highestmodseq: state.highestmodseq,
        serverExists: state.serverExists,
      },
    )
  ) {
    ctx.folders.saveSyncState(folder.id, { lastSyncAt: ctx.now() });
    return emptyResult('unchanged');
  }

  const fromUid = state.uidnext ?? 1;
  const oldest = state.oldestSyncedUid ?? 1;

  // 1. New messages.
  if (mb.exists > 0 && mb.uidNext > fromUid) {
    const rows = (
      (await client.fetchAll(`${fromUid}:*`, HEADER_QUERY, {
        uid: true,
      })) as unknown as FetchedLike[]
    ).filter((m) => m.uid >= fromUid);
    const { added, updated } = upsertFetched(ctx, folder, rows);
    learnContacts(ctx, added);
    await addSnippets(ctx, client, folder, rows, added);
    res.added.push(...added);
    res.updated.push(...updated);
    const unseen = new Set(rows.filter((m) => !flagsToSet(m.flags).seen).map((m) => m.uid));
    if (unseen.size > 0) {
      const rowsByUid = new Map(
        ctx.messages.flagRows(folder.id, fromUid).map((r) => [r.uid, r.id]),
      );
      for (const uid of unseen) {
        const id = rowsByUid.get(uid);
        if (id !== undefined && added.includes(id)) res.newUnread.push(id);
      }
    }
  }

  // 2. Flag changes and expunges.
  let serverUids: Set<number> | null = null;
  let flagUpdates: ReturnType<typeof diffFlags> = [];
  if (mb.exists === 0) {
    serverUids = new Set();
  } else {
    // Messages with a queued (not yet sent) flag change keep their local flags until it is sent.
    const queued = ctx.pendingOps?.messageIdsWithFlagOps(folder.account_id);
    const local = ctx.messages
      .flagRows(folder.id, oldest)
      .filter((r) => !queued || !queued.has(r.id));
    const canCondstore = serverModseq !== null && state.highestmodseq !== null;
    let usedCondstore = false;
    if (canCondstore) {
      try {
        const changed = (await client.fetchAll(
          '1:*',
          { uid: true, flags: true },
          { uid: true, changedSince: BigInt(state.highestmodseq!) },
        )) as unknown as FetchedLike[];
        const remote: RemoteFlags[] = changed.map((m) => ({
          uid: m.uid,
          flags: flagsToSet(m.flags),
          modseq: m.modseq?.toString() ?? null,
        }));
        flagUpdates = diffFlags(local, remote);
        const all = (await client.search({ uid: `${oldest}:*` }, { uid: true })) || [];
        serverUids = new Set(all);
        usedCondstore = true;
      } catch (e) {
        ctx.log.debug(
          { err: (e as Error).message },
          'CONDSTORE path failed; using full flag fetch',
        );
      }
    }
    if (!usedCondstore) {
      const all = (await client.fetchAll(
        `${oldest}:*`,
        { uid: true, flags: true },
        { uid: true },
      )) as unknown as FetchedLike[];
      serverUids = new Set(all.map((m) => m.uid));
      flagUpdates = diffFlags(
        local,
        all.map((m) => ({ uid: m.uid, flags: flagsToSet(m.flags) })),
      );
    }
  }
  if (flagUpdates.length > 0) {
    res.updated.push(...ctx.messages.applyFlags(folder.id, flagUpdates));
  }
  if (serverUids) {
    const localUids = ctx.messages.flagRows(folder.id, oldest).map((r) => r.uid);
    const gone = findExpunged(localUids, serverUids, oldest);
    if (gone.length > 0) res.removed.push(...ctx.messages.deleteByUids(folder.id, gone));
  }

  ctx.folders.saveSyncState(folder.id, {
    uidnext: Math.max(mb.uidNext, fromUid),
    highestmodseq: serverModseq,
    serverExists: mb.exists,
    lastSyncAt: ctx.now(),
  });
  const added = res.added;
  const updated = res.updated.filter((id) => !added.includes(id));
  if (added.length || updated.length || res.removed.length) {
    ctx.hub.changed({ folderIds: [folder.id], added, updated, removed: res.removed });
  }
  ctx.hub.emit({
    type: 'sync:progress',
    accountId: folder.account_id,
    folderId: folder.id,
    phase: 'incremental',
    done: added.length,
    total: null,
  });
  return res;
}

/** Fetch the next page of older messages (sync.loadOlder). */
export async function loadOlder(
  ctx: EngineContext,
  client: ImapFlow,
  folderId: FolderId,
): Promise<{ fetched: number; reachedStart: boolean }> {
  const folder = ctx.folders.row(folderId);
  if (!folder) return { fetched: 0, reachedStart: true };
  const state = ctx.folders.syncState(folderId)!;
  const oldest = state.oldestSyncedUid;
  if (state.historyComplete || oldest === null || oldest <= 1) {
    ctx.folders.saveSyncState(folderId, { historyComplete: true });
    return { fetched: 0, reachedStart: true };
  }
  const mb = await client.mailboxOpen(folder.path, { readOnly: true });
  if (state.uidvalidity !== null && Number(mb.uidValidity) !== state.uidvalidity) {
    // Folder changed under us; a normal sync will purge and restart.
    return { fetched: 0, reachedStart: false };
  }
  const older = (await client.search({ uid: `1:${oldest - 1}` }, { uid: true })) || [];
  const picks = pickInitialUids(older, OLDER_PAGE);
  let fetched = 0;
  for (const batch of chunk(picks, FETCH_BATCH)) {
    const rows = await fetchHeaders(client, batch);
    const { added, updated } = upsertFetched(ctx, folder, rows);
    fetched += added.length;
    learnContacts(ctx, added);
    await addSnippets(ctx, client, folder, rows, added);
    ctx.hub.changed({ folderIds: [folderId], added, updated });
    ctx.hub.emit({
      type: 'sync:progress',
      accountId: folder.account_id,
      folderId,
      phase: 'older',
      done: Math.min(fetched, picks.length),
      total: picks.length,
    });
  }
  emitIdle(ctx, folder);
  const reachedStart = picks.length >= older.length;
  ctx.folders.saveSyncState(folderId, {
    oldestSyncedUid: picks.length > 0 ? Math.min(...picks) : 1,
    historyComplete: reachedStart,
  });
  ctx.folders.recomputeCounts(folderId);
  ctx.hub.touchCounts();
  return { fetched, reachedStart };
}
