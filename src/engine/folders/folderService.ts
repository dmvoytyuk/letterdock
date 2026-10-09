// Folder create / rename / delete (ARCHITECTURE section 0, item 5).
import type {
  CreateFolderReq,
  DeleteFolderReq,
  Folder,
  FolderCountReq,
  FolderCountRes,
  RenameFolderReq,
} from '../../shared/ipc';
import { hasControlChars } from '../../shared/safety';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import type { SessionManager } from '../imap/sessionManager';
import type { ActionService } from '../messages/actionService';

/** Validate a single folder name segment. Returns the trimmed name. */
export function validateFolderName(raw: string, delimiter: string | null): string {
  const name = raw.trim();
  if (!name) throw new AppException('INVALID_INPUT', 'Enter a folder name.');
  if (name.length > 100) throw new AppException('INVALID_INPUT', 'The folder name is too long.');
  if (hasControlChars(name)) {
    throw new AppException('INVALID_INPUT', 'The folder name contains invalid characters.');
  }
  if (
    /[*%#]/.test(name) ||
    (delimiter && name.includes(delimiter)) ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new AppException(
      'INVALID_INPUT',
      'The folder name cannot contain / \\ * % # or the server separator.',
    );
  }
  if (name === '.' || name === '..') {
    throw new AppException('INVALID_INPUT', 'Choose a different folder name.');
  }
  return name;
}

/** Join parent path and leaf with the server delimiter. */
export function joinPath(
  parent: string | null,
  delimiter: string | null,
  leaf: string,
  prefix = '',
): string {
  if (parent) return delimiter ? `${parent}${delimiter}${leaf}` : leaf;
  return `${prefix}${leaf}`;
}

export function parentOf(path: string, delimiter: string | null): string | null {
  if (!delimiter) return null;
  const i = path.lastIndexOf(delimiter);
  return i > 0 ? path.slice(0, i) : null;
}

export class FolderService {
  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
    private readonly actions: ActionService,
  ) {}

  list(accountId?: string): Folder[] {
    return this.ctx.folders.list(accountId);
  }

  /**
   * Message count of a folder (or of the Inboxes), counted like "Run rules on this folder" does:
   * no drafts, no hidden (deleted) rows, no rows that only exist on this PC.
   */
  count(req: FolderCountReq): FolderCountRes {
    const accountId = req.accountId ?? null;
    let ids: number[];
    if (req.folderId === 'allInboxes') {
      ids = this.ctx.accounts
        .list()
        .filter((a) => accountId === null || a.id === accountId)
        .map((a) => this.ctx.folders.rowByRole(a.id, 'inbox'))
        .flatMap((f) => (f ? [f.id] : []));
    } else {
      const f = this.ctx.folders.row(req.folderId);
      if (!f) throw new AppException('NOT_FOUND', 'Folder not found.');
      if (accountId !== null && f.account_id !== accountId) {
        throw new AppException('INVALID_INPUT', 'This folder belongs to another account.');
      }
      ids = [f.id];
    }
    if (ids.length === 0) return { total: 0, unread: 0 };
    const marks = ids.map(() => '?').join(',');
    const r = this.ctx.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN flag_seen = 0 THEN 1 ELSE 0 END), 0) AS unread
           FROM message
          WHERE folder_id IN (${marks}) AND flag_deleted = 0 AND flag_draft = 0 AND uid > 0`,
      )
      .get(...ids) as { total: number; unread: number };
    return { total: r.total, unread: r.unread };
  }

  private delimiterFor(accountId: string): string | null {
    const rows = this.ctx.folders.rowsForAccount(accountId);
    return rows.find((r) => r.delimiter)?.delimiter ?? null;
  }

  /** Online: wait until the server did it. Offline: return at once, the change waits in the queue. */
  private async settle(accountId: string): Promise<void> {
    await this.actions.flushAll(accountId);
  }

  async create(req: CreateFolderReq): Promise<Folder> {
    this.sessions.get(req.accountId); // unknown account -> error
    const parent = req.parentPath
      ? this.ctx.folders.rowByPath(req.accountId, req.parentPath)
      : null;
    if (req.parentPath && !parent)
      throw new AppException('NOT_FOUND', 'The parent folder was not found.');
    const delimiter = parent?.delimiter ?? this.delimiterFor(req.accountId);
    const leaf = validateFolderName(req.name, delimiter);
    await this.actions.settleRunning(req.accountId);
    const row = this.actions.folderOps.createLocal(req.accountId, parent, leaf);
    await this.settle(req.accountId);
    const err = this.actions.folderOps.takeError(row.id);
    if (err) throw new AppException(err.code, err.message, { retryable: false });
    const now = this.ctx.folders.get(row.id);
    if (!now) throw new AppException('INTERNAL', 'The folder was created but could not be found.');
    return now;
  }

  async rename(req: RenameFolderReq): Promise<Folder> {
    const row = this.ctx.folders.row(req.folderId);
    if (!row) throw new AppException('NOT_FOUND', 'Folder not found.');
    if (row.role !== null) {
      throw new AppException(
        'INVALID_INPUT',
        'Special folders such as Inbox or Sent cannot be renamed.',
      );
    }
    const leaf = validateFolderName(req.newName, row.delimiter);
    const newPath = joinPath(parentOf(row.path, row.delimiter), row.delimiter, leaf);
    if (newPath === row.path) return this.ctx.folders.get(row.id)!;
    if (this.ctx.folders.rowByPath(row.account_id, newPath)) {
      throw new AppException('INVALID_INPUT', 'A folder with this name already exists.');
    }
    await this.actions.settleRunning(row.account_id);
    const fresh = this.ctx.folders.row(req.folderId);
    if (!fresh) throw new AppException('NOT_FOUND', 'Folder not found.');
    this.actions.folderOps.renameLocal(fresh, newPath, leaf);
    await this.settle(row.account_id);
    const err = this.actions.folderOps.takeError(row.id);
    if (err) throw new AppException(err.code, err.message, { retryable: false });
    const now = this.ctx.folders.get(row.id);
    if (!now) throw new AppException('NOT_FOUND', 'The folder is no longer on the server.');
    return now;
  }

  async delete(req: DeleteFolderReq): Promise<void> {
    const row = this.ctx.folders.row(req.folderId);
    if (!row) throw new AppException('NOT_FOUND', 'Folder not found.');
    if (row.role !== null) {
      throw new AppException(
        'INVALID_INPUT',
        'Special folders such as Inbox or Sent cannot be deleted.',
      );
    }
    await this.actions.settleRunning(row.account_id);
    const fresh = this.ctx.folders.row(req.folderId);
    if (!fresh) return;
    this.actions.folderOps.deleteLocal(fresh);
    await this.settle(row.account_id);
    const err = this.actions.folderOps.takeError(`del:${row.account_id}:${row.path}`);
    if (err) throw new AppException(err.code, err.message, { retryable: false });
  }
}
