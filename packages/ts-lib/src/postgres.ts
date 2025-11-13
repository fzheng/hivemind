import { Pool, type PoolConfig } from 'pg';

let pool: Pool | null = null;

export async function getPool(config?: PoolConfig): Promise<Pool> {
  if (pool) return pool;
  const connectionString =
    config?.connectionString ||
    process.env.PG_CONNECTION_STRING ||
    process.env.DATABASE_URL ||
    `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'postgres'}`;
  pool = new Pool({ connectionString, ...config });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
