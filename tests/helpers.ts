import { AccountRepo } from '../src/engine/db/repos/accountRepo';
import { FolderRepo } from '../src/engine/db/repos/folderRepo';
import { MessageRepo, type HeaderInput } from '../src/engine/db/repos/messageRepo';
import { openDatabase } from '../src/engine/db/connection';
import { ContactService } from '../src/engine/contacts/contactService';
import { EventHub, type EngineContext } from '../src/engine/context';
import { nullLogger } from '../src/engine/logger';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import type { Account, AppEvent } from '../src/shared/ipc';

export function makeCtx(now = () => 1_700_000_000_000) {
  const db = openDatabase(':memory:');
  const folders = new FolderRepo(db);
  const events: AppEvent[] = [];
  const ctx: EngineContext = {
    dataDir: '',
    db,
    accounts: new AccountRepo(db),
    folders,
    messages: new MessageRepo(db),
    hub: new EventHub(
      (e) => events.push(e),
      () => folders.counts(),
      0,
    ),
    secrets: {
      getCredential: async () => ({ kind: 'password', password: 'x' }),
      set: async () => undefined,
      delete: async () => undefined,
      peekOAuthSession: async () => ({ email: 'me@example.com', accessToken: 'x', expiresAt: 0 }),
      adoptOAuthSession: async () => ({ email: 'me@example.com', accessToken: 'x', expiresAt: 0 }),
    },
    log: nullLogger(),
    settings: () => DEFAULT_SETTINGS,
    now,
    recentMoves: new Map(),
  } as unknown as EngineContext;
  ctx.contacts = new ContactService(ctx);
  return { ctx, db, events };
}

export function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'me@example.com',
    displayName: 'Me',
    color: '#0F6CBD',
    provider: 'generic',
    authType: 'password',
    oauthProvider: null,
    imap: { host: 'imap.example.com', port: 993, security: 'ssl' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'ssl' },
    username: 'me@example.com',
    syncDays: 90,
    signature: null,
    enabled: true,
    sortOrder: 0,
    badge: 'M',
    ...over,
  };
}

export function header(
  over: Partial<HeaderInput> & Pick<HeaderInput, 'folderId' | 'uid'>,
): HeaderInput {
  return {
    accountId: 'acc-1',
    messageId: `<m${over.uid}@x>`,
    inReplyTo: null,
    references: null,
    subject: `Subject ${over.uid}`,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    dateMs: 1_000_000 + over.uid * 1000,
    internalMs: 1_000_000 + over.uid * 1000,
    size: 1000,
    flags: {
      seen: false,
      flagged: false,
      answered: false,
      draft: false,
      deleted: false,
      keywords: [],
    },
    modseq: null,
    hasAttachments: false,
    ...over,
  };
}
