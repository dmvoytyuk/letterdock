import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  checkUidValidity,
  chunk,
  diffFlags,
  findExpunged,
  findMissing,
  mailboxUnchanged,
  pickInitialUids,
  toSequenceSet,
} from '../../src/engine/imap/syncDiff';
import { dedupeRoles, mapRole, syncPriority } from '../../src/engine/imap/mailboxRoles';
import {
  fetchedToHeader,
  flagsToSet,
  parseReferencesHeader,
  structureHasAttachments,
} from '../../src/engine/imap/parse';
import { mapNetworkError } from '../../src/engine/imap/errors';
import type { LocalFlagRow } from '../../src/engine/db/repos/messageRepo';

const f = (over: Partial<ReturnType<typeof flagsToSet>> = {}) => ({
  seen: false,
  flagged: false,
  answered: false,
  draft: false,
  deleted: false,
  keywords: [],
  ...over,
});

describe('uid helpers', () => {
  it('picks the newest N uids', () => {
    expect(pickInitialUids([5, 1, 9, 3, 7], 3)).toEqual([9, 7, 5]);
    expect(pickInitialUids([], 3)).toEqual([]);
  });
  it('chunks and builds sequence sets', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(toSequenceSet([5, 1, 2, 3, 9, 10, 3])).toBe('1:3,5,9:10');
    expect(toSequenceSet([])).toBe('');
  });
});

describe('uidvalidity + change detection', () => {
  it('decides first / same / reset', () => {
    expect(checkUidValidity(null, 7)).toBe('first');
    expect(checkUidValidity(7, 7)).toBe('same');
    expect(checkUidValidity(7, 8)).toBe('reset');
  });
  it('uses modseq + uidnext when CONDSTORE data exists, never otherwise', () => {
    const server = { uidValidity: 1, uidNext: 10, highestModseq: '55', exists: 4 };
    const stored = { uidnext: 10, highestmodseq: '55', serverExists: 4 };
    expect(mailboxUnchanged(server, stored)).toBe(true);
    expect(mailboxUnchanged(server, { ...stored, highestmodseq: '54' })).toBe(false);
    expect(mailboxUnchanged(server, { ...stored, uidnext: 9 })).toBe(false);
    // A bare expunge keeps modseq and uidnext but lowers EXISTS.
    expect(mailboxUnchanged({ ...server, exists: 3 }, stored)).toBe(false);
    expect(
      mailboxUnchanged({ ...server, highestModseq: null }, { ...stored, highestmodseq: null }),
    ).toBe(false);
  });
});

describe('flag + expunge diffs', () => {
  const local: LocalFlagRow[] = [
    { id: 1, uid: 1, ...f({ seen: true }) },
    { id: 2, uid: 2, ...f() },
    { id: 3, uid: 3, ...f({ keywords: ['$label1'] }) },
  ];
  it('reports only real flag changes', () => {
    const changes = diffFlags(local, [
      { uid: 1, flags: f({ seen: true }) }, // same
      { uid: 2, flags: f({ flagged: true }) }, // changed
      { uid: 3, flags: f({ keywords: ['$label2'] }) }, // keyword changed
      { uid: 99, flags: f() }, // unknown locally
    ]);
    expect(changes.map((c) => c.uid)).toEqual([2, 3]);
  });
  it('finds expunged and missing uids', () => {
    expect(findExpunged([1, 2, 3, 4], new Set([1, 3]), 0)).toEqual([2, 4]);
    expect(findExpunged([1, 2, 3, 4], new Set([3]), 3)).toEqual([4]); // below fromUid is ignored
    expect(findMissing([1, 2, 3], new Set([2]))).toEqual([1, 3]);
  });
});

describe('backoff', () => {
  it('grows exponentially and caps at 5 minutes', () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, noJitter)).toBe(2000);
    expect(backoffDelayMs(2, noJitter)).toBe(4000);
    expect(backoffDelayMs(3, noJitter)).toBe(8000);
    expect(backoffDelayMs(30, noJitter)).toBe(300_000);
    expect(backoffDelayMs(5, () => 0)).toBe(Math.round(32_000 * 0.75));
  });
});

