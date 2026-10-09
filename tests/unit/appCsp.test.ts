import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_CSP } from '../../src/shared/appCsp';

describe('app shell CSP', () => {
  it('allows the local image scheme and no direct internet images', () => {
    expect(APP_CSP).toContain("img-src 'self' data: letterdock-img:");
    expect(APP_CSP).not.toMatch(/https?:/);
  });
  it('is the only copy: the build config and main both use it', () => {
    const cfg = readFileSync(join(__dirname, '../../electron.vite.config.ts'), 'utf8');
    const main = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
    expect(cfg).toContain('APP_CSP');
    expect(main).toContain('APP_CSP');
    expect(cfg).not.toMatch(/img-src/);
    expect(main).not.toMatch(/img-src/);
  });
});
