import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromProxyUrl, toProxyUrl } from '../../src/shared/imageProxy';
import { ImageDiskCache } from '../../src/main/imageCache/store';
import { ImageService } from '../../src/main/imageCache/service';
import { isPrivateIp, assertHostAllowed } from '../../src/main/imageCache/ssrf';
import { sniffImage } from '../../src/main/imageCache/sniff';
import { fetchImage } from '../../src/main/imageCache/fetcher';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4,
]);

describe('SSRF guard', () => {
  it('blocks private, loopback, link-local and special addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.8.8',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      '::ffff:127.0.0.1',
      '::ffff:10.1.2.3',
      '::ffff:c0a8:0101',
      'not-an-ip',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it('rejects IP literals in URLs', () => {
    expect(() => assertHostAllowed('127.0.0.1')).toThrow();
    expect(() => assertHostAllowed('[::1]')).toThrow();
    expect(() => assertHostAllowed('example.com')).not.toThrow();
    expect(() => assertHostAllowed('127.0.0.1', true)).not.toThrow();
  });
});

describe('image sniffing', () => {
  const bytes = (...n: number[]) => Uint8Array.from(n);
  const text = (s: string) => new TextEncoder().encode(s);
  it('detects the supported formats', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe('image/jpeg');
    expect(sniffImage(text('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(text('GIF87a....'))).toBe('image/gif');
    expect(sniffImage(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(text('\0\0\0\x1cftypavif\0\0\0\0'))).toBe('image/avif');
    expect(sniffImage(new Uint8Array([0x42, 0x4d, ...new Array<number>(20).fill(0)]))).toBe(
      'image/bmp',
    );
    expect(sniffImage(bytes(0, 0, 1, 0, 1, 0, 16, 16))).toBe('image/x-icon');
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml',
    );
    expect(sniffImage(text('<?xml version="1.0"?>\n<!-- c -->\n<svg width="1"/>'))).toBe(
      'image/svg+xml',
    );
  });
  it('rejects everything else', () => {
    expect(sniffImage(text('<html><body>hi</body></html>'))).toBeNull();
    expect(sniffImage(text('<script>alert(1)</script><svg>'))).toBeNull();
    expect(sniffImage(text('MZ\x90\0'))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(text('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
  });
});

describe('disk cache (LRU)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailroom-imgcache-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores, reads back, reports size and clears', async () => {
    const c = new ImageDiskCache(dir, 1_000_000);
    await c.put('https://a/1', 'image/png', PNG);
    expect((await c.get('https://a/1'))?.contentType).toBe('image/png');
    expect(await c.get('https://a/missing')).toBeNull();
    expect(await c.info()).toEqual({ bytes: PNG.byteLength, files: 1 });
    expect(await c.clear()).toEqual({ freed: PNG.byteLength });
    expect(await c.info()).toEqual({ bytes: 0, files: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('evicts the least recently used images when over the cap', async () => {
    let t = 1000;
    const big = new Uint8Array(100).fill(7);
    const c = new ImageDiskCache(dir, 1000, () => t++);
    await c.put('u1', 'image/png', big);
    await c.put('u2', 'image/png', big);
    await c.put('u3', 'image/png', big);
    await c.get('u1'); // u1 is now the freshest, u2 the oldest
    await c.put('u4', 'image/png', big); // 400 bytes, cap still large
    c.setMaxBytes(250); // lower the cap: trim to 225, so two are removed
    await c.trim();
    expect(await c.get('u2')).toBeNull();
    expect(await c.get('u3')).toBeNull();
    expect(await c.get('u1')).not.toBeNull();
    expect(await c.get('u4')).not.toBeNull();
    expect((await c.info()).bytes).toBeLessThanOrEqual(250);
  });

  it('removes images not shown for longer than the max age (fake clock)', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let now = 1_000_000_000_000;
    const c = new ImageDiskCache(dir, 1_000_000, () => now);
    c.setMaxAgeDays(30);
    await c.put('old', 'image/png', PNG);
    await c.put('recent', 'image/png', PNG);
    now += 20 * DAY;
    await c.get('recent'); // shown again: the clock restarts for this one
    now += 11 * DAY; // old: 31 days unseen; recent: 11 days
    await c.trim();
    expect(await c.get('old')).toBeNull();
    expect(await c.get('recent')).not.toBeNull();
    expect((await c.info()).files).toBe(1);
  });

  it('rebuilds its index from disk and applies a smaller cap on startup', async () => {
    const a = new ImageDiskCache(dir, 1_000_000);
    for (const u of ['x1', 'x2', 'x3']) await a.put(u, 'image/png', new Uint8Array(100));
    const b = new ImageDiskCache(dir, 150);
    expect((await b.info()).files).toBe(3);
    await b.trim();
    expect((await b.info()).files).toBe(1);
  });
});

describe('image service with a local server', () => {
  let server: http.Server;
  let base: string;
  let hits: Record<string, number>;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailroom-imgsvc-'));
    hits = {};
    server = http.createServer((req, res) => {
      hits[req.url!] = (hits[req.url!] ?? 0) + 1;
      if (req.url === '/p.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        setTimeout(() => res.end(Buffer.from(PNG)), 50);
      } else if (req.url === '/redir') {
        res.writeHead(302, { Location: '/p.png' }).end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' }).end();
      } else if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'image/png' }).end('<html>not an image</html>');
      } else if (req.url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(Buffer.from(PNG));
      } else if (req.url!.startsWith('/s3/')) {
        // S3 objects uploaded without a content type come back as binary/octet-stream.
        const type = req.url!.split('/')[2]!.split('?')[0]!.replace('_', '/');
        res.writeHead(200, type === 'none' ? {} : { 'Content-Type': type }).end(Buffer.from(PNG));
      } else if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.concat([Buffer.from(PNG), Buffer.alloc(2000)]));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const service = () =>
    new ImageService({
      cache: new ImageDiskCache(dir, 1_000_000),
      fetchOptions: { allowPrivate: true },
    });

  it('downloads once, then serves from disk even when the server says no-store', async () => {
    const s = service();
    const req = () => new Request(toProxyUrl(`${base}/p.png`)!);
    const [r1, r2] = await Promise.all([s.handle(req()), s.handle(req())]); // concurrent: one fetch
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('image/png');
    expect(r1.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(PNG);
    const r3 = await s.handle(req());
    expect(r3.status).toBe(200);
    expect(hits['/p.png']).toBe(1);
    // a new service on the same folder (app restart) still uses the disk copy
    const again = await service().handle(req());
    expect(again.status).toBe(200);
    expect(hits['/p.png']).toBe(1);
  });

  it('follows redirects, refuses loops, non-images and oversize files', async () => {
    const s = service();
    expect((await s.handle(new Request(toProxyUrl(`${base}/redir`)!))).status).toBe(200);
    expect((await s.handle(new Request(toProxyUrl(`${base}/loop`)!))).status).toBe(404);
    expect((await s.handle(new Request(toProxyUrl(`${base}/html`)!))).status).toBe(404);
    expect((await s.handle(new Request(toProxyUrl(`${base}/text`)!))).status).toBe(404);
    await expect(fetchImage(`${base}/big`, { allowPrivate: true, maxBytes: 1000 })).rejects.toThrow(
      /large/,
    );
    expect((await s.handle(new Request(toProxyUrl(`${base}/missing`)!))).status).toBe(404);
  });

  it('accepts real images served with a generic content type (S3 style)', async () => {
    const s = service();
    for (const t of ['binary_octet-stream', 'application_octet-stream', 'none']) {
      const r = await s.handle(
        new Request(toProxyUrl(`${base}/s3/${t}?X-Amz-Signature=${'a'.repeat(200)}&b=1`)!),
      );
      expect(r.status, t).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
    }
  });

  it('round-trips mixed-case hosts and long query strings through the cache URL', () => {
    const url = `https://Stripe-Images.S3.Amazonaws.com/emails/Acct_1AbC/1/invoice_illustration@2x.png?X-Amz-Credential=${'Zz9/+='.repeat(60)}&Expires=1#frag`;
    const proxy = toProxyUrl(url)!;
    expect(new URL(proxy).hostname).toBe('i'); // the encoded part is in the path, so nothing gets lowercased
    expect(new URL(proxy).pathname.slice(1)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromProxyUrl(new URL(proxy).href)).toBe(url.split('#')[0]);
  });

  it('logs the host and a reason, never the URL, when a fetch fails', async () => {
    const warns: Array<Record<string, unknown>> = [];
    const s = new ImageService({
      cache: new ImageDiskCache(dir, 1_000_000),
      fetchOptions: { allowPrivate: true },
      log: { warn: (o) => warns.push(o) },
    });
    expect((await s.handle(new Request(toProxyUrl(`${base}/text?secret=1`)!))).status).toBe(404);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ host: '127.0.0.1' });
    expect(JSON.stringify(warns[0])).not.toContain('secret');
  });

  it('never contacts private addresses by default', async () => {
    const s = new ImageService({ cache: new ImageDiskCache(dir, 1_000_000) });
    expect((await s.handle(new Request(toProxyUrl(`${base}/p.png`)!))).status).toBe(404);
    expect(hits['/p.png']).toBeUndefined();
    await expect(fetchImage('http://localhost:1/x.png')).rejects.toThrow();
  });

  it('rejects malformed cache URLs and non-GET requests', async () => {
    const s = service();
    expect((await s.handle(new Request('mailroom-img://i/!!!'))).status).toBe(400);
    expect(
      (await s.handle(new Request(toProxyUrl(`${base}/p.png`)!, { method: 'POST' }))).status,
    ).toBe(405);
  });
});
