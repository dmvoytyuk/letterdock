// Disk cache for remote email images: <dir>/<sha256(url)>.bin + .json (content type, size).
// Eviction is least-recently-used by lastAccess, with a size cap.
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export interface CachedImage {
  contentType: string;
  data: Uint8Array;
}

interface Entry {
  size: number;
  contentType: string;
  lastAccess: number;
  /** When lastAccess was last written to disk (file time). */
  persisted: number;
}

const PERSIST_EVERY_MS = 60 * 60 * 1000;

export const hashUrl = (url: string): string => createHash('sha256').update(url).digest('hex');

export class ImageDiskCache {
  private index = new Map<string, Entry>();
  private ready: Promise<void>;
  private bytes = 0;
  private trimming: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {
    this.ready = this.load().catch(() => undefined);
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const full = join(this.dir, name);
      if (name.endsWith('.tmp')) {
        await unlink(full).catch(() => undefined);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      try {
        const [meta, st, bin] = await Promise.all([
          readFile(full, 'utf8').then((t) => JSON.parse(t) as { contentType?: string }),
          stat(full),
          stat(join(this.dir, `${key}.bin`)),
        ]);
        if (typeof meta.contentType !== 'string') throw new Error('bad meta');
        this.index.set(key, {
          size: bin.size,
          contentType: meta.contentType,
          lastAccess: st.mtimeMs,
          persisted: st.mtimeMs,
        });
        this.bytes += bin.size;
      } catch {
        await Promise.all([unlink(full), unlink(join(this.dir, `${key}.bin`))]).catch(
          () => undefined,
        );
      }
    }
    // Orphan .bin files without metadata.
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (name.endsWith('.bin') && !this.index.has(name.slice(0, -4))) {
        await unlink(join(this.dir, name)).catch(() => undefined);
      }
    }
  }

  async init(): Promise<void> {
    await this.ready;
  }

  async get(url: string): Promise<CachedImage | null> {
    await this.ready;
    const key = hashUrl(url);
    const e = this.index.get(key);
    if (!e) return null;
    try {
      const data = await readFile(join(this.dir, `${key}.bin`));
      // Always update in memory; write the file time at most once an hour per image.
      e.lastAccess = this.now();
      if (e.lastAccess - e.persisted >= PERSIST_EVERY_MS) {
        e.persisted = e.lastAccess;
        const t = new Date(e.lastAccess);
        void utimes(join(this.dir, `${key}.json`), t, t).catch(() => undefined);
      }
      return { contentType: e.contentType, data };
    } catch {
      void this.drop(key);
      return null;
    }
  }

  async put(url: string, contentType: string, data: Uint8Array): Promise<void> {
    await this.ready;
    const key = hashUrl(url);
    const bin = join(this.dir, `${key}.bin`);
    const meta = join(this.dir, `${key}.json`);
    await writeFile(`${bin}.tmp`, data);
    await rename(`${bin}.tmp`, bin);
    await writeFile(`${meta}.tmp`, JSON.stringify({ contentType, size: data.byteLength }));
    await rename(`${meta}.tmp`, meta);
    const lastAccess = this.now();
    const t = new Date(lastAccess);
    await utimes(meta, t, t).catch(() => undefined);
    const old = this.index.get(key);
    if (old) this.bytes -= old.size;
    this.index.set(key, { size: data.byteLength, contentType, lastAccess, persisted: lastAccess });
    this.bytes += data.byteLength;
    void this.trim().catch(() => undefined);
  }

  private drop(key: string): Promise<unknown> {
    const e = this.index.get(key);
    if (!e) return Promise.resolve();
    this.index.delete(key);
    this.bytes -= e.size;
    return Promise.all([
      unlink(join(this.dir, `${key}.bin`)).catch(() => undefined),
      unlink(join(this.dir, `${key}.json`)).catch(() => undefined),
    ]);
  }

  private maxAgeMs = Infinity;

  /** Images not shown for longer than this are removed by trim(). */
  setMaxAgeDays(days: number): void {
    this.maxAgeMs = days * 24 * 60 * 60 * 1000;
  }

  setMaxBytes(n: number): void {
    this.maxBytes = n;
  }

  /** Remove the least recently used images until the cache is at 90% of the cap (only if it is over the cap). */
  trim(): Promise<void> {
    // Runs are queued one after another, so a run always sees the latest cap.
    this.trimming = this.trimming.then(() => this.ready).then(() => this.trimNow());
    const run = this.trimming;
    this.trimming = run.catch(() => undefined);
    return run;
  }

  private async trimNow(): Promise<void> {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [key, e] of [...this.index.entries()]) {
      if (e.lastAccess < cutoff) await this.drop(key);
    }
    if (this.bytes <= this.maxBytes) return;
    const target = this.maxBytes * 0.9;
    const byAge = [...this.index.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [key] of byAge) {
      if (this.bytes <= target) break;
      await this.drop(key);
    }
  }

  async info(): Promise<{ bytes: number; files: number }> {
    await this.ready;
    return { bytes: this.bytes, files: this.index.size };
  }

  async clear(): Promise<{ freed: number }> {
    await this.ready;
    const freed = this.bytes;
    await Promise.all([...this.index.keys()].map((key) => this.drop(key)));
    return { freed };
  }
}
