import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations';

export type { Db };

export interface OpenOptions {
  /** Path to better_sqlite3.node; only needed for unusual setups. */
  nativeBinding?: string;
  migrations?: Migration[];
}

/** Apply pending migrations in one transaction each. Returns the final user_version. */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].version === sorted[i - 1].version) {
      throw new Error(`Duplicate migration version ${sorted[i].version}`);
    }
  }
  for (const m of sorted) {
    if (m.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    apply();
  }
  return db.pragma('user_version', { simple: true }) as number;
}

export function openDatabase(file: string, opts: OpenOptions = {}): Db {
  const db = opts.nativeBinding
    ? new Database(file, { nativeBinding: opts.nativeBinding })
    : new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db, opts.migrations);
  return db;
}
