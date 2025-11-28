/**
 * Address Store Module
 *
 * Provides CRUD operations for managing tracked Ethereum addresses
 * and their associated nicknames in PostgreSQL. Used by services
 * to maintain the list of addresses being monitored.
 *
 * @module address-store
 */

import { Pool } from 'pg';
import { normalizeAddress } from './utils';
import { getPool } from './postgres';

/**
 * Represents an address record with optional nickname.
 */
export interface AddressRecord {
  /** Ethereum address (lowercase) */
  address: string;
  /** User-assigned nickname, or null */
  nickname: string | null;
}

/**
 * Ensures the addresses table exists in the database.
 * Creates the table if it doesn't exist.
 *
 * @param pool - Database connection pool
 */
async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      address TEXT PRIMARY KEY,
      nickname TEXT
    )
  `);
}

/**
 * Lists all tracked addresses ordered alphabetically.
 *
 * @returns Array of address records with nicknames
 *
 * @example
 * ```typescript
 * const addresses = await listAddresses();
 * // [{ address: '0xabc...', nickname: 'Whale1' }, ...]
 * ```
 */
export async function listAddresses(): Promise<AddressRecord[]> {
  const pool = await getPool();
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT address, nickname FROM addresses ORDER BY address ASC');
  return rows.map((row) => ({ address: row.address, nickname: row.nickname }));
}

/**
 * Adds or updates an address with an optional nickname.
 * If the address already exists, updates the nickname.
 *
 * @param address - Ethereum address to add/update
 * @param nickname - Optional display name for the address
 *
 * @example
 * ```typescript
 * await addAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f4f123', 'TopTrader');
 * ```
 */
export async function addAddress(address: string, nickname?: string | null): Promise<void> {
  const pool = await getPool();
  await ensureSchema(pool);
  const addr = normalizeAddress(address);
  await pool.query(
    'INSERT INTO addresses(address, nickname) VALUES ($1,$2) ON CONFLICT (address) DO UPDATE SET nickname = EXCLUDED.nickname',
    [addr, nickname?.trim() || null]
  );
}

/**
 * Removes an address from tracking.
 *
 * @param address - Ethereum address to remove
 *
 * @example
 * ```typescript
 * await removeAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f4f123');
 * ```
 */
export async function removeAddress(address: string): Promise<void> {
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query('DELETE FROM addresses WHERE address = $1', [normalizeAddress(address)]);
}

/**
 * Bulk inserts multiple addresses without nicknames.
 * Existing addresses are not modified (ON CONFLICT DO NOTHING).
 *
 * @param addresses - Array of Ethereum addresses to seed
 *
 * @example
 * ```typescript
 * await seedAddresses(['0xabc...', '0xdef...', '0x123...']);
 * ```
 */
export async function seedAddresses(addresses: string[]): Promise<void> {
  if (!addresses.length) return;
  const pool = await getPool();
  await ensureSchema(pool);
  const params = addresses.map((addr) => normalizeAddress(addr));
  const values = params.map((_addr, idx) => `($${idx + 1})`).join(',');
  await pool.query(`INSERT INTO addresses(address) VALUES ${values} ON CONFLICT (address) DO NOTHING`, params);
}

/**
 * Updates the nickname for an existing address, or adds it if not present.
 * Alias for addAddress() for semantic clarity.
 *
 * @param address - Ethereum address
 * @param nickname - New nickname, or null to clear
 */
export async function upsertNickname(address: string, nickname: string | null): Promise<void> {
  await addAddress(address, nickname);
}
