// Compose, drafts, send and the outbox (ARCHITECTURE 5.7).
//
// Sending is always queued: compose.send stores the finished message in the outbox and starts the
// real SMTP send after the undo-send delay. outbox.cancel inside that window is "Undo send".
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Account,
  Address,
  AttachDataReq,
  ComposeDraft,
  ComposeMode,
  DraftAttachment,
  DraftSyncState,
  MessageBody,
  MessageId,
  OutboxCancelRes,
  OutboxItem,
  PrepareComposeReq,
  SaveDraftRes,
  SendReq,
  SendRes,
} from '../../shared/ipc';
import { AppException, makeError, toAppError } from '../../shared/errors';
import { replaceControlChars } from '../../shared/safety';
import { findProviderByHost } from '../../shared/providers';
import { isValidEmail } from '../accounts/autodiscover';
import type { DraftsApi, EngineContext } from '../context';
import { ComposeRepo, type DraftStateRow, type OutboxRow } from '../db/repos/composeRepo';
import { mapNetworkError } from '../imap/errors';
import type { SessionManager } from '../imap/sessionManager';
import { toSequenceSet } from '../imap/syncDiff';
import { makeSnippet, safeFileName } from '../messages/bodyUtils';
import type { ActionService } from '../messages/actionService';
import type { MessageService } from '../messages/messageService';
import {
  addressList,
  buildRaw,
  forwardSubject,
  generateMessageId,
  initialHtml,
  parseMailto,
  quotableText,
  replyRecipients,
  replyReferences,
  replySubject,
  signatureHtml,
  textToHtml,
  withBccHeader,
} from './mime';
import { createSmtpTransport } from './transport';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Keep only usable addresses: half-typed text such as "dm" must never be stored or shown as a recipient. */
function validOnly(list: Address[] | undefined): Address[] {
  return (list ?? []).filter((a) => isValidEmail(a.address));
}

/** The saved text of a draft, without recipients that are not real addresses. */
function parseContent(json: string): SendReq {
  const c = JSON.parse(json) as SendReq;
  return { ...c, to: validOnly(c.to), cc: validOnly(c.cc), bcc: validOnly(c.bcc) };
}
const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000];
const FILE_KEEP_MS = 14 * 24 * 3600 * 1000;
const DRAFT_PUSH_DELAY_MS = 1500;
const DRAFT_RETRY_MS = 30_000;

export interface OutboxMeta {
  /** Set when the message comes from a scheduled send (DESIGN-SPEC 3.11). */
  scheduledId?: number;
  req: SendReq;
  mode: ComposeMode;
  sourceMessageId: MessageId | null;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
}

