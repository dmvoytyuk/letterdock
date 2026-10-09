// One-shot loopback HTTP listener for the OAuth redirect (RFC 8252 section 7.3).
// Binds 127.0.0.1 on a random port (and ::1 on the same port when possible, because a browser may
// resolve "localhost" to either). Accepts exactly one valid callback, then closes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppException } from '../../shared/errors';

export interface LoopbackResult {
  code: string;
}

export interface Loopback {
  port: number;
  /** Resolves with the authorization code, or rejects (denied, timeout, cancelled). */
  result: Promise<LoopbackResult>;
  /** Stop listening. Rejects `result` with CANCELLED if it is still pending. */
  close(): void;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>body{font-family:Segoe UI,system-ui,sans-serif;margin:15vh auto;max-width:28em;padding:0 1em;color:#1a1a1a}` +
  `@media(prefers-color-scheme:dark){body{background:#202020;color:#f3f3f3}}</style></head>` +
  `<body><h1 style="font-weight:600;font-size:1.4em">${title}</h1><p>${text}</p></body></html>`;

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

export async function startLoopback(opts: {
  expectedState: string;
  timeoutMs?: number;
}): Promise<Loopback> {
  const servers: Server[] = [];
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolve!: (r: LoopbackResult) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<LoopbackResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody awaits yet (e.g. close() before complete()) must not crash the process.
  result.catch(() => undefined);

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn();
    // Let the browser finish loading the response page before the sockets go away.
    setTimeout(() => servers.forEach((s) => s.close()), 200).unref();
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') return send(res, 405, PAGE('Not allowed', 'Use the browser to sign in.'));
    const url = new URL(req.url ?? '/', 'http://localhost');
    const params = url.searchParams;
    // Browsers also ask for /favicon.ico: ignore anything that is not an OAuth answer.
    if (!params.has('state') && !params.has('code') && !params.has('error')) {
      return send(res, 404, PAGE('Not found', 'Nothing here.'));
    }
    if (params.get('state') !== opts.expectedState) {
      // Wrong or missing state: a stray or forged request. Do not end the sign-in because of it.
      return send(res, 400, PAGE('Sign-in not accepted', 'This request did not come from Mailroom.'));
    }
    if (settled) return send(res, 410, PAGE('Already done', 'You can close this tab.'));
    const error = params.get('error');
    if (error) {
      send(res, 200, PAGE('Sign-in cancelled', 'You can close this tab and return to Mailroom.'));
      const denied = error === 'access_denied';
      return finish(() =>
        reject(
          new AppException(
            denied ? 'CANCELLED' : 'INTERNAL',
            denied
              ? 'Sign-in was cancelled.'
              : 'Microsoft could not complete the sign-in.',
            { details: `${error}: ${params.get('error_description') ?? ''}`.slice(0, 500) },
          ),
        ),
      );
    }
    const code = params.get('code');
    if (!code) return send(res, 400, PAGE('Sign-in not accepted', 'No sign-in code was received.'));
    send(res, 200, PAGE('You are signed in', 'You can close this tab and return to Mailroom.'));
    finish(() => resolve({ code }));
  };

  const primary = createServer(handler);
  await new Promise<void>((res, rej) => {
    primary.once('error', rej);
    primary.listen(0, '127.0.0.1', () => res());
  });
  servers.push(primary);
  const port = (primary.address() as AddressInfo).port;

  // Best effort: the same port on the IPv6 loopback address.
  const v6 = createServer(handler);
  await new Promise<void>((res) => {
    v6.once('error', () => res());
    v6.listen(port, '::1', () => {
      servers.push(v6);
      res();
    });
  });

  timer = setTimeout(() => {
    finish(() => reject(new AppException('TIMEOUT', 'Sign-in took too long. Try again.')));
  }, opts.timeoutMs ?? 5 * 60_000);
  timer.unref?.();

  return {
    port,
    result,
    close() {
      finish(() => reject(new AppException('CANCELLED', 'Sign-in was cancelled.')));
    },
  };
}
