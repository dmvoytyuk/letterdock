// Folder create / rename / delete (ARCHITECTURE section 0, item 5).
import type { CreateFolderReq, DeleteFolderReq, Folder, RenameFolderReq } from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import type { SessionManager } from '../imap/sessionManager';
import type { ActionService } from '../messages/actionService';

/** Validate a single folder name segment. Returns the trimmed name. */
export function validateFolderName(raw: string, delimiter: string | null): string {
  const name = raw.trim();
  if (!name) throw new AppException('INVALID_INPUT', 'Enter a folder name.');
  if (name.length > 100) throw new AppException('INVALID_INPUT', 'The folder name is too long.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
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
