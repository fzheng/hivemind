/**
 * Database Migration Runner
 *
 * Runs SQL migrations from db/migrations directory automatically on startup.
 * Uses a schema_migrations table to track which migrations have been applied.
 *
 * Migrations:
 * - Are idempotent (safe to run multiple times)
 * - Run in alphabetical order by filename
 * - Use transaction safety for each migration
 * - Track applied versions in schema_migrations table
 *
 * @module migrate
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPool } from './postgres';
import { createLogger } from './logger';

const logger = createLogger('migrate');

/**
 * Gets the migrations directory path.
 * Defaults to db/migrations from the project root.
 *
 * @returns Path to migrations directory
 */
function getMigrationsDir(): string {
  // When running from services, go up to find project root
  const candidates = [
    path.resolve(process.cwd(), 'db', 'migrations'),
    path.resolve(__dirname, '..', '..', '..', 'db', 'migrations'),
    path.resolve(__dirname, '..', '..', '..', '..', 'db', 'migrations'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  // Default fallback
  return path.resolve(process.cwd(), 'db', 'migrations');
}

/**
 * Gets list of migration files sorted alphabetically.
 *
 * @param dir - Migrations directory path
 * @returns Array of migration filenames
 */
function getMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort(); // Lexicographic order: 001_..., 002_..., etc.
}

/**
 * Ensures the schema_migrations table exists.
 *
 * @returns Promise that resolves when table is ready
 */
async function ensureMigrationsTable(): Promise<void> {
  const pool = await getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Gets set of already-applied migration versions.
 *
 * @returns Set of applied version names
 */
async function getAppliedVersions(): Promise<Set<string>> {
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version ASC'
  );
  return new Set(rows.map((r: { version: string }) => r.version));
}

/**
 * Applies a single migration within a transaction.
 *
 * @param version - Migration filename/version
 * @param sql - SQL content to execute
 * @returns Promise that resolves when migration is applied
 */
async function applyMigration(version: string, sql: string): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT (version) DO NOTHING',
      [version]
    );
    await client.query('COMMIT');
    logger.info('migration_applied', { version });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs all pending database migrations.
 *
 * This function:
 * 1. Creates schema_migrations table if needed
 * 2. Finds all migration files in db/migrations
 * 3. Applies any migrations not yet tracked
 * 4. Records each applied migration
 *
 * Safe to call multiple times - idempotent.
 *
 * @returns Object with count of applied migrations
 *
 * @example
 * ```typescript
 * // Run at service startup
 * await runMigrations();
 * ```
 */
export async function runMigrations(): Promise<{ applied: number; total: number }> {
  const dir = getMigrationsDir();

  // If migrations directory doesn't exist, nothing to do
  if (!fs.existsSync(dir)) {
    logger.info('no_migrations_dir', { dir });
    return { applied: 0, total: 0 };
  }

  await ensureMigrationsTable();

  const files = getMigrationFiles(dir);
  const appliedVersions = await getAppliedVersions();

  let appliedCount = 0;

  for (const file of files) {
    const version = file; // Use full filename as version key

    if (appliedVersions.has(version)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');

    try {
      await applyMigration(version, sql);
      appliedCount++;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('migration_failed', { version, error: errorMessage });
      throw new Error(`Migration ${version} failed: ${errorMessage}`);
    }
  }

  if (appliedCount > 0) {
    logger.info('migrations_complete', { applied: appliedCount, total: files.length });
  } else {
    logger.info('migrations_up_to_date', { total: files.length });
  }

  return { applied: appliedCount, total: files.length };
}

/**
 * Gets the current migration status.
 *
 * @returns Object with applied and pending migrations
 */
export async function getMigrationStatus(): Promise<{
  applied: string[];
  pending: string[];
}> {
  const dir = getMigrationsDir();

  if (!fs.existsSync(dir)) {
    return { applied: [], pending: [] };
  }

  await ensureMigrationsTable();

  const files = getMigrationFiles(dir);
  const appliedVersions = await getAppliedVersions();

  const applied = files.filter((f) => appliedVersions.has(f));
  const pending = files.filter((f) => !appliedVersions.has(f));

  return { applied, pending };
}
