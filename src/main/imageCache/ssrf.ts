// SSRF guard for the image fetcher: never connect to private, loopback or link-local addresses.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24 style special use
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True if the literal IP (v4 or v6) must not be contacted. Unparseable input counts as private. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    return ipv4Private(p[0]!, p[1]!);
  }
  if (v === 6) {
    let s = ip.toLowerCase().split('%')[0]!;
    try {
      // URL parsing compresses the address and writes mapped IPv4 as hex.
      s = new URL(`http://[${s}]`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return true;
    }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16);
      return ipv4Private(hi >> 8, hi & 255);
    }
    if (s === '::' || s === '::1') return true;
    const first = parseInt(s.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` function for http(s).request. Node connects to exactly the address returned here,
 * so checking inside it also defeats DNS rebinding. IP literals skip lookup and are checked by the caller.
 */
export function guardedLookup(allowPrivate = false) {
  return (hostname: string, options: object, cb: LookupCb): void => {
    const all = (options as { all?: boolean }).all === true;
    dnsLookup(hostname, { ...(options as object), all: true }, (err, addrs) => {
      if (err) return cb(err, '', 0);
      const list = addrs as LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateIp(a.address))) {
        const e: NodeJS.ErrnoException = new Error('Blocked address');
        e.code = 'EBLOCKED';
        return cb(e, '', 0);
      }
      if (all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** Throws if the URL points at an IP literal that is not allowed. Host names are checked at connect time. */
export function assertHostAllowed(hostname: string, allowPrivate = false): void {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (isIP(h) !== 0 && !allowPrivate && isPrivateIp(h)) {
    const e: NodeJS.ErrnoException = new Error('Blocked address');
    e.code = 'EBLOCKED';
    throw e;
  }
}
