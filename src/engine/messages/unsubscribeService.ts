// Unsubscribe (DESIGN-SPEC 3.13.1). The engine only reads headers and keeps the memory of what the
// user did; the network request itself is made by main (see src/main/unsubscribe).
//
// The four headers are read when a message body is downloaded (MessageService.fetchAndCache) and kept
// as a small JSON next to the body. `info` is then one primary-key read on `body` and one on
// `unsubscribed`; messages downloaded before this version are read from the stored raw source once.
import { promisify } from 'node:util';
import { inflate as inflateCb } from 'node:zlib';
import type {
  ApplyActionRes,
  MessageId,
  UnsubscribeInfo,
  UnsubscribeMethod,
  UnsubscribeMethodKind,
} from '../../shared/ipc';
import { AppException } from '../../shared/errors';
import {
  evaluateAuth,
  isOneClick,
  parseListId,
  parseListUnsubscribe,
  readListHeaders,
  type ListHeaders,
} from '../../shared/listUnsubscribe';
import type { EngineContext } from '../context';
import type { MessageRow } from '../db/repos/messageRepo';
import type { ComposeService } from '../smtp/composeService';
import type { ActionService } from './actionService';
import type { MessageService } from './messageService';

const inflate = promisify(inflateCb);
const KEEP_RECORDS = 2000;

/** The header block of a raw message (before the first blank line). */
export function headerPart(source: Uint8Array): Uint8Array {
  const buf = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const a = buf.indexOf('\r\n\r\n');
  const b = buf.indexOf('\n\n');
  const ends = [a, b].filter((x) => x >= 0);
  return ends.length > 0 ? buf.subarray(0, Math.min(...ends)) : buf.subarray(0, Math.min(buf.length, 64 * 1024));
}

export class UnsubscribeService {
  constructor(
    private readonly ctx: EngineContext,
    private readonly messages: MessageService,
    private readonly compose: ComposeService,
    private readonly actions: ActionService,
  ) {}

  private requireRow(id: MessageId): MessageRow {
    const row = this.ctx.messages.row(id);
    if (!row) throw new AppException('NOT_FOUND', 'This message is no longer available.');
    return row;
  }

  /** The stored headers, reading them from the stored source (or downloading the message) if needed. */
  private async headersOf(row: MessageRow): Promise<ListHeaders> {
    let json = this.ctx.messages.listHeaders(row.id);
    if (json === undefined) {
      // Not downloaded yet: opening it stores the headers.
      await this.messages.get(row.id);
      json = this.ctx.messages.listHeaders(row.id);
    }
    if (json === null || json === undefined) {
      // Downloaded by an older version: read the stored source (or ask the server) once.
      let headerText: string | null = null;
      const z = this.ctx.messages.getRawZ(row.id);
      if (z) {
        try {
          headerText = new TextDecoder('latin1').decode(headerPart(await inflate(z)));
        } catch {
          headerText = null;
        }
      }
      if (headerText === null) {
        try {
          headerText = (await this.messages.rawSource(row.id)).source;
        } catch {
          return {}; // offline: try again next time
        }
      }
      json = JSON.stringify(readListHeaders(headerText));
      this.ctx.messages.setListHeaders(row.id, json);
    }
    try {
      return JSON.parse(json) as ListHeaders;
    } catch {
      return {};
    }
  }

  async info(messageId: MessageId): Promise<UnsubscribeInfo> {
    const row = this.requireRow(messageId);
    const h = await this.headersOf(row);
    const parsed = parseListUnsubscribe(h.lu);
    const sender = row.from_addr ? row.from_addr.toLowerCase() : null;
    const listId = parseListId(h.lid);
    const listKey = listId?.id ?? sender;
    const methods: UnsubscribeMethod[] = [];
    const first = parsed.https[0];
    if (first && isOneClick(h.lup)) methods.push({ kind: 'one-click', host: new URL(first).hostname });
    if (parsed.mailto[0]) {
      methods.push({ kind: 'mailto', address: parsed.mailto[0].address, subject: parsed.mailto[0].subject });
    }
    if (first) methods.push({ kind: 'page', host: new URL(first).hostname });
    const auth = evaluateAuth(h.ar, row.from_addr);
    const info: UnsubscribeInfo = {
      available: methods.length > 0 && auth !== 'failed',
      methods,
      auth,
      listKey,
      listName: listId?.name ?? row.from_name ?? null,
      sender,
    };
    if (methods.length > 0 && listKey) {
      const prev = this.ctx.db
        .prepare('SELECT at, method FROM unsubscribed WHERE account_id = ? AND list_key = ?')
        .get(row.account_id, listKey) as { at: number; method: UnsubscribeMethodKind } | undefined;
      if (prev) {
        info.previous = { at: prev.at, method: prev.method };
        info.previouslyUnsubscribedAt = prev.at;
      }
    }
    return info;
  }

