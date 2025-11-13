import { Pool } from 'pg';
import { normalizeAddress } from './utils';
import { getPool } from './postgres';

export interface AddressRecord {
  address: string;
  nickname: string | null;
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      address TEXT PRIMARY KEY,
      nickname TEXT
    )
  `);
}

export async function listAddresses(): Promise<AddressRecord[]> {
  const pool = await getPool();
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT address, nickname FROM addresses ORDER BY address ASC');
  return rows.map((row) => ({ address: row.address, nickname: row.nickname }));
}

export async function addAddress(address: string, nickname?: string | null): Promise<void> {
  const pool = await getPool();
  await ensureSchema(pool);
  const addr = normalizeAddress(address);
  await pool.query(
    'INSERT INTO addresses(address, nickname) VALUES ($1,$2) ON CONFLICT (address) DO UPDATE SET nickname = EXCLUDED.nickname',
    [addr, nickname?.trim() || null]
  );
}

export async function removeAddress(address: string): Promise<void> {
  const pool = await getPool();
  await ensureSchema(pool);
  await pool.query('DELETE FROM addresses WHERE address = $1', [normalizeAddress(address)]);
}

export async function seedAddresses(addresses: string[]): Promise<void> {
  if (!addresses.length) return;
  const pool = await getPool();
  await ensureSchema(pool);
  const params = addresses.map((addr) => normalizeAddress(addr));
  const values = params.map((_addr, idx) => `($${idx + 1})`).join(',');
  await pool.query(`INSERT INTO addresses(address) VALUES ${values} ON CONFLICT (address) DO NOTHING`, params);
}

export async function upsertNickname(address: string, nickname: string | null): Promise<void> {
  await addAddress(address, nickname);
}