describe('mailbox roles', () => {
  it('prefers INBOX name, then SPECIAL-USE, then name heuristics', () => {
    expect(mapRole({ path: 'inbox', name: 'inbox' })).toBe('inbox');
    expect(mapRole({ path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' })).toBe(
      'sent',
    );
    expect(mapRole({ path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All' })).toBe(
      'all',
    );
    expect(mapRole({ path: 'Sent Items', name: 'Sent Items' })).toBe('sent');
    expect(mapRole({ path: 'Deleted Items', name: 'Deleted Items' })).toBe('trash');
    expect(mapRole({ path: 'Cestino', name: 'Cestino' })).toBe('trash');
    expect(mapRole({ path: 'Projects', name: 'Projects' })).toBeNull();
  });
  it('keeps one folder per role and orders sync priority', () => {
    const out = dedupeRoles([{ role: 'sent' as const }, { role: 'sent' as const }, { role: null }]);
    expect(out.map((o) => o.role)).toEqual(['sent', null, null]);
    expect(syncPriority('inbox')).toBeLessThan(syncPriority('sent'));
    expect(syncPriority('sent')).toBeLessThan(syncPriority(null));
    expect(syncPriority(null)).toBeLessThan(syncPriority('trash'));
  });
});

describe('fetch parsing', () => {
  it('maps flags, keywords and system flags', () => {
    const s = flagsToSet(new Set(['\\Seen', '\\Flagged', '$Forwarded', '\\Recent']));
    expect(s).toMatchObject({
      seen: true,
      flagged: true,
      answered: false,
      keywords: ['$Forwarded'],
    });
  });
  it('detects attachments from body structure', () => {
    const plain = {
      type: 'multipart/alternative',
      childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
    };
    const withFile = {
      type: 'multipart/mixed',
      childNodes: [
        plain,
        {
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'a.pdf' },
        },
      ],
    };
    const inlineImg = {
      type: 'multipart/related',
      childNodes: [{ type: 'text/html' }, { type: 'image/png', disposition: 'inline', id: '<x>' }],
    };
    expect(structureHasAttachments(plain)).toBe(false);
    expect(structureHasAttachments(withFile)).toBe(true);
    expect(structureHasAttachments(inlineImg)).toBe(false);
    expect(structureHasAttachments(undefined)).toBe(false);
  });
  it('reads folded References headers', () => {
    const raw = Buffer.from('References: <a@x>\r\n <b@x>\r\n\r\n');
    expect(parseReferencesHeader(raw)).toBe('<a@x> <b@x>');
    expect(parseReferencesHeader(undefined)).toBeNull();
  });
  it('builds a header row; distrusts far-future Date headers', () => {
    const now = Date.now();
    const h = fetchedToHeader('a', 1, {
      uid: 4,
      flags: new Set(['\\Seen']),
      size: 99,
      internalDate: new Date(now - 5000),
      envelope: {
        date: new Date(now + 10 * 365 * 86400000),
        subject: 'Hi',
        messageId: '<id@x>',
        from: [{ name: 'Bob', address: 'bob@x.com' }],
        to: [{ address: 'me@x.com' }, { name: 'no address' }],
      },
    });
    expect(h.dateMs).toBe(h.internalMs);
    expect(h.from).toEqual({ name: 'Bob', address: 'bob@x.com' });
    expect(h.to).toEqual([{ address: 'me@x.com' }]);
    expect(h.flags.seen).toBe(true);
  });
});

describe('error mapping', () => {
  it('maps auth, tls, network, timeout', () => {
    expect(mapNetworkError({ authenticationFailed: true, message: 'x' }).code).toBe('AUTH_FAILED');
    expect(mapNetworkError({ code: 'EAUTH', message: 'Invalid login' }, 'smtp').code).toBe(
      'AUTH_FAILED',
    );
    expect(
      mapNetworkError(
        { code: 'EAUTH', message: '535 5.7.139 SmtpClientAuthentication is disabled' },
        'smtp',
      ).code,
    ).toBe('SMTP_AUTH_DISABLED');
    expect(
      mapNetworkError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed' }).code,
    ).toBe('TLS_ERROR');
    expect(mapNetworkError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }).code).toBe(
      'HOST_UNREACHABLE',
    );
    expect(mapNetworkError({ code: 'ETIMEDOUT', message: 'x' }).code).toBe('TIMEOUT');
    expect(mapNetworkError({ code: 'ETIMEDOUT', message: 'x' }).retryable).toBe(true);
    expect(mapNetworkError(new Error('weird')).code).toBe('INTERNAL');
  });
});