export class ComposeService implements DraftsApi {
  private repo: ComposeRepo;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private running = new Set<number>();
  /** OAuth sends that were refused once and get one try with a brand-new access token. */
  private forceRefresh = new Set<number>();
  private refreshTried = new Set<number>();
  private inflight = new Set<Promise<void>>();
  private stopped = false;
  /** Draft uploads: timers, running ones, and the upload state of drafts whose server copy is old. */
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pushing = new Set<string>();
  private syncState = new Map<string, { accountId: string; state: DraftSyncState }>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
    private readonly messages: MessageService,
    private readonly actions: ActionService,
  ) {
    this.repo = new ComposeRepo(ctx.db);
    ctx.drafts = this;
  }

  // ---------- lifecycle ----------

  /** Re-arm unsent messages after a restart and tidy old picked files. */
  start(): void {
    this.stopped = false;
    const now = this.ctx.now();
    for (const row of this.repo.listOutbox()) {
      if (row.state === 'sending') this.repo.updateOutbox(row.id, { state: 'queued' });
      if (row.state !== 'failed') this.schedule(row.id, Math.max(row.send_after, now));
    }
    void this.gcFiles().catch(() => undefined);
    // Drafts that were not uploaded before the app closed: show them as waiting, then upload.
    for (const d of this.repo.dirtyDrafts()) {
      try {
        this.restoreDirty(d);
      } catch (e) {
        this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'could not restore a draft');
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const t of this.pushTimers.values()) clearTimeout(t);
    this.pushTimers.clear();
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Wait for sends in progress (tests). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** The network came back: try queued messages that were waiting for a retry now. */
  onOnline(): void {
    for (const row of this.repo.listOutbox()) {
      if (row.state === 'queued' && row.attempts > 0) this.schedule(row.id, this.ctx.now());
    }
    for (const d of this.repo.dirtyDrafts()) {
      if (this.syncState.get(d.draft_id)?.state !== 'saving') this.schedulePush(d.draft_id, 0);
    }
  }

  private async gcFiles(): Promise<void> {
    const keep = this.ctx.scheduler?.protectedTokens() ?? new Set<string>();
    for (const f of this.repo.filesOlderThan(this.ctx.now() - FILE_KEEP_MS)) {
      if (keep.has(f.token)) continue; // a scheduled message still needs it
      this.repo.deleteFile(f.token);
      await rm(dirname(f.path), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---------- attachments ----------

  private cleanName(name: string): string {
    return replaceControlChars(name).trim().slice(0, 255) || 'attachment';
  }

  /** Copy a file into the data folder and hand out an opaque token (never the path). */
  async registerFile(
    path: string,
    filename: string,
    contentType: string,
  ): Promise<DraftAttachment> {
    const st = await stat(path).catch(() => null);
    if (!st || !st.isFile()) throw new AppException('NOT_FOUND', 'That file could not be found.');
    const name = this.cleanName(filename);
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new AppException('INVALID_INPUT', `"${name}" is larger than 25 MB.`);
    }
    const dir = join(this.ctx.dataDir, 'compose', randomUUID());
    await mkdir(dir, { recursive: true });
    const dest = join(dir, safeFileName(name, 'attachment'));
    await copyFile(path, dest);
    return this.insertFile(dest, name, st.size, contentType);
  }

  async attachData(req: AttachDataReq): Promise<DraftAttachment> {
    if (req.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AppException('INVALID_INPUT', `"${req.filename}" is larger than 25 MB.`);
    }
    const name = this.cleanName(req.filename);
    const dir = join(this.ctx.dataDir, 'compose', randomUUID());
    await mkdir(dir, { recursive: true });
    const dest = join(dir, safeFileName(name, 'attachment'));
    await writeFile(dest, req.data);
    return this.insertFile(dest, name, req.data.byteLength, req.contentType);
  }

  private insertFile(
    path: string,
    filename: string,
    size: number,
    contentType: string,
  ): DraftAttachment {
    const token = `file:${randomUUID()}`;
    const type = contentType.trim() || 'application/octet-stream';
    this.repo.insertFile({
      token,
      path,
      filename,
      size,
      content_type: type,
      created_at: this.ctx.now(),
    });
    return { tokenId: token, filename, size, contentType: type };
  }

  attachmentsFor(tokens: string[]): DraftAttachment[] {
    const out: DraftAttachment[] = [];
    for (const t of tokens) {
      const f = this.repo.file(t);
      if (f) {
        out.push({ tokenId: f.token, filename: f.filename, size: f.size, contentType: f.content_type });
      }
    }
    return out;
  }

  private async forwardAttachments(src: MessageBody): Promise<DraftAttachment[]> {
    const out: DraftAttachment[] = [];
    for (const a of src.attachments) {
      if (a.inline) continue;
      try {
        const prepared = await this.messages.prepareAttachment(a.id);
        out.push(await this.registerFile(prepared.path, prepared.filename, prepared.contentType));
      } catch (e) {
        this.ctx.log.warn({ err: toAppError(e).code }, 'could not copy an attachment for forward');
      }
    }
    return out;
  }

  // ---------- prepare ----------

  private requireAccount(id: string): Account {
    const a = this.ctx.accounts.get(id);
    if (!a) throw new AppException('NOT_FOUND', 'Account not found.');
    return a;
  }

  async prepare(req: PrepareComposeReq): Promise<ComposeDraft> {
    if (req.draftId) return this.reopen(req.draftId);
    if (req.draftMessageId !== undefined) {
      // A draft we wrote ourselves opens from the saved text (full formatting, attachments).
      const own = this.repo.draftByRow(req.draftMessageId);
      if (own?.content_json) return this.reopen(own.draft_id);
      return this.fromServerDraft(req.draftMessageId);
    }

    const mode = req.mode;
    const draftId = randomUUID();
    if (mode === 'new') {
      const account = req.accountId
        ? this.requireAccount(req.accountId)
        : (this.ctx.accounts.list().find((a) => a.enabled) ?? this.ctx.accounts.list()[0]);
      if (!account) throw new AppException('INVALID_INPUT', 'Add an account before writing mail.');
      const mt = req.mailto ? parseMailto(req.mailto) : null;
      let html = initialHtml({ mode: 'new', signature: account.signature });
      if (mt?.body) html = `<p>${textToHtml(mt.body)}</p>` + signatureHtml(account.signature);
      return this.createDraft(
        draftId,
        account,
        'new',
        {
          to: mt?.to ?? [],
          cc: mt?.cc ?? [],
          bcc: mt?.bcc ?? [],
          subject: mt?.subject ?? '',
          html,
          attachments: [],
        },
        null,
        null,
        null,
      );
    }

    if (req.sourceMessageId === undefined) {
      throw new AppException('INVALID_INPUT', 'Choose a message to reply to or forward.');
    }
    const row = this.ctx.messages.row(req.sourceMessageId);
    if (!row) throw new AppException('NOT_FOUND', 'The original message is no longer available.');
    const account = this.requireAccount(row.account_id);
    const src = await this.messages.get(row.id);
    const html = initialHtml({ mode, signature: account.signature, source: src });
    if (mode === 'forward') {
      return this.createDraft(
        draftId,
        account,
        mode,
        {
          to: [],
          cc: [],
          bcc: [],
          subject: forwardSubject(src.header.subject),
          html,
          attachments: await this.forwardAttachments(src),
        },
        row.id,
        null,
        null,
      );
    }
    const own = this.ctx.accounts.list().map((a) => a.email);
    const rcpt = replyRecipients(src, own, mode === 'replyAll');
    return this.createDraft(
      draftId,
      account,
      mode,
      {
        to: rcpt.to,
        cc: rcpt.cc,
        bcc: [],
        subject: replySubject(src.header.subject),
        html,
        attachments: [],
      },
      row.id,
      src.header.messageIdHeader,
      replyReferences({ references: src.references, messageId: src.header.messageIdHeader }),
    );
  }

  private createDraft(
    draftId: string,
    account: Account,
    mode: ComposeMode,
    f: Pick<ComposeDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'html' | 'attachments'>,
    sourcePk: MessageId | null,
    inReplyTo: string | null,
    references: string | null,
    messageId?: string,
  ): ComposeDraft {
    this.repo.upsertDraft({
      draft_id: draftId,
      account_id: account.id,
      mode,
      source_message_pk: sourcePk,
      in_reply_to: inReplyTo,
      references_h: references,
      message_id: messageId ?? generateMessageId(account.email),
      content_json: null,
      server_folder_id: null,
      updated_at: this.ctx.now(),
      local_message_pk: null,
      server_dirty: 0,
      rev: 0,
    });
    return { draftId, accountId: account.id, mode, inReplyToMessageId: sourcePk, ...f };
  }

  /** Reopen a draft that was saved or whose send was undone. */
  private reopen(draftId: string): ComposeDraft {
    const d = this.repo.draft(draftId);
    const content = d?.content_json ? parseContent(d.content_json) : null;
    if (!d || !content) {
      throw new AppException('NOT_FOUND', 'This draft is no longer available.');
    }
    return {
      draftId,
      accountId: d.account_id,
      to: content.to,
      cc: content.cc,
      bcc: content.bcc,
      subject: content.subject,
      html: content.html,
      inReplyToMessageId: d.source_message_pk,
      mode: d.mode as ComposeMode,
      attachments: this.attachmentsFor(content.attachmentTokens),
      pausedSendAt: d.paused_send_at ?? null,
    };
  }

  /** The "scheduling is paused" strip was shown: forget the old time. */
  clearPaused(draftId: string): void {
    this.repo.setPausedSendAt(draftId, null);
  }

  /** Edit a draft message from a Drafts folder. Formatting is reduced to text (safe by design). */
  private async fromServerDraft(messageId: MessageId): Promise<ComposeDraft> {
    const row = this.ctx.messages.row(messageId);
    if (!row) throw new AppException('NOT_FOUND', 'The draft is no longer available.');
    const folder = this.ctx.folders.row(row.folder_id);
    if (folder?.role !== 'drafts') {
      throw new AppException('INVALID_INPUT', 'This message is not a draft.');
    }
    const account = this.requireAccount(row.account_id);
    const src = await this.messages.get(row.id);
    const draftId = randomUUID();
    const draft = this.createDraft(
      draftId,
      account,
      'new',
      {
        to: src.header.to,
        cc: src.header.cc,
        bcc: src.bcc,
        subject: src.header.subject,
        html: `<div>${textToHtml(quotableText(src))}</div>`,
        attachments: await this.forwardAttachments(src),
      },
      null,
      src.inReplyTo,
      src.references,
      src.header.messageIdHeader ?? undefined,
    );
    // This session now owns the draft: older sessions with the same Message-ID are stale.
    const mine = this.repo.draft(draftId)!;
    for (const o of this.repo.draftsByMessageId(account.id, mine.message_id)) {
      if (o.draft_id !== draftId) this.repo.deleteDraft(o.draft_id);
    }
    this.repo.upsertDraft({ ...mine, server_folder_id: folder.id, local_message_pk: row.id });
    return draft;
  }

  // ---------- validation & message building ----------

  private validate(req: SendReq): { account: Account; attachments: DraftAttachment[] } {
    const account = this.requireAccount(req.accountId);
    if (!account.enabled) {
      throw new AppException('INVALID_INPUT', 'This account is turned off.');
    }
    const all = [...req.to, ...req.cc, ...req.bcc];
    if (all.length === 0) throw new AppException('INVALID_INPUT', 'Add at least one recipient.');
    const bad = all.find((a) => !isValidEmail(a.address));
    if (bad) {
      throw new AppException('INVALID_INPUT', `"${bad.address}" is not a valid email address.`);
    }
    const attachments = req.attachmentTokens.map((t) => {
      const f = this.repo.file(t);
      if (!f) throw new AppException('NOT_FOUND', 'An attachment is no longer available. Add it again.');
      return { tokenId: t, filename: f.filename, size: f.size, contentType: f.content_type };
    });
    if (attachments.reduce((n, a) => n + a.size, 0) > MAX_TOTAL_BYTES) {
      throw new AppException('INVALID_INPUT', 'The attachments are larger than 25 MB in total.');
    }
    return { account, attachments };
  }

  private fromAddress(account: Account): Address {
    const name = account.displayName.trim();
    return name && name.toLowerCase() !== account.email.toLowerCase()
      ? { name, address: account.email }
      : { address: account.email };
  }

  private async build(
    req: SendReq,
    account: Account,
    messageId: string,
    inReplyTo: string | null,
    references: string | null,
  ): Promise<Buffer> {
    const files = req.attachmentTokens.map((t) => this.repo.file(t)!).filter(Boolean);
    return buildRaw({
      from: this.fromAddress(account),
      to: req.to,
      cc: req.cc,
      bcc: req.bcc,
      subject: req.subject,
      html: req.html,
      messageId,
      inReplyTo,
      references,
      attachments: files.map((f) => ({
        filename: f.filename,
        path: f.path,
        // Let nodemailer pick the type from the file name when we only know "generic binary".
        contentType: f.content_type === 'application/octet-stream' ? '' : f.content_type,
      })),
    });
  }

  private savesSentCopy(account: Account): boolean {
    const known = findProviderByHost(account.smtp.host) ?? findProviderByHost(account.imap.host);
    if (known) return known.savesSentCopy;
    return account.provider === 'gmail' || account.provider === 'outlook';
  }

  // ---------- drafts ----------

  /**
   * Save a draft. Everything the user must not lose happens at once and without waiting: the text
   * goes into the database and the draft shows in the local Drafts folder. The copy on the server
   * follows in the background (see pushDraft).
   */
  saveDraft(req: SendReq): Promise<SaveDraftRes> {
    try {
      return Promise.resolve(this.saveDraftNow(req));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private saveDraftNow(req: SendReq): SaveDraftRes {
    const account = this.requireAccount(req.accountId);
    const prev = this.repo.draft(req.draftId);
    const messageId = prev?.message_id ?? generateMessageId(account.email);
    // Missing files must not block autosave: skip tokens we no longer know.
    const known = req.attachmentTokens.filter((t) => this.repo.file(t));
    const content: SendReq = {
      ...req,
      to: validOnly(req.to),
      cc: validOnly(req.cc),
      bcc: validOnly(req.bcc),
      attachmentTokens: known,
    };
    const now = this.ctx.now();
    const folder = this.ctx.folders.rowByRole(account.id, 'drafts');
    this.repo.upsertDraft({
      draft_id: req.draftId,
      account_id: account.id,
      mode: prev?.mode ?? 'new',
      source_message_pk: prev?.source_message_pk ?? null,
      in_reply_to: prev?.in_reply_to ?? null,
      references_h: prev?.references_h ?? null,
      message_id: messageId,
      content_json: JSON.stringify(content),
      server_folder_id: prev?.server_folder_id ?? null,
      updated_at: now,
      local_message_pk: prev?.local_message_pk ?? null,
      server_dirty: folder ? 1 : (prev?.server_dirty ?? 0),
      rev: (prev?.rev ?? 0) + 1,
    });
    if (folder) {
      const d = this.repo.draft(req.draftId)!;
      this.showLocal(d, content, account, folder, this.canUpload(account) ? 'saving' : 'queued');
      this.schedulePush(req.draftId, Math.max(0, this.ctx.draftPushDelayMs ?? DRAFT_PUSH_DELAY_MS));
    }
    return { savedAt: now };
  }

  /** Can we talk to the server of this account right now? */
  private canUpload(account: Account): boolean {
    return account.enabled && this.sessions.has(account.id) && this.sessions.get(account.id).isReady();
  }

  /** Create or update the row that shows the draft in the local Drafts folder. */
  private showLocal(
    d: DraftStateRow,
    content: SendReq,
    account: Account,
    folder: { id: number },
    sync: DraftSyncState | null,
  ): number {
    let pk = d.local_message_pk;
    const cur = pk !== null ? this.ctx.messages.row(pk) : null;
    if (!cur || cur.folder_id !== folder.id) {
      // The server copy may be in the list already (synced earlier): take that row over.
      const known = this.ctx.messages
        .serverRowsByMessageId(folder.id, d.message_id)
        .sort((a, b) => b.uid - a.uid)[0];
      pk = known?.id ?? null;
    }
    const res = this.ctx.messages.upsertLocalDraft(
      pk,
      {
        accountId: account.id,
        folderId: folder.id,
        messageId: d.message_id,
        inReplyTo: d.in_reply_to,
        references: d.references_h,
        subject: content.subject,
        from: this.fromAddress(account),
        to: content.to,
        cc: content.cc,
        bcc: content.bcc,
        dateMs: this.ctx.now(),
        hasAttachments: content.attachmentTokens.length > 0,
        snippet: makeSnippet(null, content.html),
        html: content.html,
        sync,
      },
      this.ctx.now(),
    );
    if (res.id !== d.local_message_pk) this.repo.setLocalRow(d.draft_id, res.id);
    this.trackSync(d.draft_id, account.id, sync);
    this.ctx.folders.recomputeCounts(folder.id);
    this.ctx.hub.changed({
      folderIds: [folder.id],
      added: res.created ? [res.id] : [],
      updated: res.created ? [] : [res.id],
    });
    return res.id;
  }

  /** Remember the upload state of a draft and tell the UI when the number of waiting uploads changes. */
  private trackSync(draftId: string, accountId: string, state: DraftSyncState | null): void {
    const before = this.queuedCount(accountId);
    if (state === null || state === 'saved') this.syncState.delete(draftId);
    else this.syncState.set(draftId, { accountId, state });
    if (this.queuedCount(accountId) !== before) {
      this.ctx.hub.emit({
        type: 'pending:count',
        accountId,
        count: (this.ctx.pendingOps?.count(accountId) ?? 0) + this.queuedCount(accountId),
      });
      if (this.sessions.has(accountId)) this.sessions.get(accountId).refreshStatus();
    }
  }

  /** Set the upload state of a draft (row, memory and UI). */
  private setSync(d: DraftStateRow, state: DraftSyncState | null): void {
    this.trackSync(d.draft_id, d.account_id, state);
    const pk = this.repo.draft(d.draft_id)?.local_message_pk ?? null;
    if (pk === null) return;
    const row = this.ctx.messages.row(pk);
    if (!row) return;
    const want = state === 'saved' ? null : state;
    if (row.draft_sync === want) return;
    this.ctx.messages.setDraftSync([pk], want);
    this.ctx.hub.changed({ folderIds: [row.folder_id], updated: [pk] });
  }

  private restoreDirty(d: DraftStateRow): void {
    const account = this.ctx.accounts.get(d.account_id);
    const folder = this.ctx.folders.rowByRole(d.account_id, 'drafts');
    const content = d.content_json ? parseContent(d.content_json) : null;
    if (!account || !folder || !content) return;
    this.showLocal(d, content, account, folder, 'queued');
    this.schedulePush(d.draft_id, 0);
  }

  // ---------- draft upload ----------

  private schedulePush(draftId: string, delay: number): void {
    if (this.stopped) return;
    const old = this.pushTimers.get(draftId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.pushTimers.delete(draftId);
      const p: Promise<void> = this.pushDraft(draftId)
        .catch(() => undefined)
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }, delay);
    this.pushTimers.set(draftId, t);
  }

  /**
   * Put the newest text of a draft on the server (APPEND), replace older copies, and link the local
   * row to the new server copy. Offline: the draft is marked "queued" and goes out when the account
   * is online again. Other failures: marked "failed" and tried again later.
   */
  private async pushDraft(draftId: string): Promise<void> {
    const d = this.repo.draft(draftId);
    if (!d || d.server_dirty !== 1 || !d.content_json || this.pushing.has(draftId) || this.stopped) return;
    const account = this.ctx.accounts.get(d.account_id);
    const folder = this.ctx.folders.rowByRole(d.account_id, 'drafts');
    if (!account || !folder) {
      this.repo.upsertDraft({ ...d, server_dirty: 0 });
      this.trackSync(draftId, d.account_id, null);
      return;
    }
    const session = this.sessions.has(account.id) ? this.sessions.get(account.id) : null;
    if (!session || !this.canUpload(account)) {
      this.setSync(d, 'queued');
      return;
    }
    this.setSync(d, 'saving');
    this.pushing.add(draftId);
    const rev = d.rev;
    try {
      const content = parseContent(d.content_json);
      const raw = withBccHeader(
        await this.build(content, account, d.message_id, d.in_reply_to, d.references_h),
        content.bcc,
      );
      const uid = await session.run('user', async (c) => {
        const res = await c.append(folder.path, raw, ['\\Draft', '\\Seen'], new Date());
        const keep = res ? (res as { uid?: number }).uid : undefined;
        await c.mailboxOpen(folder.path);
        const same = (await c.search({ header: { 'message-id': d.message_id } }, { uid: true })) || [];
        const old = same.filter((u) => u !== keep);
        // Without UIDPLUS we cannot tell which copy is new: keep the highest UID.
        const newest = same.length > 0 ? Math.max(...same) : undefined;
        const drop = keep === undefined ? old.filter((u) => u !== newest) : old;
        if (drop.length > 0) await c.messageDelete(toSequenceSet(drop), { uid: true });
        return keep ?? newest;
      });
      this.finishPush(d, rev, folder.id, uid);
      void session.syncFolderById(folder.id, 'background').catch(() => undefined);
    } catch (e) {
      const cur = this.repo.draft(draftId);
      const err = mapNetworkError(e);
      this.ctx.log.debug({ code: err.code }, 'draft not saved to server yet (kept locally)');
      if (cur) {
        const ready = session.isReady();
        this.setSync(cur, ready ? 'failed' : 'queued');
        if (ready) {
          this.schedulePush(draftId, Math.max(0, this.ctx.draftRetryMs ?? DRAFT_RETRY_MS));
        }
      }
    } finally {
      this.pushing.delete(draftId);
      const cur = this.repo.draft(draftId);
      // Saved again while the upload was running: upload the newer text too.
      if (cur && cur.server_dirty === 1 && cur.rev !== rev && !this.pushTimers.has(draftId)) {
        this.schedulePush(draftId, 0);
      }
    }
  }

  /** The server has save number `rev`: link the local row to it and clear the "waiting" mark. */
  private finishPush(d: DraftStateRow, rev: number, folderId: number, uid: number | undefined): void {
    const cur = this.repo.draft(d.draft_id);
    if (!cur) {
      // Discarded while the upload ran: take the copy we just made off the server again.
      void this.removeServerDraft({ ...d, server_folder_id: folderId }).catch(() => undefined);
      return;
    }
    const removed: number[] = [];
    let pk: number | null = null;
    this.ctx.db.transaction(() => {
      pk = cur.local_message_pk;
      const row = pk !== null ? this.ctx.messages.row(pk) : null;
      if (!row || row.folder_id !== folderId) {
        const account = this.ctx.accounts.get(cur.account_id);
        const content = cur.content_json ? parseContent(cur.content_json) : null;
        pk = account && content ? this.showLocal(cur, content, account, { id: folderId }, 'saving') : null;
      }
      if (uid !== undefined && pk !== null) {
        // Older copies are gone from the server now. A row at the new UID (a sync may have added
        // it already) is a second row for the same draft.
        for (const r of this.ctx.messages.serverRowsByMessageId(folderId, cur.message_id)) {
          if (r.id !== pk) {
            this.ctx.messages.deleteById(r.id);
            removed.push(r.id);
          }
        }
        const other = this.ctx.messages.idAt(folderId, uid);
        if (other !== null && other !== pk) {
          this.ctx.messages.deleteById(other);
          removed.push(other);
        }
        this.ctx.messages.relocate(pk, folderId, uid);
      }
      const clean = this.repo.markClean(d.draft_id, rev, folderId);
      if (!clean) this.repo.setServerFolder(d.draft_id, folderId);
      if (pk !== null) {
        this.ctx.messages.setDraftSync([pk], clean ? null : 'saving');
        this.trackSync(d.draft_id, cur.account_id, clean ? null : 'saving');
      }
    })();
    if (pk !== null) {
      this.ctx.folders.recomputeCounts(folderId);
      this.ctx.hub.changed({ folderIds: [folderId], updated: [pk], removed });
    }
  }

  // ---------- DraftsApi ----------

  queuedCount(accountId: string): number {
    let n = 0;
    for (const v of this.syncState.values()) if (v.accountId === accountId && v.state === 'queued') n++;
    return n;
  }

  /** The account is online: upload its waiting drafts. */
  async flush(accountId: string): Promise<void> {
    for (const d of this.repo.dirtyDrafts()) {
      if (d.account_id !== accountId) continue;
      const t = this.pushTimers.get(d.draft_id);
      if (t) clearTimeout(t);
      this.pushTimers.delete(d.draft_id);
      await this.pushDraft(d.draft_id);
    }
  }

  /** "Retry" on a draft row. */
  retrySave(messageId: MessageId): void {
    const d = this.repo.draftByRow(messageId);
    if (d && d.server_dirty === 1) this.schedulePush(d.draft_id, 0);
  }

  reconcile(folderId: number, addedIds: number[]): number[] {
    const removed: number[] = [];
    for (const id of addedIds) {
      const row = this.ctx.messages.row(id);
      if (!row?.message_id) continue;
      for (const d of this.repo.draftsByMessageId(row.account_id, row.message_id)) {
        if (d.local_message_pk === id) continue;
        if (d.server_dirty === 1) {
          // Our newer text has not reached the server yet: the server copy is an older version.
          this.ctx.messages.deleteById(id);
          removed.push(id);
        } else {
          // The server copy is the newest: it replaces the row we showed before.
          const old = d.local_message_pk;
          const oldRow = old !== null ? this.ctx.messages.row(old) : null;
          if (old !== null && oldRow && oldRow.folder_id === folderId && old !== id) {
            this.ctx.messages.deleteById(old);
            this.ctx.hub.changed({ folderIds: [folderId], removed: [old] });
          }
          this.repo.setLocalRow(d.draft_id, id);
        }
        break;
      }
    }
    if (removed.length > 0) this.ctx.folders.recomputeCounts(folderId);
    return removed;
  }

  isLocalDraft(messageId: number): boolean {
    const row = this.ctx.messages.row(messageId);
    if (!row || row.uid > 0 || this.repo.draftByRow(messageId) === null) return false;
    return this.ctx.folders.row(row.folder_id)?.role === 'drafts';
  }

  async discardRow(messageId: number): Promise<void> {
    const d = this.repo.draftByRow(messageId);
    if (d) await this.discard(d.draft_id);
  }

  /** Forget a draft: local state, picked files and the server copy. */
  async discard(draftId: string): Promise<void> {
    const d = this.repo.draft(draftId);
    if (!d) return;
    const content = d.content_json ? parseContent(d.content_json) : null;
    this.forgetLocal(d);
    if (content) await this.dropFiles(content.attachmentTokens);
    if (d.server_folder_id !== null) {
      void this.removeServerDraft(d).catch(() => undefined);
    }
  }

  /** Delete the draft state and its row in the local Drafts folder. */
  private forgetLocal(d: DraftStateRow): void {
    const t = this.pushTimers.get(d.draft_id);
    if (t) clearTimeout(t);
    this.pushTimers.delete(d.draft_id);
    this.repo.deleteDraft(d.draft_id);
    this.trackSync(d.draft_id, d.account_id, null);
    if (d.local_message_pk !== null) {
      const row = this.ctx.messages.row(d.local_message_pk);
      if (row) {
        this.ctx.messages.deleteById(row.id);
        this.ctx.folders.recomputeCounts(row.folder_id);
        this.ctx.hub.changed({ folderIds: [row.folder_id], removed: [row.id] });
      }
    }
  }

  private async removeServerDraft(d: DraftStateRow): Promise<void> {
    const folder = d.server_folder_id !== null ? this.ctx.folders.row(d.server_folder_id) : null;
    if (!folder) return;
    await this.sessions.get(d.account_id).run('user', async (c) => {
      await c.mailboxOpen(folder.path);
      const uids = (await c.search({ header: { 'message-id': d.message_id } }, { uid: true })) || [];
      if (uids.length > 0) await c.messageDelete(toSequenceSet(uids), { uid: true });
    });
    void this.sessions.get(d.account_id).syncFolderById(folder.id, 'background').catch(() => undefined);
  }

  private async dropFiles(tokens: string[]): Promise<void> {
    for (const t of tokens) {
      const f = this.repo.file(t);
      if (!f) continue;
      this.repo.deleteFile(t);
      await rm(dirname(f.path), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---------- send & outbox ----------

  async send(req: SendReq): Promise<SendRes> {
    const { account } = this.validate(req);
    const d = this.repo.draft(req.draftId);
    const messageId = d?.message_id ?? generateMessageId(account.email);
    const inReplyTo = d?.in_reply_to ?? null;
    const references = d?.references_h ?? null;
    const raw = await this.build(req, account, messageId, inReplyTo, references);

    const now = this.ctx.now();
    const delay = Math.max(0, this.ctx.settings().undoSendDelayMs ?? 0);
    const sendAt = now + delay;
    const meta: OutboxMeta = {
      req,
      mode: (d?.mode as ComposeMode) ?? 'new',
      sourceMessageId: d?.source_message_pk ?? null,
      messageId,
      inReplyTo,
      references,
    };
    const id = this.repo.insertOutbox({
      accountId: account.id,
      subject: req.subject,
      sendAfter: sendAt,
      metaJson: JSON.stringify(meta),
      createdAt: now,
    });
    const rawPath = join(this.ctx.dataDir, 'outbox', `${id}.eml`);
    try {
      await mkdir(dirname(rawPath), { recursive: true });
      await writeFile(rawPath, raw);
    } catch (e) {
      this.repo.deleteOutbox(id);
      throw new AppException('INTERNAL', 'Could not queue the message.', { details: String(e) });
    }
    this.repo.setOutboxPath(id, rawPath);
    // Keep the editor content so "Undo send" can bring the draft back.
    this.repo.upsertDraft({
      draft_id: req.draftId,
      account_id: account.id,
      mode: meta.mode,
      source_message_pk: meta.sourceMessageId,
      in_reply_to: inReplyTo,
      references_h: references,
      message_id: messageId,
      content_json: JSON.stringify(req),
      server_folder_id: d?.server_folder_id ?? null,
      updated_at: now,
      local_message_pk: d?.local_message_pk ?? null,
      server_dirty: d?.server_dirty ?? 0,
      rev: d?.rev ?? 0,
    });
    this.ctx.hub.emit({ type: 'outbox:changed' });
    this.schedule(id, sendAt);
    return { outboxId: id, state: 'queued', sendAt };
  }

  // ---------- send later (ScheduledService, DESIGN-SPEC 3.11) ----------

  /** Check a message like Send does and build the finished mail now. This freezes From, signature, quote and attachments. */
  async buildForSchedule(req: SendReq): Promise<{ account: Account; raw: Buffer; meta: OutboxMeta }> {
    const { account } = this.validate(req);
    const d = this.repo.draft(req.draftId);
    const messageId = d?.message_id ?? generateMessageId(account.email);
    const inReplyTo = d?.in_reply_to ?? null;
    const references = d?.references_h ?? null;
    const raw = await this.build(req, account, messageId, inReplyTo, references);
    const meta: OutboxMeta = {
      req,
      mode: (d?.mode as ComposeMode) ?? 'new',
      sourceMessageId: d?.source_message_pk ?? null,
      messageId,
      inReplyTo,
      references,
    };
    return { account, raw, meta };
  }

  /** The text saved for a compose session (autosave or undo send), if there is one. */
  savedContent(draftId: string): SendReq | null {
    const d = this.repo.draft(draftId);
    return d?.content_json ? parseContent(d.content_json) : null;
  }

  /**
   * Scheduling takes the message out of Drafts (local row and server copy). The picked files stay:
   * the schedule uses them for Edit / Cancel.
   */
  detachDraft(draftId: string): void {
    const d = this.repo.draft(draftId);
    if (!d) return;
    this.forgetLocal(d);
    if (d.server_folder_id !== null) void this.removeServerDraft(d).catch(() => undefined);
  }

  /** A cancelled schedule is a normal draft again: shown in Drafts and uploaded in the background. */
  reattachDraft(meta: OutboxMeta, pausedSendAt: number | null = null): string {
    const req = meta.req;
    this.repo.upsertDraft({
      draft_id: req.draftId,
      account_id: req.accountId,
      mode: meta.mode,
      source_message_pk: meta.sourceMessageId,
      in_reply_to: meta.inReplyTo,
      references_h: meta.references,
      message_id: meta.messageId,
      content_json: JSON.stringify(req),
      server_folder_id: null,
      updated_at: this.ctx.now(),
      local_message_pk: null,
      server_dirty: 0,
      rev: 0,
    });
    this.repo.setPausedSendAt(req.draftId, pausedSendAt);
    this.saveDraftNow(req);
    return req.draftId;
  }

  /** Hand a scheduled message to the Outbox. It leaves at once (no undo-send delay). */
  async enqueueScheduled(a: {
    scheduledId: number;
    accountId: string;
    subject: string;
    meta: OutboxMeta;
    raw: Buffer;
    /** The history of an earlier Outbox row of this message (kept over a restart). */
    attempts?: number;
    lastError?: string | null;
  }): Promise<number> {
    const now = this.ctx.now();
    const meta: OutboxMeta = { ...a.meta, scheduledId: a.scheduledId };
    const id = this.repo.insertOutbox({
      accountId: a.accountId,
      subject: a.subject,
      sendAfter: now,
      metaJson: JSON.stringify(meta),
      createdAt: now,
      attempts: a.attempts,
      lastError: a.lastError,
    });
    const rawPath = join(this.ctx.dataDir, 'outbox', `${id}.eml`);
    try {
      await mkdir(dirname(rawPath), { recursive: true });
      await writeFile(rawPath, a.raw);
    } catch (e) {
      this.repo.deleteOutbox(id);
      throw new AppException('INTERNAL', 'Could not queue the message.', { details: String(e) });
    }
    this.repo.setOutboxPath(id, rawPath);
    this.ctx.hub.emit({ type: 'outbox:changed' });
    this.schedule(id, now);
    return id;
  }

  /** Remove Outbox rows that belong to scheduled sends (startup: the scheduler decides what to do with them). */
  removeScheduledOutbox(filter: (scheduledId: number, row: OutboxRow) => boolean): void {
    for (const row of this.repo.listOutbox()) {
      let sid: number | undefined;
      try {
        sid = (JSON.parse(row.meta_json ?? '{}') as OutboxMeta).scheduledId;
      } catch {
        continue;
      }
      if (sid === undefined || !filter(sid, row)) continue;
      const t = this.timers.get(row.id);
      if (t) clearTimeout(t);
      this.timers.delete(row.id);
      this.repo.deleteOutbox(row.id);
      void rm(row.raw_path, { force: true }).catch(() => undefined);
    }
  }

  /** Forget picked files (their schedule is gone). */
  async dropPickedFiles(tokens: string[]): Promise<void> {
    await this.dropFiles(tokens);
  }

  list(): OutboxItem[] {
    return this.repo.listOutbox().map((r) => ({
      id: r.id,
      accountId: r.account_id,
      subject: r.subject,
      state: r.state,
      lastError: r.last_error,
      sendAt: r.send_after,
      attempts: r.attempts,
    }));
  }

  retry(id: number): void {
    const row = this.requireOutbox(id);
    if (row.state === 'sending') return;
    this.repo.updateOutbox(id, { state: 'queued', attempts: 0, last_error: null, send_after: this.ctx.now() });
    this.ctx.hub.emit({ type: 'outbox:changed' });
    this.schedule(id, this.ctx.now());
  }

  async cancel(id: number): Promise<OutboxCancelRes> {
    const row = this.requireOutbox(id);
    if (row.state === 'sending' || this.running.has(id)) {
      throw new AppException('CANCELLED', 'The message is already being sent.');
    }
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as OutboxMeta) : null;
    this.repo.deleteOutbox(id);
    await rm(row.raw_path, { force: true }).catch(() => undefined);
    this.ctx.hub.emit({ type: 'outbox:changed' });
    let draftId = meta && this.repo.draft(meta.req.draftId) ? meta.req.draftId : null;
    // A scheduled message that was cancelled on its way: the schedule is over, it is a draft again.
    if (meta?.scheduledId !== undefined) {
      draftId = this.ctx.scheduler?.onOutboxCancelled(meta.scheduledId) ?? draftId;
    }
    return { draftId };
  }

  private requireOutbox(id: number): OutboxRow {
    const row = this.repo.outbox(id);
    if (!row) throw new AppException('NOT_FOUND', 'That message is no longer in the outbox.');
    return row;
  }

  private schedule(id: number, at: number): void {
    if (this.stopped) return;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const wait = Math.max(0, at - this.ctx.now());
    const t = setTimeout(() => {
      this.timers.delete(id);
      const p = this.attempt(id).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }, wait);
    this.timers.set(id, t);
  }

  private async attempt(id: number): Promise<void> {
    const row = this.repo.outbox(id);
    if (!row || this.running.has(id) || row.state === 'failed') return;
    this.running.add(id);
    this.repo.updateOutbox(id, { state: 'sending' });
    this.ctx.hub.emit({ type: 'outbox:changed' });
    const meta = JSON.parse(row.meta_json ?? '{}') as OutboxMeta;
    const account = this.ctx.accounts.get(row.account_id);
    try {
      if (!account) throw new AppException('NOT_FOUND', 'The account was removed.');
      const raw = await readFile(row.raw_path);
      const cred = await this.ctx.secrets.getCredential(account.id, this.forceRefresh.delete(id));
      const transport = createSmtpTransport(account.smtp, account.username, cred, this.ctx);
      let rejected: string[] = [];
      try {
        const info = await transport.sendMail({
          envelope: {
            from: account.email,
            to: addressList(meta.req.to, meta.req.cc, meta.req.bcc),
          },
          raw,
        });
        rejected = ((info.rejected ?? []) as (string | { address: string })[]).map((r) =>
          typeof r === 'string' ? r : r.address,
        );
      } finally {
        transport.close();
      }
      await this.afterSent(row, meta, account, raw, rejected);
    } catch (e) {
      this.afterFailure(row, e);
    } finally {
      this.running.delete(id);
    }
  }

  private async afterSent(
    row: OutboxRow,
    meta: OutboxMeta,
    account: Account,
    raw: Buffer,
    rejected: string[],
  ): Promise<void> {
    // The people we wrote to become the best autocomplete suggestions at once. (The mark keeps the
    // Sent-folder copy that arrives later from being counted a second time.)
    try {
      this.ctx.contacts.recordSent(
        account.id,
        [...meta.req.to, ...meta.req.cc, ...meta.req.bcc],
        meta.messageId,
      );
    } catch (e) {
      this.ctx.log.debug({ err: String((e as Error)?.message ?? e) }, 'contacts update failed');
    }
    // Keep a copy in Sent unless the provider already does (Gmail, Outlook / Microsoft 365).
    if (!this.savesSentCopy(account)) {
      const sent = this.ctx.folders.rowByRole(account.id, 'sent');
      if (sent) {
        try {
          const copy = withBccHeader(raw, meta.req.bcc);
          await this.sessions.get(account.id).run('user', async (c) => {
            await c.append(sent.path, copy, ['\\Seen'], new Date());
          });
          void this.sessions.get(account.id).syncFolderById(sent.id, 'background').catch(() => undefined);
        } catch (e) {
          this.ctx.log.warn({ code: toAppError(e).code }, 'sent, but could not save a copy in Sent');
        }
      }
    }
    if (meta.sourceMessageId !== null && meta.mode !== 'new') {
      this.actions.markReplied(meta.sourceMessageId, meta.mode === 'forward' ? 'forwarded' : 'answered');
    }
    const d = this.repo.draft(meta.req.draftId);
    this.repo.deleteOutbox(row.id);
    await rm(row.raw_path, { force: true }).catch(() => undefined);
    await this.dropFiles(meta.req.attachmentTokens);
    if (d) {
      this.forgetLocal(d);
      if (d.server_folder_id !== null) void this.removeServerDraft(d).catch(() => undefined);
    }
    this.ctx.hub.emit({ type: 'outbox:changed' });
    this.ctx.scheduler?.onOutboxFinished(row.id, meta.scheduledId, true);
    this.ctx.hub.emit({
      type: 'send:result',
      outboxId: row.id,
      ok: true,
      ...(rejected.length > 0
        ? {
            error: toAppError(
              new AppException(
                'SERVER_REJECTED',
                `Sent, but the server refused these addresses: ${rejected.join(', ')}`,
              ),
            ),
          }
        : {}),
    });
  }

  private afterFailure(row: OutboxRow, e: unknown): void {
    let err = mapNetworkError(e, 'smtp');
    const oauth = this.ctx.accounts.get(row.account_id)?.authType === 'oauth2';
    if (oauth && err.code === 'AUTH_FAILED') {
      if (!this.refreshTried.has(row.id)) {
        // The access token may just be stale: try once more with a new one.
        this.refreshTried.add(row.id);
        this.forceRefresh.add(row.id);
        this.repo.updateOutbox(row.id, { state: 'queued', send_after: this.ctx.now() });
        this.ctx.hub.emit({ type: 'outbox:changed' });
        this.schedule(row.id, this.ctx.now());
        return;
      }
      err = makeError('OAUTH_REAUTH_REQUIRED', 'Microsoft did not accept the sign-in. Sign in again.', {
        details: err.details,
      });
    }
    if (err.code === 'OAUTH_REAUTH_REQUIRED') {
      this.ctx.hub.emit({ type: 'account:authRequired', accountId: row.account_id, reason: 'oauth' });
    }
    const attempts = row.attempts + 1;
    this.ctx.log.warn({ outboxId: row.id, code: err.code, attempts }, 'send failed');
    const delays = this.ctx.sendRetryDelaysMs ?? RETRY_DELAYS_MS;
    if (err.retryable && attempts <= delays.length && !this.stopped) {
      const at = this.ctx.now() + delays[attempts - 1]!;
      this.repo.updateOutbox(row.id, {
        state: 'queued',
        attempts,
        last_error: err.message,
        send_after: at,
      });
      this.ctx.hub.emit({ type: 'outbox:changed' });
      this.schedule(row.id, at);
      return;
    }
    this.repo.updateOutbox(row.id, { state: 'failed', attempts, last_error: err.message });
    this.ctx.hub.emit({ type: 'outbox:changed' });
    this.ctx.hub.emit({ type: 'send:result', outboxId: row.id, ok: false, error: err });
    let scheduledId: number | undefined;
    try {
      scheduledId = (JSON.parse(row.meta_json ?? '{}') as OutboxMeta).scheduledId;
    } catch {
      /* no meta */
    }
    this.ctx.scheduler?.onOutboxFinished(row.id, scheduledId, false, err);
  }
}
