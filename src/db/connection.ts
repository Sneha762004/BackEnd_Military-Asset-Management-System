import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

export type Db = Database.Database;

let instance: Db | null = null;

/**
 * Single shared connection.
 *
 * SQLite is a single-writer engine, and `better-sqlite3` is synchronous. That
 * sounds limiting, but for this workload it is a feature: every multi-statement
 * business operation (write document + post ledger lines + validate stock) runs
 * inside one `db.transaction(...)` and is therefore atomic with zero chance of
 * interleaving. See docs/DATABASE.md for how this maps to PostgreSQL + row locks.
 *
 * Pragmas:
 *  - `journal_mode = WAL`  : concurrent readers while a write transaction runs.
 *  - `foreign_keys = ON`   : SQLite ignores FKs by default; without this the
 *                           schema's referential integrity is decorative.
 *  - `synchronous = NORMAL`: safe with WAL, ~an order of magnitude faster.
 *  - `busy_timeout`        : wait rather than throw SQLITE_BUSY under contention.
 */
export function getDb(): Db {
  if (instance) return instance;

  if (config.db.file !== ':memory:') {
    fs.mkdirSync(path.dirname(config.db.file), { recursive: true });
  }

  const db = new Database(config.db.file);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  instance = db;
  logger.info({ file: config.db.file }, 'SQLite connection established');
  return db;
}

export function closeDb(): void {
  if (!instance) return;
  try {
    instance.pragma('wal_checkpoint(TRUNCATE)');
    instance.close();
  } catch (error) {
    logger.warn({ err: error }, 'Error while closing the database');
  } finally {
    instance = null;
  }
}

/**
 * Run `fn` inside an IMMEDIATE transaction.
 *
 * IMMEDIATE takes the write lock up front, which turns "read stock, then decide"
 * sequences into a safe read-modify-write instead of a deferred transaction that
 * can fail to upgrade under contention (SQLITE_BUSY_SNAPSHOT).
 */
export function inTransaction<T>(fn: (db: Db) => T): T {
  const db = getDb();
  // The callback signature is `(db) => T`, so better-sqlite3's `.immediate()`
  // is typed to take that same single argument.
  return db.transaction(fn).immediate(db);
}

export const nowIso = (): string => new Date().toISOString();
