import type { AppError, ErrorCode } from './ipc';

export type { AppError, ErrorCode } from './ipc';

const RETRYABLE: Record<ErrorCode, boolean> = {
  AUTH_FAILED: false,
  OAUTH_REAUTH_REQUIRED: false,
  OAUTH_NOT_CONFIGURED: false,
  SMTP_AUTH_DISABLED: false,
  TLS_ERROR: false,
  HOST_UNREACHABLE: true,
  TIMEOUT: true,
  NOT_FOUND: false,
  INVALID_INPUT: false,
  SERVER_REJECTED: false,
  QUOTA: false,
  DB_ERROR: false,
  CANCELLED: false,
  UNSUPPORTED: false,
  INTERNAL: false,
};

/** Build a plain AppError object (safe to send over IPC). */
export function makeError(
  code: ErrorCode,
  message: string,
  extra: { retryable?: boolean; details?: string } = {},
): AppError {
  const err: AppError = {
    code,
    message,
    retryable: extra.retryable ?? RETRYABLE[code],
  };
  if (extra.details) err.details = extra.details;
  return err;
}

/** Throwable wrapper. Carries an AppError so handlers can `throw new AppException(...)`. */
export class AppException extends Error {
  readonly appError: AppError;
  constructor(
    code: ErrorCode,
    message: string,
    extra: { retryable?: boolean; details?: string } = {},
  ) {
    super(message);
    this.name = 'AppException';
    this.appError = makeError(code, message, extra);
  }
}

export function notImplemented(what: string): AppException {
  return new AppException('UNSUPPORTED', `${what} is not implemented yet.`);
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppError).code === 'string' &&
    typeof (value as AppError).message === 'string' &&
    typeof (value as AppError).retryable === 'boolean'
  );
}

/** Turn anything thrown into an AppError. Network-library mapping lives in the engine. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppException) return e.appError;
  if (isAppError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return makeError('INTERNAL', 'Something went wrong.', { details: message });
}
