import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, SERVER_ROOT } from '../config/env.js';
import { closeDb, getDb } from './connection.js';
import { logger } from '../utils/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate schema.sql whether we are running from `src` (tsx) or `dist` (node).
 * The build copies the file next to the compiled module, but the fallback keeps
 * a `tsc`-only build working rather than failing at boot.
 */
function resolveSchemaPath(): string {
  const candidates = [
    path.join(here, 'schema.sql'),
    path.join(SERVER_ROOT, 'src', 'db', 'schema.sql'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`schema.sql not found. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

const SCHEMA_PATH = resolveSchemaPath();

/** Create the schema if it does not exist. Safe to call repeatedly. */
export function migrate(): void {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const db = getDb();
  db.exec(sql);
  logger.info({ schema: SCHEMA_PATH }, 'Schema applied');
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const fresh = process.argv.includes('--fresh');
  if (fresh && config.db.file !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${config.db.file}${suffix}`;
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        logger.warn({ file }, 'Removed existing database file');
      }
    }
  }
  try {
    migrate();
    console.log(`Database ready at ${config.db.file}`);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

export { SERVER_ROOT };
