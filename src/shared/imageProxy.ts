// The local remote-image cache URL format (ARCHITECTURE section 6.3 / 9).
// Used by the renderer sanitizer (encode) and by main (decode). Pure functions, no platform APIs.

export const IMAGE_SCHEME = 'letterdock-img';
const PREFIX = `${IMAGE_SCHEME}://i/`;

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** True for http(s) and protocol-relative URLs. */
export function isRemoteUrl(u: string): boolean {
  return /^\s*(https?:)?\/\//i.test(u);
}

/** Turn a remote http(s) URL into its local cache URL. Returns null if it is not a remote URL. */
export function toProxyUrl(remote: string): string | null {
  let u = remote.trim();
  if (!isRemoteUrl(u)) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  const hash = u.indexOf('#');
  if (hash >= 0) u = u.slice(0, hash);
  return PREFIX + toBase64Url(u);
}

/** Read the original http(s) URL back out of a cache URL. Returns null for anything else. */
export function fromProxyUrl(proxy: string): string | null {
  if (!proxy.startsWith(PREFIX)) return null;
  const rest = proxy.slice(PREFIX.length).split(/[?#]/)[0]!;
  const original = fromBase64Url(rest);
  if (original === null || !/^https?:\/\//i.test(original)) return null;
  return original;
}
