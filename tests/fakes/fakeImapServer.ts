// In-process IMAP server for engine integration tests (ARCHITECTURE section 10).
// Built on hoodiecrow-imap (a strict, maintained IMAP test server). Speaks real IMAP over a
// real TLS socket on 127.0.0.1:<random port>, using hoodiecrow's bundled self-signed
// certificate, which the engine is told to trust through the test-only `imapTrustedCa` option.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ImapFlow } from 'imapflow';
import hoodiecrow, {
  type CommandHandler,
  type HoodiecrowMailbox,
  type HoodiecrowServer,
} from 'hoodiecrow-imap';

export const TEST_USER = 'testuser';
export const TEST_PASSWORD = 'testpass';
export const TEST_EMAIL_USER = 'me@example.com';
export const TEST_TOKEN = 'testtoken';

const require_ = createRequire(import.meta.url);
const CA_PEM = readFileSync(
  join(dirname(require_.resolve('hoodiecrow-imap/package.json')), 'cert', 'server.crt'),
  'utf8',
);

export interface SeedMessage {
  raw: string;
  flags?: string[];
  internaldate?: Date;
}

export interface FakeImapOptions {
  /** Hoodiecrow plugins; defaults to a typical modern server (IDLE, CONDSTORE, MOVE, ...). */
  plugins?: string[];
  inbox?: SeedMessage[];
  /** Extra seed messages per folder path (the folder must exist in the default layout). */
  folders?: Record<string, SeedMessage[]>;
  /** Adds a top-level "All Mail" folder with the \All special use (Gmail-like layout). */
  gmailLayout?: boolean;
  /** Leave these folders out of the default layout (e.g. ['Archive'] = a server without Archive). */
  omitFolders?: string[];
}

export const DEFAULT_PLUGINS = [
  'AUTH-PLAIN',
  'XOAUTH2',
  'SASL-IR',
  'ENABLE',
  'IDLE',
  'CONDSTORE',
  'SPECIAL-USE',
  'CREATE-SPECIAL-USE',
  'MOVE',
  'UIDPLUS',
  'UNSELECT',
  'NAMESPACE',
  'LIST-EXTENDED',
];

/** Plugins for a server without CONDSTORE (forces the full flag-fetch path). */
export const PLUGINS_NO_CONDSTORE = DEFAULT_PLUGINS.filter((p) => p !== 'CONDSTORE');

export interface RawMessageOpts {
  subject: string;
  from?: string;
  to?: string;
  date?: Date;
  messageId?: string;
  text?: string;
}

