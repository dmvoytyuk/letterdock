import type { AppError, ErrorCode, IpcChannel, InvokeArgs, IpcRes } from '../../../shared/ipc';

/** Typed wrapper around window.api.invoke. */
export function call<C extends IpcChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<IpcRes<C>> {
  return (window.api.invoke as (c: C, ...a: unknown[]) => Promise<IpcRes<C>>)(channel, ...args);
}

const CODES: readonly string[] = [
  'AUTH_FAILED',
  'OAUTH_REAUTH_REQUIRED',
  'OAUTH_NOT_CONFIGURED',
  'SMTP_AUTH_DISABLED',
  'TLS_ERROR',
  'HOST_UNREACHABLE',
  'TIMEOUT',
  'NOT_FOUND',
  'INVALID_INPUT',
  'SERVER_REJECTED',
  'QUOTA',
  'DB_ERROR',
  'CANCELLED',
  'UNSUPPORTED',
  'INTERNAL',
];

/** invoke() rejects with a plain AppError. Anything else is turned into an INTERNAL error. */
export function asAppError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const o = e as Record<string, unknown>;
    if (typeof o.code === 'string' && CODES.includes(o.code) && typeof o.message === 'string') {
      return e as AppError;
    }
  }
  const message = e instanceof Error ? e.message : 'Something went wrong.';
  return { code: 'INTERNAL', message, retryable: false };
}

export function errorCode(e: unknown): ErrorCode {
  return asAppError(e).code;
}

export function isUnsupported(e: unknown): boolean {
  return errorCode(e) === 'UNSUPPORTED';
}

export function logRenderer(level: 'warn' | 'error', msg: string): void {
  void call('log.write', { level, msg: msg.slice(0, 2000) }).catch(() => undefined);
}
