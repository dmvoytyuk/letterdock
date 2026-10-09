// Snippet backfill: rows synced before snippets existed get filled in the background, once.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close();
  h = null;
  server = null;
});

// A message whose only part is a PDF: it has no text part to take a snippet from.
const noText = [
  'From: Bob <bob@example.com>',
  'To: Me <me@example.com>',
  'Subject: Only a file',
  `Date: ${new Date().toUTCString()}`,
  'Message-ID: <notext@fake.test>',
  'MIME-Version: 1.0',
  'Content-Type: application/pdf',
  'Content-Transfer-Encoding: 7bit',
  '',
  '%PDF-1.4 fake',
  '',
].join('\r\n');

describe('snippet backfill', () => {
  it('fills empty snippets of old rows and does not retry rows without a text part', async () => {
    const mk = (n: number) => ({
      raw: rawMessage({
        subject: `Old ${n}`,
        messageId: `<old${n}@fake.test>`,
        text: `Old body number ${n}`,
        date: new Date(Date.now() - n * 3_600_000),
      }),
      flags: [] as string[],
    });
    server = await startFakeImap({ inbox: [mk(1), mk(2), mk(3), { raw: noText, flags: [] }] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('synced with snippets', () => {
      const ms = h!.inboxMessages(acc.id);
      return ms.length === 4 && ms.filter((m) => m.snippet.length > 0).length === 3;
    });
    const ctx = h.engine.ctx;
    const inbox = h.folderByRole(acc.id, 'inbox');

    // Pretend these rows were synced by the old version: no snippet, never tried.
    ctx.db.prepare("UPDATE message SET snippet='', snippet_checked=0").run();
    expect(h.inboxMessages(acc.id).every((m) => m.snippet === '')).toBe(true);
    h.events.length = 0;

    // A new session start runs the backfill after the first sync.
    await h.engine.sessions.restart(acc.id);
    await waitFor('backfill filled the text rows', () => {
      const ms = h!.inboxMessages(acc.id);
      return ms.filter((m) => m.snippet.length > 0).length === 3;
    });
    const filled = h.inboxMessages(acc.id).find((m) => m.subject === 'Old 2')!;
    expect(filled.snippet).toContain('Old body number 2');
    await waitFor('list-change event', () =>
      h!.events.some((e) => e.type === 'messages:changed' && e.updated.length > 0),
    );

    // Everything was tried: the row with no text part is marked, so nothing is left to do.
    await waitFor('nothing left', () => ctx.messages.snippetTodo(inbox.id, 10).length === 0);
    const pdf = ctx.db
      .prepare("SELECT snippet, snippet_checked AS c FROM message WHERE subject='Only a file'")
      .get() as { snippet: string; c: number };
    expect(pdf).toEqual({ snippet: '', c: 1 });
    // The messages stayed unread on the server (BODY.PEEK).
    expect(server.mailbox('INBOX').messages.some((m) => m.flags.includes('\\Seen'))).toBe(false);
  });
});
