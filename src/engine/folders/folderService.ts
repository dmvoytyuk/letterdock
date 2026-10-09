// Folder create / rename / delete (ARCHITECTURE section 0, item 5).
import type { CreateFolderReq, DeleteFolderReq, Folder, RenameFolderReq } from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import type { SessionManager } from '../imap/sessionManager';

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
  ) {}

  list(accountId?: string): Folder[] {
    return this.ctx.folders.list(accountId);
  }

  private delimiterFor(accountId: string): string | null {
    const rows = this.ctx.folders.rowsForAccount(accountId);
    return rows.find((r) => r.delimiter)?.delimiter ?? null;
  }

  async create(req: CreateFolderReq): Promise<Folder> {
    const session = this.sessions.get(req.accountId);
    const parent = req.parentPath
      ? this.ctx.folders.rowByPath(req.accountId, req.parentPath)
      : null;
    if (req.parentPath && !parent)
      throw new AppException('NOT_FOUND', 'The parent folder was not found.');
    const delimiter = parent?.delimiter ?? this.delimiterFor(req.accountId);
    const leaf = validateFolderName(req.name, delimiter);
    const path = await session.run('user', async (c) => {
      const prefix = parent ? '' : (c.namespace?.prefix ?? '');
      const target = joinPath(parent?.path ?? null, delimiter, leaf, prefix);
      if (this.ctx.folders.rowByPath(req.accountId, target)) {
        throw new AppException('INVALID_INPUT', 'A folder with this name already exists.');
      }
      const res = await c.mailboxCreate(target);
      await c.mailboxSubscribe(res.path).catch(() => undefined);
      return res.path;
    });
    await session.discoverFolders();
    const row = this.ctx.folders.rowByPath(req.accountId, path);
    if (!row) throw new AppException('INTERNAL', 'The folder was created but could not be found.');
    return this.ctx.folders.get(row.id)!;
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
    const session = this.sessions.get(row.account_id);
    await session.run('user', (c) => c.mailboxRename(row.path, newPath));
    // Keep cached messages: move the DB rows to the new path before re-listing.
    this.ctx.folders.renamePath(row.account_id, row.path, newPath, row.delimiter);
    await session.discoverFolders();
    this.ctx.hub.emit({ type: 'folders:changed', accountId: row.account_id });
    return (
      this.ctx.folders.get(row.id) ??
      this.ctx.folders.get(this.ctx.folders.rowByPath(row.account_id, newPath)!.id)!
    );
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
    const session = this.sessions.get(row.account_id);
    await session.run('user', (c) => c.mailboxDelete(row.path));
    const ids = this.ctx.messages.idsForFolder(row.id);
    this.ctx.folders.delete(row.id);
    this.ctx.messages.ftsDeleteMany(ids);
    this.ctx.hub.changed({ folderIds: [row.id], removed: ids });
    this.ctx.hub.emit({ type: 'folders:changed', accountId: row.account_id });
    await session.discoverFolders().catch(() => undefined);
  }
}