export function rawMessage(o: RawMessageOpts): string {
  const id = o.messageId ?? `<${Math.random().toString(36).slice(2)}@fake.test>`;
  return [
    `From: ${o.from ?? 'Alice <alice@example.com>'}`,
    `To: ${o.to ?? 'Me <me@example.com>'}`,
    `Subject: ${o.subject}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.text ?? 'Hello from the fake server.',
    '',
  ].join('\r\n');
}

// 1x1 transparent PNG.
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const PDF_TEXT = '%PDF-1.4 fake pdf body';

/** multipart/mixed: (multipart/related: html + inline cid image) + a PDF attachment. */
export function rawWithAttachments(subject: string): string {
  const b1 = 'MIXED-BOUNDARY';
  const b2 = 'RELATED-BOUNDARY';
  return [
    'From: Bob <bob@example.com>',
    'To: Me <me@example.com>',
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'Message-ID: <attach-1@fake.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b1}"`,
    '',
    `--${b1}`,
    `Content-Type: multipart/related; boundary="${b2}"`,
    '',
    `--${b2}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>See the picture:</p><img src="cid:logo123"></body></html>',
    `--${b2}`,
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo123>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    PNG_BASE64,
    `--${b2}--`,
    `--${b1}`,
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="report.pdf"',
    '',
    Buffer.from(PDF_TEXT).toString('base64'),
    `--${b1}--`,
    '',
  ].join('\r\n');
}

function buildStorage(o: FakeImapOptions): Record<string, unknown> {
  const seed = (list: SeedMessage[] = []) => ({
    messages: list.map((m) => ({
      raw: m.raw,
      flags: m.flags ?? [],
      internaldate: m.internaldate ?? new Date(),
    })),
  });
  const f = (special: string | null, extra: SeedMessage[] = []) => ({
    ...(special ? { 'special-use': special } : {}),
    ...seed(extra),
  });
  const extra = o.folders ?? {};
  const all: Record<string, unknown> = {
    Sent: f('\\Sent', extra['Sent']),
    Drafts: f('\\Drafts', extra['Drafts']),
    Trash: f('\\Trash', extra['Trash']),
    Junk: f('\\Junk', extra['Junk']),
    Archive: f('\\Archive', extra['Archive']),
    Projects: f(null, extra['Projects']),
  };
  for (const name of o.omitFolders ?? []) delete all[name];
  return {
    INBOX: seed(o.inbox),
    '': {
      separator: '/',
      folders: {
        ...all,
        ...(o.gmailLayout ? { 'All Mail': f('\\All', extra['All Mail']) } : {}),
      },
    },
  };
}

export interface FakeImapServer {
  host: string;
  port: number;
  /** PEM of the server certificate; pass as `imapTrustedCa`. */
  ca: string;
  raw: HoodiecrowServer;
  mailbox(path: string): HoodiecrowMailbox;
  /** Deliver a message as if it arrived from outside (wakes IDLE clients). Returns its UID. */
  deliver(path: string, msg: SeedMessage): number;
  /** Run commands on a separate, real IMAP connection (an "external" mail client). */
  withClient<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T>;
  /** External client sets/removes flags on a UID. */
  setFlags(path: string, uid: number, opts: { add?: string[]; remove?: string[] }): Promise<void>;
  /** External client deletes (flag + expunge) a UID. */
  expunge(path: string, uid: number): Promise<void>;
  /** Give a mailbox a new UIDVALIDITY and renumber its UIDs from 1, as a rebuilt mailbox would. */
  resetMailbox(path: string, messages: SeedMessage[]): void;
  /** Kill every open client socket without a goodbye. */
  dropConnections(): void;
  /** Cut the connection when one of these commands arrives (until `allowCommands()`). */
  dropOnCommands(commands: string[]): void;
  /** Make the server answer these commands (e.g. "UID MOVE") with NO until `allowCommands()`. */
  rejectCommands(commands: string[], text?: string): void;
  allowCommands(): void;
  connectionCount(): number;
  close(): Promise<void>;
}

export async function startFakeImap(opts: FakeImapOptions = {}): Promise<FakeImapServer> {
  const server = hoodiecrow({
    plugins: opts.plugins ?? DEFAULT_PLUGINS,
    storage: buildStorage(opts),
    secureConnection: true,
    users: {
      [TEST_USER]: { password: TEST_PASSWORD, xoauth2: { accessToken: TEST_TOKEN } },
      // Providers like Gmail log in with the full address.
      [TEST_EMAIL_USER]: { password: TEST_PASSWORD, xoauth2: { accessToken: TEST_TOKEN } },
    },
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const originals = new Map<string, CommandHandler | false>();

  const mailbox = (path: string): HoodiecrowMailbox => {
    const m = server.getMailbox(path);
    if (!m) throw new Error(`fake server has no mailbox ${path}`);
    return m;
  };

  const withClient = async <T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> => {
    const c = new ImapFlow({
      host: '127.0.0.1',
      port,
      secure: true,
      auth: { user: TEST_USER, pass: TEST_PASSWORD },
      logger: false,
      tls: { ca: CA_PEM },
    });
    c.on('error', () => undefined);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.logout().catch(() => c.close());
    }
  };

  return {
    host: '127.0.0.1',
    port,
    ca: CA_PEM,
    raw: server,
    mailbox,
    deliver(path, msg) {
      const { message } = server.appendMessage(
        path,
        msg.flags ?? [],
        msg.internaldate ?? new Date(),
        msg.raw,
      );
      return message.uid;
    },
    withClient,
    async setFlags(path, uid, o) {
      await withClient(async (c) => {
        const lock = await c.getMailboxLock(path);
        try {
          if (o.add?.length) await c.messageFlagsAdd(String(uid), o.add, { uid: true });
          if (o.remove?.length) await c.messageFlagsRemove(String(uid), o.remove, { uid: true });
        } finally {
          lock.release();
        }
      });
    },
    async expunge(path, uid) {
      await withClient(async (c) => {
        const lock = await c.getMailboxLock(path);
        try {
          await c.messageDelete(String(uid), { uid: true });
        } finally {
          lock.release();
        }
      });
    },
    resetMailbox(path, messages) {
      const m = mailbox(path);
      m.uidvalidity += 1000;
      m.messages.length = 0;
      m.uidnext = 1;
      for (const msg of messages) {
        server.appendMessage(m, msg.flags ?? [], msg.internaldate ?? new Date(), msg.raw);
      }
    },
    rejectCommands(commands, text = 'Permission denied') {
      for (const name of commands) {
        const key = name.toUpperCase();
        if (!originals.has(key)) originals.set(key, server.getCommandHandler(key));
        server.setCommandHandler(key, (conn, parsed, data, callback) => {
          conn.send(
            { tag: parsed.tag, command: 'NO', attributes: [{ type: 'TEXT', value: text }] },
            `${key} REJECTED`,
            parsed,
            data,
          );
          callback();
        });
      }
    },
    dropOnCommands(commands) {
      for (const name of commands) {
        const key = name.toUpperCase();
        if (!originals.has(key)) originals.set(key, server.getCommandHandler(key));
        server.setCommandHandler(key, (conn) => {
          conn.socket?.destroy();
        });
      }
    },
    allowCommands() {
      for (const [key, handler] of originals) {
        if (handler) server.setCommandHandler(key, handler);
      }
      originals.clear();
    },
    dropConnections() {
      for (const conn of [...server.connections]) conn.socket?.destroy();
    },
    connectionCount: () => server.connections.size,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
