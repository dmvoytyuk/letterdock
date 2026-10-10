// `unsubscribe.run` (DESIGN-SPEC 3.13.1). The renderer sends only the message id and the method;
// the real addresses come from the engine's stored headers. Pure logic with injected parts, so it
// can be tested without Electron.
import type { ErrorCode, UnsubscribeMethodKind, UnsubscribeRunRes } from '../../shared/ipc';
import { makeError } from '../../shared/errors';
import type { OneClickResult } from './oneClick';

export interface UnsubscribeDeps {
  /** Engine requests (internal channels). */
  engine: <T>(channel: string, payload?: unknown) => Promise<T>;
  postOneClick: (url: string) => Promise<OneClickResult>;
  openExternal: (url: string) => Promise<void>;
  /** The network is down (an offline answer is clearer than a timeout). */
  isOnline: () => boolean;
}

interface Targets {
  auth: 'verified' | 'unknown' | 'failed';
  oneClickUrl: string | null;
  pageUrl: string | null;
  mailto: { address: string; subject: string; body: string } | null;
}

export async function runUnsubscribe(
  d: UnsubscribeDeps,
  req: { messageId: number; method: UnsubscribeMethodKind },
): Promise<UnsubscribeRunRes> {
  const fail = (code: ErrorCode, msg: string, retryable?: boolean): UnsubscribeRunRes => ({
    ok: false,
    method: req.method,
    error: makeError(code, msg, retryable === undefined ? {} : { retryable }),
  });
  const t = await d.engine<Targets>('unsubscribe.targets', { messageId: req.messageId });
  // A sender whose check failed is never offered, and never served (the renderer could ask anyway).
  if (t.auth === 'failed') return fail('INVALID_INPUT', "We can't confirm who sent this message.");

  if (req.method === 'one-click') {
    if (!t.oneClickUrl) return fail('UNSUPPORTED', 'This message does not allow one-click unsubscribe.');
    if (!d.isOnline()) return fail('HOST_UNREACHABLE', "You're offline. Try again when you are connected.", true);
    const r = await d.postOneClick(t.oneClickUrl);
    if (!r.ok) {
      if (r.reason === 'timeout') return fail('TIMEOUT', 'The sender did not answer in time.', true);
      if (r.reason === 'blocked') return fail('INVALID_INPUT', 'That address cannot be used.', false);
      if (r.reason === 'status') return fail('SERVER_REJECTED', `The sender refused the request (${r.status}).`, true);
      return fail('HOST_UNREACHABLE', "Couldn't unsubscribe automatically.", true);
    }
  } else if (req.method === 'mailto') {
    if (!t.mailto) return fail('UNSUPPORTED', 'This message has no unsubscribe email address.');
    await d.engine('unsubscribe.sendMailto', { messageId: req.messageId, ...t.mailto });
  } else {
    // Only an https address from the message's own header, opened in the system browser.
    if (!t.pageUrl || !/^https:\/\//i.test(t.pageUrl)) return fail('UNSUPPORTED', 'This message has no unsubscribe page.');
    if (!d.isOnline()) return fail('HOST_UNREACHABLE', "You're offline. Try again when you are connected.", true);
    await d.openExternal(t.pageUrl);
  }
  await d.engine('unsubscribe.record', { messageId: req.messageId, method: req.method });
  return { ok: true, method: req.method };
}
