import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflate as deflateCb, inflate as inflateCb } from 'node:zlib';
import { simpleParser, type Attachment } from 'mailparser';
import type {
  FolderId,
  ListMessagesReq,
  ListMessagesRes,
  ListScope,
  LoadOlderReq,
  LoadOlderRes,
  MessageBody,
  MessageHeader,
  MessageId,
} from '../../shared/ipc';
import type { PreparedAttachment } from '../../shared/internal';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import type { SessionManager } from '../imap/sessionManager';
import { rowToHeader, type MessageRow } from '../db/repos/messageRepo';
import { ftsText, hasRemoteImages, makeSnippet, safeFileName } from './bodyUtils';
import { readListHeaders } from '../../shared/listUnsubscribe';
import { headerPart } from './unsubscribeService';

export const MAX_DISPLAY_BYTES = 25 * 1024 * 1024;
const deflate = promisify(deflateCb);
const inflate = promisify(inflateCb);
const MAX_CID_BYTES = 2 * 1024 * 1024;
// Keep `cid:` image references in the HTML (served via attachments.cidData) instead of letting
// mailparser inline every image as a data: URI.
const PARSER_OPTIONS = { skipImageLinks: true };

export class MessageService {
  private inflight = new Map<MessageId, Promise<MessageBody>>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
  ) {}

  // ---------- lists ----------

  list(req: ListMessagesReq): ListMessagesRes {
    const { items, nextCursor, total, pinned } = this.ctx.messages.list(req);
    return {
      items,
      nextCursor,
      total,
      ...(pinned ? { pinned } : {}),
      canLoadOlderFromServer: nextCursor === null && this.canLoadOlder(req.scope),
    };
  }

  canLoadOlder(scope: ListScope): boolean {
    const base =
      'uidvalidity IS NOT NULL AND history_complete = 0 AND oldest_synced_uid > 1 AND selectable = 1';
    let sql: string;
    let arg: unknown[] = [];
    switch (scope.kind) {
      case 'folder':
        sql = `SELECT 1 FROM folder WHERE id = ? AND ${base}`;
        arg = [scope.folderId];
        break;
      case 'accountInbox':
        sql = `SELECT 1 FROM folder WHERE account_id = ? AND role = 'inbox' AND ${base}`;
        arg = [scope.accountId];
        break;
      case 'unifiedInbox':
      case 'unifiedUnread':
        sql = `SELECT 1 FROM folder WHERE role = 'inbox' AND ${base}`;
        break;
      default:
        return false;
    }
    return this.ctx.db.prepare(sql).get(...arg) !== undefined;
  }

  getHeaders(ids: MessageId[]): MessageHeader[] {
    return this.ctx.messages.headers(ids);
  }

  // ---------- bodies ----------

  private requireRow(id: MessageId): MessageRow {
    const row = this.ctx.messages.row(id);
    if (!row) throw new AppException('NOT_FOUND', 'This message is no longer available.');
    return row;
  }

  private buildBody(row: MessageRow, truncated = false): MessageBody {
    const body = this.ctx.messages.getBody(row.id);
    const extra = this.ctx.messages.extraHeaders(row.id)!;
    return {
      id: row.id,
      header: rowToHeader(this.requireRow(row.id)),
      bcc: extra.bcc,
      replyTo: extra.replyTo,
      inReplyTo: extra.inReplyTo,
      references: extra.references,
      html: body?.html ?? null,
      text: body?.text ?? null,
      attachments: this.ctx.messages.attachments(row.id),
      hasRemoteImages: hasRemoteImages(body?.html ?? null),
      senderImagesAllowed: this.ctx.messages.senderImagesAllowed(row.from_addr),
      truncated,
    };
  }

  get(id: MessageId): Promise<MessageBody> {
    const row = this.requireRow(id);
    if (row.body_state === 'cached' && this.ctx.messages.getBody(id)) {
      this.ctx.messages.touchBody(id, this.ctx.now()); // "last opened" for the cache cleanup
      return Promise.resolve(this.buildBody(row));
    }
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.fetchAndCache(row).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Where the server has this message right now: the folder path, uid and Message-ID to look for. */
  private async sourceLocation(
    row: MessageRow,
  ): Promise<{ path: string; uid: number; uv: number | null; mid: string | null }> {
    const pending = this.ctx.pendingOps;
    let cur: MessageRow = row;
    if (cur.uid <= 0) {
      // The message was moved on this PC and the server has not done the move yet (or is doing it
      // right now). Until then it is still in the folder it came from.
      let mv = pending?.findMove?.(cur.account_id, cur.id);
      if (mv?.inFlight) {
        await pending!.barrier(cur.account_id).catch(() => undefined);
        cur = this.requireRow(cur.id);
        mv = cur.uid <= 0 ? pending?.findMove?.(cur.account_id, cur.id) : undefined;
      }
      if (cur.uid <= 0) {
        const src = mv ? this.ctx.folders.row(mv.srcFolderId) : null;
        if (!mv || !src) {
          throw new AppException(
            'NOT_FOUND',
            'This message is being moved. Try again in a moment.',
            {
              retryable: true,
            },
          );
        }
        return {
          path: pending?.serverPath?.(src) ?? src.path,
          uid: mv.origUid,
          uv: mv.srcUv,
          mid: mv.mid,
        };
      }
    }
    const folder = this.ctx.folders.row(cur.folder_id);
    if (!folder) throw new AppException('NOT_FOUND', 'Folder not found.');
    return {
      path: pending?.serverPath?.(folder) ?? folder.path,
      uid: cur.uid,
      uv: null,
      mid: null,
    };
  }

  private async fetchSource(row: MessageRow): Promise<Buffer> {
    const loc = await this.sourceLocation(row);
    const session = this.sessions.get(row.account_id);
    return session.run('user', async (c) => {
      const mb = await c.mailboxOpen(loc.path, { readOnly: true });
      let uid = loc.uid;
      if (loc.uv !== null && Number(mb.uidValidity) !== loc.uv) {
        // The folder was rebuilt on the server: find the message again by its Message-ID.
        const found = loc.mid
          ? await c.search({ header: { 'message-id': loc.mid } }, { uid: true })
          : [];
        const list = found || [];
        if (list.length === 0) {
          throw new AppException('NOT_FOUND', 'This message is no longer on the server.');
        }
        uid = list[list.length - 1]!;
      }
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m || !m.source) {
        throw new AppException('NOT_FOUND', 'This message is no longer on the server.');
      }
      return m.source;
    });
  }

  private async fetchAndCache(row: MessageRow): Promise<MessageBody> {
    if (row.size !== null && row.size > MAX_DISPLAY_BYTES) {
      return { ...this.buildBody(row, true), html: null, text: null };
    }
    const source = await this.fetchSource(row);
    const parsed = await simpleParser(source, PARSER_OPTIONS);
    const html = typeof parsed.html === 'string' ? parsed.html : null;
    const text = parsed.text ?? null;

    const attDir = join(this.ctx.dataDir, 'attachments', row.account_id, String(row.id));
    const atts: {
      partId: string;
      filename: string | null;
      contentType: string;
      size: number;
      contentId: string | null;
      inline: boolean;
      cachedPath: string | null;
    }[] = [];
    let index = 0;
    for (const a of parsed.attachments) {
      const cid = a.cid ?? null;
      const inline = !!cid && !!html && html.includes(`cid:${cid}`);
      let cachedPath: string | null = null;
      if (inline && a.size <= MAX_CID_BYTES) {
        cachedPath = join(attDir, `${index}_${safeFileName(a.filename, 'inline')}`);
        await mkdir(attDir, { recursive: true });
        await writeFile(cachedPath, a.content);
      }
      atts.push({
        partId: String(index),
        filename: a.filename ?? null,
        contentType: a.contentType || 'application/octet-stream',
        size: a.size,
        contentId: cid,
        inline,
        cachedPath,
      });
      index++;
    }
    this.ctx.messages.saveBody(
      row.id,
      {
        rawZ: await deflate(source).catch(() => null),
        text,
        html,
        snippet: makeSnippet(text, html),
        attachments: atts,
        ftsBodyText: ftsText(text, html),
      },
      this.ctx.now(),
    );
    // Unsubscribe headers (DESIGN-SPEC 3.13.1): read once, here, while the source is in memory.
    try {
      this.ctx.messages.setListHeaders(row.id, JSON.stringify(readListHeaders(headerPart(source))));
    } catch {
      /* never hold back the message */
    }
    this.ctx.hub.changed({ folderIds: [row.folder_id], updated: [row.id] });
    return this.buildBody(this.requireRow(row.id));
  }

  async rawSource(id: MessageId): Promise<{ source: string }> {
    const row = this.requireRow(id);
    const src = (await this.storedSource(row.id)) ?? (await this.fetchSource(row));
    return { source: src.toString('utf8') };
  }

  /** The raw source kept with the cached body (exact bytes), or null when none is stored. */
  private async storedSource(id: MessageId): Promise<Buffer | null> {
    const z = this.ctx.messages.getRawZ(id);
    if (!z) return null;
    try {
      return await inflate(z);
    } catch {
      return null;
    }
  }

  /**
   * The raw message for "Save as .eml": the exact bytes (no text conversion). A message that was
   * opened before has its source stored on this PC and works offline. Otherwise it comes from the
   * server and needs a connection.
   */
  async sourceBytes(id: MessageId): Promise<{ data: Uint8Array; subject: string }> {
    const row = this.requireRow(id);
    const stored = await this.storedSource(row.id);
    if (stored) return { data: new Uint8Array(stored), subject: row.subject };
    if (!this.sessions.has(row.account_id) || !this.sessions.get(row.account_id).isReady()) {
      throw new AppException(
        'HOST_UNREACHABLE',
        'You are offline. Connect to the internet to save this message.',
        { retryable: true },
      );
    }
    const src = await this.fetchSource(row);
    return { data: new Uint8Array(src), subject: row.subject };
  }

  // ---------- attachments ----------

  async prepareAttachment(attachmentId: number): Promise<PreparedAttachment> {
    const att = this.ctx.messages.attachmentRow(attachmentId);
    if (!att) throw new AppException('NOT_FOUND', 'Attachment not found.');
    const filename = safeFileName(att.filename, `attachment-${att.id}`);
    if (att.cached_path) {
      try {
        const st = await stat(att.cached_path);
        return {
          path: att.cached_path,
          filename,
          size: st.size,
          contentType: att.content_type ?? 'application/octet-stream',
        };
      } catch {
        /* cache file vanished: fetch again */
      }
    }
    const row = this.requireRow(att.message_pk);
    const source = await this.fetchSource(row);
    const parsed = await simpleParser(source, PARSER_OPTIONS);
    const found: Attachment | undefined = parsed.attachments[Number(att.part_id)];
    if (!found) throw new AppException('NOT_FOUND', 'The attachment is no longer in the message.');
    const dir = join(this.ctx.dataDir, 'attachments', row.account_id, String(row.id));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${att.part_id}_${filename}`);
    await writeFile(path, found.content);
    this.ctx.messages.setAttachmentPath(att.id, path);
    return {
      path,
      filename,
      size: found.size,
      contentType: att.content_type ?? found.contentType,
    };
  }

  async cidData(
    messageId: MessageId,
    contentId: string,
  ): Promise<{ contentType: string; data: Uint8Array } | null> {
    const att = this.ctx.messages.attachmentByContentId(messageId, contentId);
    if (!att) return null;
    const prepared = await this.prepareAttachment(att.id);
    if (prepared.size > MAX_CID_BYTES) return null;
    const data = await readFile(prepared.path);
    return { contentType: prepared.contentType, data: new Uint8Array(data) };
  }

  // ---------- images, older mail ----------

  allowSenderImages(address: string, allow: boolean): void {
    if (!address.includes('@')) throw new AppException('INVALID_INPUT', 'Enter an email address.');
    this.ctx.messages.setSenderImagesAllowed(address, allow);
  }

  /** `sync.loadOlder` for one folder, or for every folder behind a list scope. */
  async loadOlder(req: LoadOlderReq): Promise<LoadOlderRes> {
    if (req.folderId !== undefined) return this.loadOlderFolder(req.folderId);
    const folderIds = this.foldersForScope(req.scope!).filter((id) => {
      const st = this.ctx.folders.syncState(id);
      return st && st.uidvalidity !== null && !st.historyComplete;
    });
    let fetched = 0;
    let allDone = true;
    const results = await Promise.allSettled(folderIds.map((id) => this.loadOlderFolder(id)));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        fetched += r.value.fetched;
        if (!r.value.reachedStart) allDone = false;
      } else {
        allDone = false;
      }
    }
    return { fetched, reachedStart: allDone };
  }

  private async loadOlderFolder(folderId: FolderId): Promise<LoadOlderRes> {
    const row = this.ctx.folders.row(folderId);
    if (!row) throw new AppException('NOT_FOUND', 'Folder not found.');
    return this.sessions.get(row.account_id).loadOlderFor(folderId);
  }

  /** Folders that feed a list scope (unified views = every account's inbox). */
  foldersForScope(scope: ListScope): FolderId[] {
    switch (scope.kind) {
      case 'folder':
        return [scope.folderId];
      case 'accountInbox': {
        const r = this.ctx.folders.rowByRole(scope.accountId, 'inbox');
        return r ? [r.id] : [];
      }
      case 'unifiedInbox':
      case 'unifiedUnread':
        return this.ctx.accounts
          .list()
          .map((a) => this.ctx.folders.rowByRole(a.id, 'inbox')?.id)
          .filter((id): id is number => id !== undefined);
      default:
        return [];
    }
  }
}
