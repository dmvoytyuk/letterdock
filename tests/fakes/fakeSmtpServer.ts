// In-process SMTP server for compose / send tests (ARCHITECTURE section 10).
// Uses the `smtp-server` package (from the nodemailer authors) with hoodiecrow's bundled
// self-signed certificate, which the engine trusts through the test-only `smtpTrustedCa` option.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';

const require_ = createRequire(import.meta.url);
const CERT_DIR = join(dirname(require_.resolve('hoodiecrow-imap/package.json')), 'cert');
const KEY = readFileSync(join(CERT_DIR, 'server.key'), 'utf8');
const CERT = readFileSync(join(CERT_DIR, 'server.crt'), 'utf8');

export interface CapturedMail {
  from: string;
  to: string[];
  raw: Buffer;
  parsed: ParsedMail;
  user: string;
  /** How the client authenticated. */
  method: string;
}

export interface FakeSmtpOptions {
  /** 'ssl' = TLS from the first byte (port 465 style), 'starttls' = upgrade (587 style). */
  security?: 'ssl' | 'starttls';
  user?: string;
  password?: string;
  /** Access token accepted for XOAUTH2. */
  accessToken?: string;
  /** Reject these recipient addresses at RCPT TO. */
  rejectRcpt?: string[];
  /** Offer no AUTH at all. */
  noAuth?: boolean;
}

export interface FakeSmtpServer {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
  ca: string;
  mails: CapturedMail[];
  authAttempts: { method: string; ok: boolean }[];
  /** Make the next `n` DATA commands fail with a temporary (4xx) error. */
  failNextData(n: number, code?: number): void;
  close(): Promise<void>;
}

export const SMTP_USER = 'testuser';
export const SMTP_PASSWORD = 'testpass';
export const SMTP_TOKEN = 'good-access-token';

export async function startFakeSmtp(opts: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const security = opts.security ?? 'ssl';
  const user = opts.user ?? SMTP_USER;
  const password = opts.password ?? SMTP_PASSWORD;
  const token = opts.accessToken ?? SMTP_TOKEN;
  const mails: CapturedMail[] = [];
  const authAttempts: { method: string; ok: boolean }[] = [];
  let failures = 0;
  let failCode = 451;

  const server = new SMTPServer({
    secure: security === 'ssl',
    key: KEY,
    cert: CERT,
    logger: false,
    authOptional: !!opts.noAuth,
    disabledCommands: opts.noAuth ? ['AUTH'] : security === 'starttls' ? [] : ['STARTTLS'],
    authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
    allowInsecureAuth: false,
    onAuth(auth, _session, cb) {
      const method = auth.method;
      const ok =
        method === 'XOAUTH2'
          ? auth.username === user && auth.accessToken === token
          : auth.username === user && auth.password === password;
      authAttempts.push({ method, ok });
      if (!ok) {
        if (method === 'XOAUTH2') {
          return cb(Object.assign(new Error('Authentication unsuccessful'), { responseCode: 535 }));
        }
        return cb(new Error('Invalid username or password'));
      }
      cb(null, { user: auth.username ?? user });
    },
    onRcptTo(address, _session, cb) {
      if (opts.rejectRcpt?.includes(address.address.toLowerCase())) {
        return cb(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
      }
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        if (failures > 0) {
          failures--;
          return cb(Object.assign(new Error('Try again later'), { responseCode: failCode }));
        }
        const raw = Buffer.concat(chunks);
        simpleParser(raw)
          .then((parsed) => {
            mails.push({
              from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
              to: session.envelope.rcptTo.map((r) => r.address),
              raw,
              parsed,
              user: session.user ? String((session.user as unknown) ?? '') : '',
              method: authAttempts[authAttempts.length - 1]?.method ?? 'none',
            });
            cb();
          })
          .catch((e) => cb(e as Error));
      });
    },
  });
  server.on('error', () => undefined);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.server.address() as { port: number }).port;

  return {
    host: '127.0.0.1',
    port,
    security,
    ca: CERT,
    mails,
    authAttempts,
    failNextData(n, code = 451) {
      failures = n;
      failCode = code;
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