  /** For main: the real addresses (the renderer never sees them). Refuses a sender whose check failed. */
  async targets(messageId: MessageId): Promise<{
    auth: 'verified' | 'unknown' | 'failed';
    oneClickUrl: string | null;
    pageUrl: string | null;
    mailto: { address: string; subject: string; body: string } | null;
  }> {
    const row = this.requireRow(messageId);
    const h = await this.headersOf(row);
    const parsed = parseListUnsubscribe(h.lu);
    const first = parsed.https[0] ?? null;
    return {
      auth: evaluateAuth(h.ar, row.from_addr),
      oneClickUrl: first && isOneClick(h.lup) ? first : null,
      pageUrl: first,
      mailto: parsed.mailto[0] ?? null,
    };
  }

  /** Remember a successful unsubscribe (or an opened page). Keeps the last 2000. */
  async record(messageId: MessageId, method: UnsubscribeMethodKind): Promise<void> {
    const row = this.requireRow(messageId);
    const h = await this.headersOf(row);
    const sender = row.from_addr ? row.from_addr.toLowerCase() : '';
    const listId = parseListId(h.lid);
    const listKey = listId?.id ?? sender;
    if (!listKey) return;
    const db = this.ctx.db;
    db.prepare(
      `INSERT INTO unsubscribed (account_id, list_key, sender, list_name, method, at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(account_id, list_key) DO UPDATE SET sender = excluded.sender, list_name = excluded.list_name,
         method = excluded.method, at = excluded.at`,
    ).run(row.account_id, listKey, sender, listId?.name ?? row.from_name ?? null, method, this.ctx.now());
    const n = (db.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get() as { n: number }).n;
    if (n > KEEP_RECORDS) {
      db.prepare(
        `DELETE FROM unsubscribed WHERE (account_id, list_key) IN
           (SELECT account_id, list_key FROM unsubscribed ORDER BY at ASC LIMIT ?)`,
      ).run(n - KEEP_RECORDS);
    }
  }

  forgetHistory(): { removed: number } {
    const r = this.ctx.db.prepare('DELETE FROM unsubscribed').run();
    return { removed: r.changes };
  }

  /** Send the unsubscribe email from the account that received the message, at once. */
  async sendMailto(req: { messageId: MessageId; address: string; subject: string; body: string }): Promise<void> {
    const row = this.requireRow(req.messageId);
    const t = await this.targets(req.messageId);
    // Only the address from the message's own header is allowed, whatever the caller says.
    if (!t.mailto || t.mailto.address.toLowerCase() !== req.address.trim().toLowerCase()) {
      throw new AppException('INVALID_INPUT', 'That address is not the unsubscribe address of this message.');
    }
    if (t.auth === 'failed') {
      throw new AppException('INVALID_INPUT', 'We can’t confirm who sent this message.');
    }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = (t.mailto.body || 'Please unsubscribe me from this list.').split(/\r?\n/).map(esc).join('<br>');
    await this.compose.send(
      {
        draftId: `unsub-${row.id}-${this.ctx.now()}`,
        accountId: row.account_id,
        to: [{ address: t.mailto.address }],
        cc: [],
        bcc: [],
        subject: t.mailto.subject,
        html: `<div>${body}</div>`,
        attachmentTokens: [],
      },
      { noDelay: true },
    );
  }

  // ---------- "Move all from this sender to Trash" ----------

  countFromSender(accountId: string, address: string): { count: number } {
    return { count: this.ctx.messages.idsFromSender(accountId, address).length };
  }

  async trashFromSender(accountId: string, address: string): Promise<ApplyActionRes> {
    const ids = this.ctx.messages.idsFromSender(accountId, address);
    if (ids.length === 0) return { succeeded: [], failed: [] };
    return this.actions.apply({ messageIds: ids, action: { type: 'delete' } });
  }
}
