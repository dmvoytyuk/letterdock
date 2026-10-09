// SMTP transport factory (password or XOAUTH2). Certificates are always verified.
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { ServerEndpoint } from '../../shared/ipc';
import type { Credential } from '../../shared/internal';

export interface SmtpExtras {
  /** Test-only: extra trusted CA for the fixture server. */
  smtpTrustedCa?: string | Buffer;
  /** Test-only: extra nodemailer options. */
  smtpOverrides?: Record<string, unknown>;
}

export function createSmtpTransport(
  endpoint: ServerEndpoint,
  username: string,
  cred: Credential,
  extras: SmtpExtras = {},
): Transporter {
  const auth =
    cred.kind === 'password'
      ? { user: username, pass: cred.password }
      : { type: 'OAuth2' as const, user: username, accessToken: cred.accessToken };
  return nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    // Port 465 style: TLS from the first byte. Port 587 style: STARTTLS is mandatory (no downgrade).
    secure: endpoint.security === 'ssl',
    requireTLS: endpoint.security === 'starttls',
    auth,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
    tls: extras.smtpTrustedCa
      ? { rejectUnauthorized: true, ca: extras.smtpTrustedCa }
      : { rejectUnauthorized: true },
    ...(extras.smtpOverrides ?? {}),
  });
}
