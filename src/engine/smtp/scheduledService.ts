// Send later (DESIGN-SPEC 3.11). The finished message is kept on this PC (a file plus a row in
// scheduled_send). One timer is set for the next due time, a watchdog looks every 30 seconds, and the
// check also runs when the PC wakes up, the network or an account comes back, and at start. A due
// message is handed to the normal Outbox (no undo delay), so retries and the "failed" state work
// like for any other message.
//
// Not sending twice: a row is marked 'sending' BEFORE the Outbox row is made. After a crash the
// Outbox row is removed and, 5 minutes later and when the account is online, the Sent folder is
// searched for the Message-ID. Found: the message went out. Not found: it is sent again.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Address,
  AppError,
  ScheduledCancelRes,
  ScheduledCount,
  ScheduledDetail,
  ScheduledItem,
  ScheduledNextDue,
  ScheduleSendReq,
} from '../../shared/ipc';
import { MAX_SCHEDULED } from '../../shared/ipc';
import { AppException, toAppError } from '../../shared/errors';
import type { EngineContext, SchedulerApi } from '../context';
import { ScheduledRepo, type ScheduledRow } from '../db/repos/scheduledRepo';
import type { SessionManager } from '../imap/sessionManager';
import { makeSnippet } from '../messages/bodyUtils';
import type { ComposeService, OutboxMeta } from './composeService';

const DAY_MS = 86_400_000;
/** A message more than this late is not sent by itself (a "see you at 9" that is days old). */
export const HOLD_AFTER_MS = DAY_MS;
/** Late by more than this = Letterdock was not running at the time: tell the user. */
const LATE_NOTICE_MS = 60_000;
const WATCHDOG_MS = 30_000;
/** A message that was being sent when the app stopped is checked after this long. */
export const RECOVER_AFTER_MS = 5 * 60_000;
const MAX_AHEAD_MS = 366 * DAY_MS;
const TIMER_MAX_MS = 6 * 3_600_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseAddrs(json: string): Address[] {
  try {
    return JSON.parse(json) as Address[];
  } catch {
    return [];
  }
}

export class ScheduledService implements SchedulerApi {
  private readonly repo: ScheduledRepo;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Scheduled messages whose Outbox row was made by this process. */
  private active = new Set<number>();
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;

  constructor(
    private readonly ctx: EngineContext,
    private readonly sessions: SessionManager,
    private readonly compose: ComposeService,
  ) {
    this.repo = new ScheduledRepo(ctx.db);
    ctx.scheduler = this;
  }

  // ---------- lifecycle ----------

  /**
   * Before the Outbox re-arms its rows: a message that was on its way when the app stopped has an
   * Outbox row that must not be sent again blindly (it may have gone out already).
   */
  recoverOnStart(): void {
    const sending = new Set(this.repo.byStatus('sending').map((r) => r.id));
    if (sending.size === 0) return;
    this.compose.removeScheduledOutbox((sid, row) => {
      if (!sending.has(sid)) return false;
      if (row.state === 'failed') {
        // It reached the Outbox as a failed item: that is where the user deals with it.
        this.finish(sid);
        return false;
      }
      return true;
    });
  }

  start(): void {
    this.stopped = false;
    this.watchdog = setInterval(() => void this.recheck(), WATCHDOG_MS);
    this.watchdog.unref?.();
    void this.recheck();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }

