// Downloads one remote image from the main process, with strict limits.
// Node http(s) is used (not net.fetch) so the connection address can be checked: see ssrf.ts.
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { assertHostAllowed, guardedLookup } from './ssrf';
import { sniffImage, type ImageMime } from './sniff';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Tests only: allow loopback targets. */
  allowPrivate?: boolean;
}

export interface FetchedImage {
  contentType: ImageMime;
  data: Uint8Array;
}

export class ImageFetchError extends Error {}

/** Content types that say nothing about the content; we sniff the bytes instead. */
const GENERIC_TYPE =
  /^(|(application|binary)\/(octet-stream|x-octet-stream|binary|unknown|x-unknown|download|x-download))$/;

function limitStream(max: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new ImageFetchError('Image is too large'));
      else cb(null, chunk);
    },
  });
}

function once(
  url: URL,
  o: Required<FetchOptions>,
  deadline: number,
): Promise<{ redirect: string } | { image: FetchedImage }> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new ImageFetchError('Only http and https are allowed'));
    }
    try {
      assertHostAllowed(url.hostname, o.allowPrivate);
    } catch (e) {
      return reject(e);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        // No cookies, no Referer, no credentials; a generic browser User-Agent.
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        agent: false,
        lookup: guardedLookup(o.allowPrivate) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, url).toString() });
        }
        if (status !== 200) {
          res.resume();
          return reject(new ImageFetchError(`Server answered ${status}`));
        }
        // The declared type is only a hint: S3 and CDNs often send binary/octet-stream for real images.
        // Anything that is not an image type or a generic binary type is refused early; the bytes decide.
        const type = String(res.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        if (!type.startsWith('image/') && !GENERIC_TYPE.test(type)) {
          res.resume();
          return reject(new ImageFetchError(`Not an image (declared type ${type.slice(0, 40)})`));
        }
        const len = Number(res.headers['content-length']);
        if (Number.isFinite(len) && len > o.maxBytes) {
          res.resume();
          return reject(new ImageFetchError('Image is too large'));
        }
        const enc = String(res.headers['content-encoding'] ?? 'identity')
          .toLowerCase()
          .trim();
        const decoder =
          enc === 'gzip' || enc === 'x-gzip'
            ? zlib.createGunzip()
            : enc === 'deflate'
              ? zlib.createInflate()
              : enc === 'br'
                ? zlib.createBrotliDecompress()
                : null;
        if (enc !== 'identity' && enc !== '' && !decoder) {
          res.resume();
          return reject(new ImageFetchError('Unsupported encoding'));
        }
        const chunks: Buffer[] = [];
        const sink = limitStream(o.maxBytes);
        sink.on('data', (c: Buffer) => chunks.push(c));
        const streams = decoder ? [res, limitStream(o.maxBytes), decoder, sink] : [res, sink];
        pipeline(streams as never, (err?: Error | null) => {
          if (err) return reject(err);
          const data = Buffer.concat(chunks);
          const mime = sniffImage(data);
          if (!mime) return reject(new ImageFetchError('Bytes are not a supported image format'));
          resolve({ image: { contentType: mime, data: new Uint8Array(data) } });
        });
      },
    );
    const left = Math.max(1, deadline - Date.now());
    req.setTimeout(left, () => req.destroy(new ImageFetchError('Timed out')));
    const timer = setTimeout(() => req.destroy(new ImageFetchError('Timed out')), left);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch an http(s) image. Throws on any problem. */
export async function fetchImage(rawUrl: string, opts: FetchOptions = {}): Promise<FetchedImage> {
  const o: Required<FetchOptions> = {
    timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? MAX_IMAGE_BYTES,
    maxRedirects: opts.maxRedirects ?? MAX_REDIRECTS,
    allowPrivate: opts.allowPrivate ?? false,
  };
  const deadline = Date.now() + o.timeoutMs;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    const r = await once(url, o, deadline);
    if ('image' in r) return r.image;
    url = new URL(r.redirect);
  }
  throw new ImageFetchError('Too many redirects');
}
