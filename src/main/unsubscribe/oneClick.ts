// RFC 8058 one-click unsubscribe: a POST with the body `List-Unsubscribe=One-Click` (DESIGN-SPEC 3.13.1).
// Made here in main (never in the renderer). https only, also after redirects. No cookies, no Referer,
// no credentials. 10 second limit in total, at most 3 redirects. Same address guard as the image
// fetcher: private, loopback and link-local targets are refused (also after DNS lookup).
import https from 'node:https';
import { assertHostAllowed, guardedLookup } from '../imageCache/ssrf';

export const ONE_CLICK_TIMEOUT_MS = 10_000;
export const ONE_CLICK_MAX_REDIRECTS = 3;
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

export interface OneClickOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Tests only: allow loopback targets. */
  allowPrivate?: boolean;
  /** Tests only: trust this CA. */
  ca?: string | Buffer;
}

export type OneClickResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; reason: 'status' | 'timeout' | 'network' | 'blocked' | 'redirects' | 'insecure' };

const USER_AGENT = 'Letterdock';

interface Resolved {
  timeoutMs: number;
  maxRedirects: number;
  allowPrivate: boolean;
  ca?: string | Buffer;
}

function once(
  url: URL,
  method: 'POST' | 'GET',
  o: Resolved,
  deadline: number,
): Promise<{ redirect: { url: string; status: number } } | { status: number }> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'https:') return reject(Object.assign(new Error('https only'), { reason: 'insecure' }));
    try {
      assertHostAllowed(url.hostname, o.allowPrivate);
    } catch (e) {
      return reject(Object.assign(e as Error, { reason: 'blocked' }));
    }
    const body = method === 'POST' ? ONE_CLICK_BODY : '';
    const req = https.request(
      url,
      {
        method,
        // No cookies, no Referer, no Authorization.
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          ...(method === 'POST'
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
        },
        agent: false,
        lookup: guardedLookup(o.allowPrivate) as never,
        ...(o.ca ? { ca: o.ca } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // the answer text is not used
        if (status >= 300 && status < 400 && res.headers.location) {
          try {
            resolve({ redirect: { url: new URL(res.headers.location, url).toString(), status } });
          } catch {
            reject(Object.assign(new Error('bad redirect'), { reason: 'network' }));
          }
          return;
        }
        resolve({ status });
      },
    );
    const left = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { reason: 'timeout' })), left);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => {
      const err = e as Error & { reason?: string; code?: string };
      if (!err.reason) err.reason = err.code === 'EBLOCKED' ? 'blocked' : 'network';
      reject(err);
    });
    req.end(body);
  });
}

/** Send the one-click POST. Never throws: the result says what happened. 2xx = success. */
export async function postOneClick(rawUrl: string, opts: OneClickOptions = {}): Promise<OneClickResult> {
  const o: Resolved = {
    timeoutMs: opts.timeoutMs ?? ONE_CLICK_TIMEOUT_MS,
    maxRedirects: opts.maxRedirects ?? ONE_CLICK_MAX_REDIRECTS,
    allowPrivate: opts.allowPrivate ?? false,
    ca: opts.ca,
  };
  const deadline = Date.now() + o.timeoutMs;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'network' };
  }
  let method: 'POST' | 'GET' = 'POST';
  try {
    for (let hop = 0; hop <= o.maxRedirects; hop++) {
      const r = await once(url, method, o, deadline);
      if ('status' in r) {
        return r.status >= 200 && r.status < 300
          ? { ok: true, status: r.status }
          : { ok: false, status: r.status, reason: 'status' };
      }
      // 303 means "the result is at this address, fetch it". The others repeat the POST.
      if (r.redirect.status === 303) method = 'GET';
      url = new URL(r.redirect.url);
    }
    return { ok: false, reason: 'redirects' };
  } catch (e) {
    const reason = (e as { reason?: string }).reason;
    return {
      ok: false,
      reason: reason === 'timeout' || reason === 'blocked' || reason === 'insecure' ? reason : 'network',
    };
  }
}