  /** Wait for the check that is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  // ---------- SchedulerApi (used by the compose code and the sessions) ----------

  protectedTokens(): Set<string> {
    const out = new Set<string>();
    for (const r of this.repo.list()) {
      try {
        for (const t of (JSON.parse(r.meta_json) as OutboxMeta).req.attachmentTokens) out.add(t);
      } catch {
        /* unreadable: nothing to protect */
      }
    }
    return out;
  }

  onOutboxFinished(outboxId: number, scheduledId: number | undefined, ok: boolean, error?: AppError): void {
    const row = scheduledId !== undefined ? this.repo.get(scheduledId) : this.repo.byOutbox(outboxId);
    if (!row) return;
    this.finish(row.id);
    if (!ok) {
      this.ctx.hub.emit({
        type: 'scheduled:failed',
        accountId: row.account_id,
        subject: row.subject,
        outboxId,
        error: error ?? toAppError(new AppException('INTERNAL', 'Could not send the message.')),
      });
    }
  }

  onOutboxCancelled(scheduledId: number): string | null {
    const r = this.repo.get(scheduledId);
    if (!r) return null;
    let draftId: string | null = null;
    try {
      draftId = this.compose.reattachDraft(JSON.parse(r.meta_json) as OutboxMeta);
    } catch (e) {
      this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'could not restore a cancelled scheduled message');
    }
    this.finish(r.id);
    return draftId;
  }

  /** An account is going away: its scheduled messages and their files go with it. */
  async forgetAccount(accountId: string): Promise<void> {
    for (const r of this.repo.list(accountId)) {
      await rm(r.raw_path, { force: true }).catch(() => undefined);
      await this.compose.dropPickedFiles(this.tokensOf(r));
      this.active.delete(r.id);
    }
  }

  recheck(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const p: Promise<void> = this.doCheck()
      .catch((e) => this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'scheduled check failed'))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          void this.recheck();
        } else {
          this.arm();
        }
      });
    this.running = p;
    return p;
  }

  // ---------- reads ----------

  private tokensOf(r: ScheduledRow): string[] {
    try {
      return (JSON.parse(r.meta_json) as OutboxMeta).req.attachmentTokens;
    } catch {
      return [];
    }
  }

  private waitingOf(r: ScheduledRow, now: number): ScheduledItem['waiting'] {
    const due = r.status === 'scheduled' && r.send_at <= now;
    if (!due && r.status !== 'sending') return null;
    if (!this.sessions.has(r.account_id)) return 'offline';
    const state = this.sessions.get(r.account_id).getStatus().state;
    if (state === 'auth_failed' || state === 'needs_reauth') return 'signIn';
    return state === 'online' || state === 'syncing' ? null : 'offline';
  }

  private toItem(r: ScheduledRow, now = this.ctx.now()): ScheduledItem {
    return {
      id: r.id,
      accountId: r.account_id,
      draftId: r.draft_id,
      subject: r.subject,
      to: parseAddrs(r.to_json),
      cc: parseAddrs(r.cc_json),
      snippet: r.snippet,
      hasAttachments: r.has_attachments === 1,
      sendAt: r.send_at,
      createdAt: r.created_at,
      status: r.status,
      waiting: this.waitingOf(r, now),
      lastError: r.last_error,
      attempt: r.attempt,
      overdueMs: Math.max(0, now - r.send_at),
    };
  }

  private require(id: number): ScheduledRow {
    const r = this.repo.get(id);
    if (!r) throw new AppException('NOT_FOUND', 'That scheduled message is no longer there.');
    return r;
  }

  list(accountId?: string): ScheduledItem[] {
    const now = this.ctx.now();
    return this.repo.list(accountId).map((r) => this.toItem(r, now));
  }

  get(id: number): ScheduledDetail {
    const r = this.require(id);
    let meta: OutboxMeta;
    try {
      meta = JSON.parse(r.meta_json) as OutboxMeta;
    } catch {
      throw new AppException('INTERNAL', 'This scheduled message cannot be read.');
    }
    return {
      item: this.toItem(r),
      html: meta.req.html,
      bcc: meta.req.bcc,
      attachments: this.compose
        .attachmentsFor(meta.req.attachmentTokens)
        .map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType })),
    };
  }

  count(): ScheduledCount {
    const per = new Map<string, { total: number; scheduled: number; held: number }>();
    let next: number | null = null;
    let scheduled = 0;
    let held = 0;
    for (const r of this.repo.list()) {
      const p = per.get(r.account_id) ?? { total: 0, scheduled: 0, held: 0 };
      p.total++;
      if (r.status === 'held' || r.status === 'failed') {
        p.held++;
        held++;
      } else {
        p.scheduled++;
        scheduled++;
        if (r.status === 'scheduled' && (next === null || r.send_at < next)) next = r.send_at;
      }
      per.set(r.account_id, p);
    }
    return {
      total: scheduled + held,
      scheduled,
      held,
      nextSendAt: next,
      perAccount: [...per].map(([accountId, v]) => ({ accountId, ...v })),
    };
  }

  nextDue(): ScheduledNextDue {
    const horizon = this.ctx.now() + DAY_MS;
    let count = 0;
    let next: number | null = null;
    for (const r of this.repo.list()) {
      if (r.status !== 'scheduled' && r.status !== 'sending') continue;
      if (r.send_at > horizon) continue;
      count++;
      if (next === null || r.send_at < next) next = r.send_at;
    }
    return { count, nextSendAt: next };
  }

  // ---------- changes ----------

  private changed(): void {
    this.ctx.hub.emit({ type: 'scheduled:changed' });
    if (!this.stopped) this.arm();
  }

  private checkTime(sendAt: number): void {
    const now = this.ctx.now();
    if (sendAt <= now) throw new AppException('INVALID_INPUT', 'Pick a time in the future.');
    if (sendAt > now + MAX_AHEAD_MS) {
      throw new AppException('INVALID_INPUT', "Letterdock can schedule up to one year ahead.");
    }
  }

  async create(req: ScheduleSendReq): Promise<ScheduledItem> {
    if (this.repo.count() >= MAX_SCHEDULED) {
      throw new AppException(
        'INVALID_INPUT',
        `You have ${MAX_SCHEDULED} scheduled messages. Send or cancel some first.`,
      );
    }
    this.checkTime(req.sendAt);
    if (req.draft && req.draft.draftId !== req.draftId) {
      throw new AppException('INVALID_INPUT', 'The message does not belong to this draft.');
    }
    const content = req.draft ?? this.compose.savedContent(req.draftId);
    if (!content) throw new AppException('NOT_FOUND', 'This draft is no longer available.');

    // Same checks as Send; builds the finished mail now (From, signature, quote, attachments).
    const { raw, meta } = await this.compose.buildForSchedule(content);
    const now = this.ctx.now();
    const id = this.repo.insert({
      accountId: content.accountId,
      draftId: content.draftId,
      subject: content.subject,
      toJson: JSON.stringify(content.to),
      ccJson: JSON.stringify(content.cc),
      snippet: makeSnippet(null, content.html),
      hasAttachments: content.attachmentTokens.length > 0,
      sendAt: req.sendAt,
      createdAt: now,
      metaJson: JSON.stringify(meta),
      messageId: meta.messageId,
    });
    const path = join(this.ctx.dataDir, 'scheduled', `${id}.eml`);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw);
    } catch (e) {
      this.repo.delete(id);
      throw new AppException('INTERNAL', 'Could not keep the message for later.', { details: String(e) });
    }
    this.repo.setRawPath(id, path);
    // It is not a draft any more (and is never uploaded to the server Drafts folder).
    this.compose.detachDraft(content.draftId);
    this.changed();
    return this.toItem(this.require(id));
  }

  reschedule(id: number, sendAt: number): ScheduledItem {
    const r = this.require(id);
    if (r.status === 'sending') {
      throw new AppException('CANCELLED', 'The message is already being sent.');
    }
    this.checkTime(sendAt);
    this.repo.update(id, { send_at: sendAt, status: 'scheduled', last_error: null });
    this.changed();
    return this.toItem(this.require(id));
  }

  async sendNow(id: number): Promise<ScheduledItem> {
    const r = this.require(id);
    if (r.status === 'sending') return this.toItem(r);
    await this.dispatch(r);
    return this.toItem(this.require(id));
  }

  /** Remove the schedule. The message is a normal draft again. */
  cancel(id: number): ScheduledCancelRes {
    const r = this.require(id);
    if (r.status === 'sending') {
      throw new AppException('CANCELLED', 'The message is already being sent.');
    }
    const meta = JSON.parse(r.meta_json) as OutboxMeta;
    const draftId = this.compose.reattachDraft(meta);
    this.repo.delete(id);
    void rm(r.raw_path, { force: true }).catch(() => undefined);
    this.changed();
    return { draftId, sendAt: r.send_at };
  }

  async delete(id: number): Promise<void> {
    const r = this.require(id);
    if (r.status === 'sending') {
      throw new AppException('CANCELLED', 'The message is already being sent.');
    }
    this.repo.delete(id);
    await rm(r.raw_path, { force: true }).catch(() => undefined);
    await this.compose.dropPickedFiles(this.tokensOf(r));
    this.changed();
  }

  // ---------- sending ----------

  /** The message has left (or failed for good): forget the plan and its file. */
  private finish(id: number): void {
    const r = this.repo.get(id);
    if (!r) return;
    this.active.delete(id);
    this.repo.delete(id);
    void rm(r.raw_path, { force: true }).catch(() => undefined);
    this.changed();
  }

  /** Mark 'sending' first, then make the Outbox row (see the note at the top). */
  private async dispatch(r: ScheduledRow): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readFile(r.raw_path);
    } catch {
      this.repo.update(r.id, { status: 'failed', last_error: 'The saved message file is missing.' });
      this.changed();
      throw new AppException('NOT_FOUND', 'The saved message is missing. Delete it and write it again.');
    }
    const now = this.ctx.now();
    this.repo.update(r.id, {
      status: 'sending',
      sending_since: now,
      attempt: r.attempt + 1,
      last_error: null,
      outbox_id: null,
    });
    this.active.add(r.id);
    this.ctx.hub.emit({ type: 'scheduled:changed' });
    try {
      const outboxId = await this.compose.enqueueScheduled({
        scheduledId: r.id,
        accountId: r.account_id,
        subject: r.subject,
        meta: JSON.parse(r.meta_json) as OutboxMeta,
        raw,
      });
      // The Outbox may have finished already (a very fast send): then the row is gone.
      if (this.repo.get(r.id)) this.repo.update(r.id, { outbox_id: outboxId });
    } catch (e) {
      this.active.delete(r.id);
      this.repo.update(r.id, { status: 'failed', last_error: toAppError(e).message });
      this.changed();
      throw e;
    }
  }

  private ready(accountId: string): boolean {
    return this.sessions.has(accountId) && this.sessions.get(accountId).isReady();
  }

  private async doCheck(): Promise<void> {
    const now = this.ctx.now();
    let changed = false;

    // 1. Messages that were on their way when the app stopped.
    for (const r of this.repo.byStatus('sending')) {
      if (this.active.has(r.id)) continue;
      const since = r.sending_since ?? 0;
      if (now - since < RECOVER_AFTER_MS) continue;
      await this.verifyAndResume(r);
    }

    // 2. Messages that are due.
    const due = this.repo.byStatus('scheduled').filter((r) => r.send_at <= now);
    const toSend: ScheduledRow[] = [];
    for (const r of due) {
      if (now - r.send_at > HOLD_AFTER_MS) {
        this.repo.update(r.id, { status: 'held' });
        changed = true;
      } else if (this.ready(r.account_id)) {
        toSend.push(r);
      }
      // else: waits for the connection / sign-in (the row says so); the next check tries again.
    }
    if (changed) this.ctx.hub.emit({ type: 'scheduled:changed' });

    const late = toSend.filter((r) => now - r.send_at > LATE_NOTICE_MS);
    if (late.length > 0) {
      this.ctx.hub.emit({ type: 'scheduled:due', count: late.length, ids: late.map((r) => r.id) });
    }
    const spacing = this.ctx.scheduledSpacingMs ?? 2000;
    for (let i = 0; i < toSend.length; i++) {
      if (this.stopped) return;
      if (i > 0) await sleep(spacing);
      const fresh = this.repo.get(toSend[i]!.id);
      if (!fresh || fresh.status !== 'scheduled') continue; // changed meanwhile (cancelled, moved)
      await this.dispatch(fresh).catch((e) =>
        this.ctx.log.warn({ id: fresh.id, err: toAppError(e).message }, 'could not hand over a scheduled message'),
      );
    }
  }

  /** After a crash: did the message reach the Sent folder? Then it went out. Else send it again. */
  private async verifyAndResume(r: ScheduledRow): Promise<void> {
    if (!this.ready(r.account_id)) return; // not online yet: look again later
    const sent = this.ctx.folders.rowByRole(r.account_id, 'sent');
    let found = false;
    if (sent) {
      try {
        found = await this.sessions.get(r.account_id).run('user', async (c) => {
          await c.mailboxOpen(sent.path, { readOnly: true });
          const uids = (await c.search({ header: { 'message-id': r.message_id } }, { uid: true })) || [];
          return uids.length > 0;
        });
      } catch {
        return; // could not look: do not guess, try again at the next check
      }
    }
    if (found) {
      this.ctx.log.info({ id: r.id }, 'scheduled message was sent before the app stopped');
      this.finish(r.id);
      return;
    }
    await this.dispatch(r).catch((e) =>
      this.ctx.log.warn({ id: r.id, err: toAppError(e).message }, 'could not send a scheduled message again'),
    );
  }

  /** One timer for the next time something has to happen. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const now = this.ctx.now();
    let next: number | null = null;
    for (const r of this.repo.byStatus('scheduled')) {
      if (r.send_at > now && (next === null || r.send_at < next)) next = r.send_at;
    }
    for (const r of this.repo.byStatus('sending')) {
      if (this.active.has(r.id)) continue;
      const at = (r.sending_since ?? 0) + RECOVER_AFTER_MS;
      if (at > now && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    const delay = Math.min(Math.max(next - now, 0) + 50, TIMER_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.recheck();
    }, delay);
    this.timer.unref?.();
  }
}
