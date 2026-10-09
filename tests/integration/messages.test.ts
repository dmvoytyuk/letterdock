// Engine integration: body fetch, MIME parsing, attachments, inline CID images, load-older.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageBody } from '../../src/shared/ipc';
import type { PreparedAttachment } from '../../src/shared/internal';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import {
  PDF_TEXT,
  PNG_BASE64,
  rawMessage,
  rawWithAttachments,
  startFakeImap,
  type FakeImapServer,
} from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close();
  h = null;
  server = null;
});

describe('message bodies', () => {
  it('fetches and caches a plain-text body', async () => {
    server = await startFakeImap({
      inbox: [{ raw: rawMessage({ subject: 'Plain', text: 'Body line one.\r\nBody line two.' }) }],
    });
    h = await createHarness(server);
    const acc = await h.addAccount();
    const hdr = await waitFor('synced', () => h!.inboxMessages(acc.id)[0]);
    expect(hdr.bodyCached).toBe(false);

    const body = (await h.engine.handle('messages.get', { messageId: hdr.id })) as MessageBody;
    expect(body.text).toContain('Body line one.');
    expect(body.html).toBeNull();
    expect(body.attachments).toEqual([]);

    // Second read is served from SQLite: drop all server connections and kill the server first.
    await server.close();
    server = null;
    const again = (await h.engine.handle('messages.get', { messageId: hdr.id })) as MessageBody;
    expect(again.text).toContain('Body line two.');
    expect(h.inboxMessages(acc.id)[0].bodyCached).toBe(true);
  });

  it('returns the raw source', async () => {
    server = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'Raw one' }) }] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    const hdr = await waitFor('synced', () => h!.inboxMessages(acc.id)[0]);
    const res = (await h.engine.handle('messages.rawSource', { messageId: hdr.id })) as {
      source: string;
    };
    expect(res.source).toContain('Subject: Raw one');
  });

  it('reports NOT_FOUND when the message is gone from the server before its body is read', async () => {
    server = await startFakeImap({ inbox: [{ raw: rawMessage({ subject: 'Vanishing' }) }] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    const hdr = await waitFor('synced', () => h!.inboxMessages(acc.id)[0]);
    await server.expunge('INBOX', hdr.uid);
    await expect(h.engine.handle('messages.get', { messageId: hdr.id })).rejects.toMatchObject({
      appError: { code: 'NOT_FOUND' },
    });
  });
});

describe('attachments and inline images', () => {
  async function bootWithAttachmentMessage() {
    server = await startFakeImap({ inbox: [{ raw: rawWithAttachments('Quarterly report') }] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    const hdr = await waitFor('synced', () => h!.inboxMessages(acc.id)[0]);
    const body = (await h.engine.handle('messages.get', { messageId: hdr.id })) as MessageBody;
    return { hdr, body };
  }

  it('flags the header as having an attachment (from BODYSTRUCTURE)', async () => {
    const { hdr } = await bootWithAttachmentMessage();
    expect(hdr.hasAttachments).toBe(true);
  });

  it('parses the HTML body and lists both the inline image and the file attachment', async () => {
    const { body } = await bootWithAttachmentMessage();
    expect(body.html).toContain('cid:logo123');
    expect(body.attachments).toHaveLength(2);
    const png = body.attachments.find((a) => a.contentType === 'image/png')!;
    const pdf = body.attachments.find((a) => a.contentType === 'application/pdf')!;
    expect(png).toMatchObject({ filename: 'logo.png', contentId: 'logo123', inline: true });
    expect(pdf).toMatchObject({ filename: 'report.pdf', inline: false });
    expect(pdf.size).toBe(PDF_TEXT.length);
  });

  it('serves the inline CID image bytes', async () => {
    const { hdr } = await bootWithAttachmentMessage();
    const res = (await h!.engine.handle('attachments.cidData', {
      messageId: hdr.id,
      contentId: 'logo123',
    })) as { contentType: string; data: Uint8Array };
    expect(res.contentType).toBe('image/png');
    expect(Buffer.from(res.data).toString('base64')).toBe(PNG_BASE64);
  });

  it('prepares an attachment file on disk with the right bytes', async () => {
    const { body } = await bootWithAttachmentMessage();
    const pdf = body.attachments.find((a) => a.contentType === 'application/pdf')!;
    const prepared = (await h!.engine.handle('attachments.prepare', {
      attachmentId: pdf.id,
    })) as PreparedAttachment;
    expect(prepared.filename).toBe('report.pdf');
    expect(prepared.size).toBe(PDF_TEXT.length);
    expect((await readFile(prepared.path)).toString('utf8')).toBe(PDF_TEXT);
  });
});

describe('sync window and loading older mail', () => {
  const DAY = 86_400_000;
  it('skips mail older than the sync window, then loads it on demand', async () => {
    const old = (n: number) => ({
      raw: rawMessage({ subject: `Old ${n}`, date: new Date(Date.now() - 200 * DAY) }),
      internaldate: new Date(Date.now() - 200 * DAY),
    });
    const recent = (n: number) => ({
      raw: rawMessage({ subject: `Recent ${n}` }),
      internaldate: new Date(Date.now() - n * 3_600_000),
    });
    server = await startFakeImap({ inbox: [old(1), old(2), recent(1), recent(2)] });
    h = await createHarness(server);
    const acc = await h.addAccount({ syncDays: 30 });
    await waitFor('recent synced', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    const inbox = h.folderByRole(acc.id, 'inbox');
    expect(
      h
        .inboxMessages(acc.id)
        .map((m) => m.subject)
        .sort(),
    ).toEqual(['Recent 1', 'Recent 2']);

    const list = (await h.engine.handle('messages.list', {
      scope: { kind: 'folder', folderId: inbox.id },
      cursor: null,
      limit: 50,
    })) as { canLoadOlderFromServer: boolean };
    expect(list.canLoadOlderFromServer).toBe(true);

    const res = (await h.engine.handle('sync.loadOlder', { folderId: inbox.id })) as {
      fetched: number;
      reachedStart: boolean;
    };
    expect(res.fetched).toBe(2);
    expect(res.reachedStart).toBe(true);
    expect(h.inboxMessages(acc.id)).toHaveLength(4);
  });
});
