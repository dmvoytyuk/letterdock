import type { AppError } from '../../shared/ipc';
import { AppException, isAppError, makeError } from '../../shared/errors';

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'EPROTO',
  'ETLS',
]);

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ENETDOWN',
  'NoConnection',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED']);

interface LooseError {
  message?: string;
  code?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  responseText?: string;
  response?: unknown;
  responseCode?: number;
  serverResponseCode?: string;
  oauthError?: unknown;
}

/** Normalise any imapflow / nodemailer / node:net error to an AppError. */
export function mapNetworkError(e: unknown, protocol: 'imap' | 'smtp' = 'imap'): AppError {
  if (e instanceof AppException) return e.appError;
  if (isAppError(e)) return e;
  const err = (e ?? {}) as LooseError;
  const code = err.code ?? '';
  // Server reply first (e.g. "[AUTHENTICATIONFAILED] Invalid credentials (Failure)"). Never holds credentials.
  const serverReply = [err.serverResponseCode ? `[${err.serverResponseCode}]` : '', err.responseText ?? '']
    .filter(Boolean)
    .join(' ');
  const details = [...new Set([serverReply, err.message, code].filter(Boolean))].join(' | ');
  const text = `${err.message ?? ''} ${err.responseText ?? ''}`.toLowerCase();

  if (
    err.authenticationFailed ||
    code === 'EAUTH' ||
    /authenticationfailed|invalid credentials/.test(text)
  ) {
    if (
      protocol === 'smtp' &&
      /smtpclientauthentication is disabled|5\.7\.139|5\.7\.3.*disabled/.test(text)
    ) {
      return makeError(
        'SMTP_AUTH_DISABLED',
        'Sending is turned off for this mailbox by your provider or admin.',
        { details },
      );
    }
    return makeError(
      'AUTH_FAILED',
      'The server did not accept the email address or password. If your provider requires an app password, use that instead.',
      { details },
    );
  }
  if (err.tlsFailed || TLS_CODES.has(code) || /certificate|tls|ssl/.test(text)) {
    return makeError(
      'TLS_ERROR',
      'Could not make a secure connection. The server certificate may be invalid.',
      { details },
    );
  }
  if (TIMEOUT_CODES.has(code) || /timed? ?out/.test(text)) {
    return makeError('TIMEOUT', 'The server took too long to answer.', { details });
  }
  if (
    UNREACHABLE_CODES.has(code) ||
    /getaddrinfo|connect econn|socket hang up|connection closed/.test(text)
  ) {
    return makeError(
      'HOST_UNREACHABLE',
      'Could not reach the mail server. Check the address and your internet connection.',
      { details },
    );
  }
  if (/quota|over ?quota|mailbox full/.test(text)) {
    return makeError('QUOTA', 'The mailbox is full.', { details });
  }
  if (err.responseText || err.serverResponseCode || code === 'ENOENT') {
    return makeError(
      'SERVER_REJECTED',
      err.responseText
        ? `The server said: ${err.responseText}`
        : 'The server rejected the request.',
      {
        details,
        retryable: false,
      },
    );
  }
  return makeError('INTERNAL', 'Something went wrong while talking to the mail server.', {
    details: details || String(e),
    retryable: true,
  });
}
