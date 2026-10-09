import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

export type Logger = pino.Logger;

const REDACT = [
  'password',
  'accessToken',
  'refreshToken',
  'authorization',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.secret',
];

function rotate(file: string, maxBytes: number, keep: number): void {
  try {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    const oldest = `${file}.${keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch {
    /* best effort */
  }
}

export function createLogger(dir: string, name: string, verbose: boolean): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.log`);
  rotate(file, 5 * 1024 * 1024, 5);
  return pino(
    { level: verbose ? 'debug' : 'info', redact: { paths: REDACT, censor: '[redacted]' } },
    pino.destination({ dest: file, sync: false }),
  );
}
