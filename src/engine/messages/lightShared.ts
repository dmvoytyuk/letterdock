// Shared helpers of the light features (DESIGN-SPEC 3.13): finding the messages a command acts on,
// and an undo store for snooze / pin / mute (their tokens work with `messages.undo`).
import { randomUUID } from 'node:crypto';
import type { LightTargets, ListScope, MessageId, UndoRes } from '../../shared/ipc';
import { UNDO_WINDOW_MS } from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import { scopeFilter, type MessageRow } from '../db/repos/messageRepo';

export type LightRow = MessageRow & { frole: string | null };

const UNDO_KEEP_MS = UNDO_WINDOW_MS + 30_000;

/** Undo actions of the light features. Tokens are random and short lived, like the move undo tokens. */
export class LightUndo {
  private store = new Map<string, { createdAt: number; run: () => Promise<MessageId[]> }>();

  constructor(private readonly now: () => number) {}

  add(run: () => Promise<MessageId[]>): string {
    const t = this.now();
    for (const [k, v] of this.store) if (t - v.createdAt > UNDO_KEEP_MS) this.store.delete(k);
    const token = `light:${randomUUID()}`;
    this.store.set(token, { createdAt: t, run });
    return token;
  }

  has(token: string): boolean {
    return this.store.has(token);
  }

  async undo(token: string): Promise<UndoRes> {
    const rec = this.store.get(token);
    if (!rec) throw new AppException('NOT_FOUND', 'This can no longer be undone.');
    this.store.delete(token);
    return { restored: await rec.run() };
  }
}

/**
 * The rows a command acts on. `messageIds`: those messages. `threadIds`: the conversation's messages
 * that are in `scope` (default: Inbox and folders of your own, not Sent / Drafts / Trash / Junk).
 * Rows that are deleted or still local drafts are skipped.
 */
export function resolveTargets(
  ctx: EngineContext,
  t: LightTargets,
  opts: { includeSnoozed?: boolean } = {},
): LightRow[] {
  const out = new Map<MessageId, LightRow>();
  const byId = ctx.db.prepare(
    'SELECT m.*, f.role AS frole FROM message m JOIN folder f ON f.id = m.folder_id WHERE m.id = ?',
  );
  for (const id of new Set(t.messageIds ?? [])) {
    const r = byId.get(id) as LightRow | undefined;
    if (r && r.flag_deleted === 0 && r.flag_draft === 0) out.set(r.id, r);
  }
  if (t.threadIds && t.threadIds.length > 0) {
    const f = t.scope ? scopeFilter(t.scope as ListScope, false) : null;
    const scopeSql = f
      ? f.where.replace(opts.includeSnoozed ? /\s*AND m\.snoozed_until IS NULL/ : /$^/, '')
      : "m.flag_deleted = 0 AND (f.role IS NULL OR f.role = 'inbox')";
    const stmt = ctx.db.prepare(
      `SELECT m.*, f.role AS frole FROM message m JOIN folder f ON f.id = m.folder_id
        WHERE m.thread_id = :threadId AND m.flag_draft = 0 AND ${scopeSql}`,
    );
    for (const threadId of new Set(t.threadIds)) {
      for (const r of stmt.all({ ...(f?.params ?? {}), threadId }) as LightRow[]) out.set(r.id, r);
    }
  }
  return [...out.values()];
}

export function accountsOf(rows: { account_id: string }[]): string[] {
  return [...new Set(rows.map((r) => r.account_id))];
}

export function foldersOf(rows: { folder_id: number }[]): number[] {
  return [...new Set(rows.map((r) => r.folder_id))];
}
