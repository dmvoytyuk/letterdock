import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/engine';
import { validateFolderName, joinPath, parentOf } from '../../src/engine/folders/folderService';
import {
  ftsText,
  hasRemoteImages,
  makeSnippet,
  safeFileName,
  stripHtml,
} from '../../src/engine/messages/bodyUtils';
import { pickColor, ACCOUNT_COLORS } from '../../src/engine/accounts/accountService';
import { openDatabase } from '../../src/engine/db/connection';
import { nullLogger } from '../../src/engine/logger';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import type { AppEvent } from '../../src/shared/ipc';
import { header, makeAccount } from '../helpers';

function engine() {
  const events: AppEvent[] = [];
  const e = createEngine({
    dataDir: '',
    db: openDatabase(':memory:'),
    send: (ev) => events.push(ev),
    log: nullLogger(),
    settings: () => DEFAULT_SETTINGS,
    secrets: {
      getCredential: async () => ({ kind: 'password', password: 'x' }),
      set: async () => undefined,
      delete: async () => undefined,
      peekOAuthSession: async () => ({ email: 'x', accessToken: 'x', expiresAt: 0 }),
      adoptOAuthSession: async () => ({ email: 'x', accessToken: 'x', expiresAt: 0 }),
    },
    discoverDeps: { fetchText: async () => null, resolveMx: async () => [] },
  });
  return { e, events };
}

describe('engine rpc surface', () => {
  it('answers empty-state reads without a network', async () => {
    const { e } = engine();
    expect(await e.handle('accounts.list', undefined)).toEqual([]);
    expect(await e.handle('accounts.statuses', undefined)).toEqual([]);
    expect(await e.handle('folders.list', {})).toEqual([]);
    expect(await e.handle('folders.counts', undefined)).toEqual({
      unifiedInboxUnread: 0,
      perFolder: [],
    });
    expect(
      await e.handle('messages.list', { scope: { kind: 'unifiedInbox' }, cursor: null, limit: 50 }),
    ).toMatchObject({ items: [], nextCursor: null, canLoadOlderFromServer: false });
  });

  it('serves discovery for a known provider', async () => {
    const { e } = engine();
    const r = (await e.handle('accounts.discover', { email: 'me@icloud.com' })) as {
      config: { help: { providerName: string } };
    };
    expect(r.config.help.providerName).toBe('iCloud Mail');
  });

  it('unknown channels throw', async () => {
    const { e } = engine();
    await expect(e.handle('nope', {})).rejects.toThrow(/Unknown channel/);
  });

  it('messages.apply: with no connection the change is kept and queued (not reverted)', async () => {
    const { e, events } = engine();
    e.ctx.accounts.insert(makeAccount(), 1);
    e.ctx.folders.syncListed('acc-1', [
      {
        path: 'INBOX',
        name: 'INBOX',
        delimiter: '/',
        role: 'inbox',
        subscribed: true,
        selectable: true,
      },
    ]);
    const fid = e.ctx.folders.rowByPath('acc-1', 'INBOX')!.id;
    const { added } = e.ctx.messages.upsertHeaders([header({ folderId: fid, uid: 1 })]);
    // No session exists in this harness: the server write cannot happen, so it waits in the queue.
    const res = (await e.handle('messages.apply', {
      messageIds: added,
      action: { type: 'markRead', read: true },
    })) as { succeeded: number[] };
    expect(res.succeeded).toEqual(added);
    await new Promise((r) => setTimeout(r, 20));
    expect(e.ctx.messages.headers(added)[0].seen).toBe(true);
    expect(events.some((ev) => ev.type === 'action:failed')).toBe(false);
    expect(events).toContainEqual({ type: 'pending:count', accountId: 'acc-1', count: 1 });
    expect(e.ctx.pendingOps?.count('acc-1')).toBe(1);
  });
});

describe('folder names', () => {
  it('validates names', () => {
    expect(validateFolderName('  Receipts ', '/')).toBe('Receipts');
    for (const bad of ['', '   ', 'a/b', 'a\b', 'x*y', '..', 'a.b']) {
      if (bad === 'a.b') {
        expect(() => validateFolderName(bad, '.')).toThrow(); // contains the server delimiter
      } else {
        expect(() => validateFolderName(bad, '/')).toThrow();
      }
    }
  });
  it('joins and splits paths', () => {
    expect(joinPath(null, '/', 'A', 'INBOX.')).toBe('INBOX.A');
    expect(joinPath('Work', '/', 'A')).toBe('Work/A');
    expect(parentOf('Work/A', '/')).toBe('Work');
    expect(parentOf('Work', '/')).toBeNull();
  });
});

describe('body helpers', () => {
  it('strips html and builds snippets', () => {
    expect(stripHtml('<style>p{}</style><p>Hello&nbsp;<b>world</b></p><script>x()</script>')).toBe(
      'Hello world',
    );
    expect(makeSnippet(null, '<p>Hi   there</p>')).toBe('Hi there');
    expect(makeSnippet('a'.repeat(500), null)).toHaveLength(200);
    expect(ftsText('t', null)).toBe('t');
  });
  it('drops image placeholders and bracketed urls from snippets', () => {
    expect(makeSnippet('[image: Google logo] Security alert [https://x.com/a?b=1] Hello [image] there', null)).toBe(
      'Security alert Hello there',
    );
    expect(makeSnippet('[image… Welcome back', null)).toBe('Welcome back');
    expect(makeSnippet(null, '<p>[image: x]</p><p>Real text</p>')).toBe('Real text');
  });
  it('detects remote content', () => {
    expect(hasRemoteImages('<img src="https://x.com/a.png">')).toBe(true);
    expect(hasRemoteImages('<img src="//x.com/a.png">')).toBe(true);
    expect(hasRemoteImages('<div style="background:url(http://x.com/a.png)">')).toBe(true);
    expect(hasRemoteImages('<img src="cid:abc"><img src="data:image/png;base64,AAA">')).toBe(false);
    expect(hasRemoteImages(null)).toBe(false);
  });
  it('makes attachment names safe for Windows', () => {
    expect(safeFileName('../../Windows/evil.exe')).toBe(
      '.._.._Windows_evil.exe'.replace(/^\.+/, ''),
    );
    expect(safeFileName('con.txt')).toBe('_con.txt');
    expect(safeFileName('  ')).toBe('attachment');
    expect(safeFileName('a:b*c?.pdf')).toBe('a_b_c_.pdf');
    expect(safeFileName('x'.repeat(300) + '.pdf')).toHaveLength(120);
  });
});

describe('account colors', () => {
  it('assigns the first unused palette color, then cycles', () => {
    expect(pickColor([])).toBe(ACCOUNT_COLORS[0]);
    expect(pickColor([ACCOUNT_COLORS[0].toLowerCase()])).toBe(ACCOUNT_COLORS[1]);
    expect(pickColor(ACCOUNT_COLORS)).toBe(ACCOUNT_COLORS[0]);
  });
});
