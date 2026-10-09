// Secrets live in ONE safeStorage-encrypted blob (DPAPI on Windows). No plaintext fallback.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppException } from '../../shared/errors';
import type { SecretRecord } from '../../shared/internal';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type SecretMap = Record<string, SecretRecord & Record<string, unknown>>;

export class SecretStore {
  private data: SecretMap = {};
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly safe: SafeStorageLike,
  ) {}

  get available(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: Buffer;
    try {
      raw = await readFile(this.file);
    } catch {
      return; // first run
    }
    if (!this.safe.isEncryptionAvailable()) return; // keep file untouched; reads return nothing
    try {
      this.data = JSON.parse(this.safe.decryptString(raw)) as SecretMap;
    } catch {
      // Unreadable (different Windows user / corrupted). Keep a copy and start empty.
      await rename(this.file, `${this.file}.corrupt`).catch(() => undefined);
      this.data = {};
    }
  }

  get(key: string): SecretRecord | undefined {
    return this.data[key];
  }

  async set(key: string, value: SecretRecord): Promise<void> {
    this.requireEncryption();
    this.data[key] = { ...(this.data[key] ?? {}), ...value };
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.data)) return;
    delete this.data[key];
    await this.persist();
  }

  private requireEncryption(): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new AppException(
        'INTERNAL',
        'Windows secure storage is not available, so passwords cannot be saved safely.',
      );
    }
  }

  /** Atomic write: temp file then rename. Serialised so concurrent sets cannot interleave. */
  private persist(): Promise<void> {
    this.requireEncryption();
    const run = async () => {
      const blob = this.safe.encryptString(JSON.stringify(this.data));
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, blob);
      await rename(tmp, this.file);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
