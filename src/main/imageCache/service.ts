// Serves letterdock-img: requests from the disk cache, downloading on a miss.
import { fromProxyUrl } from '../../shared/imageProxy';
import { fetchImage, type FetchOptions, type FetchedImage } from './fetcher';
import type { ImageDiskCache } from './store';

const FAIL_MEMORY_MS = 60_000;

export interface ImageServiceDeps {
  cache: ImageDiskCache;
  fetchOptions?: FetchOptions;
  fetcher?: (url: string, o?: FetchOptions) => Promise<FetchedImage>;
  now?: () => number;
  /** Failure log. Gets the host and a reason only, never the full URL. */
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

function describeFailure(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return typeof code === 'string' ? `${code}: ${msg}` : msg;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid)';
  }
}

export class ImageService {
  private inflight = new Map<string, Promise<FetchedImage | null>>();
  private failed = new Map<string, number>();

  constructor(private readonly d: ImageServiceDeps) {}

  get cache(): ImageDiskCache {
    return this.d.cache;
  }

  /** Cached or freshly downloaded image for an original http(s) URL. Null if it cannot be had. */
  async load(url: string): Promise<{ contentType: string; data: Uint8Array } | null> {
    const hit = await this.d.cache.get(url);
    if (hit) return hit;
    const now = (this.d.now ?? Date.now)();
    const failedAt = this.failed.get(url);
    if (failedAt !== undefined && now - failedAt < FAIL_MEMORY_MS) return null;
    let p = this.inflight.get(url);
    if (!p) {
      p = (async () => {
        try {
          const img = await (this.d.fetcher ?? fetchImage)(url, this.d.fetchOptions);
          await this.d.cache.put(url, img.contentType, img.data);
          return img;
        } catch (e) {
          this.d.log?.warn(
            { host: hostOf(url), reason: describeFailure(e) },
            'remote image fetch failed',
          );
          this.failed.set(url, (this.d.now ?? Date.now)());
          return null;
        }
      })().finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }

  /** Handler for protocol.handle('letterdock-img', ...). */
  handle = async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const original = fromProxyUrl(request.url);
    if (!original) {
      this.d.log?.warn(
        { reason: 'cache URL could not be decoded' },
        'remote image request rejected',
      );
      return new Response(null, { status: 400 });
    }
    const img = await this.load(original);
    if (!img) return new Response(null, { status: 404 });
    return new Response(img.data as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200,
      headers: {
        'Content-Type': img.contentType,
        'Content-Length': String(img.data.byteLength),
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        // Belt and braces for SVG: no script, no network, no framing even if opened directly.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  };
}
