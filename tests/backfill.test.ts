/**
 * Tests for backfill fills logic
 * Tests the data transformation and filtering logic used in backfill
 */

interface BackfillFill {
  id: number;
  time_utc: string;
  address: string;
  symbol: string;
  action: string;
  size_signed: number | null;
  previous_position: number | null;
  price_usd: number | null;
  closed_pnl_usd: number | null;
  tx_hash: string | null;
}

// Simulates the SQL CASE logic for size_signed calculation
function calculateSizeSigned(action: string, size: number): number {
  switch (action) {
    case 'Increase Long':
    case 'Decrease Short':
    case 'Close Short':
    case 'Open Long':
      return size;
    case 'Decrease Long':
    case 'Close Long':
    case 'Increase Short':
    case 'Open Short':
      return -size;
    default:
      return size;
  }
}

// Simulates BTC/ETH filtering logic
function isBtcOrEth(symbol: string | null): boolean {
  if (!symbol) return true; // Legacy null symbol assumed BTC
  const upper = symbol.toUpperCase();
  return upper === 'BTC' || upper === 'ETH';
}

// Transform raw DB row to BackfillFill
function transformRow(row: Record<string, unknown>): BackfillFill {
  return {
    id: Number(row.id),
    time_utc: String(row.time_utc),
    address: String(row.address),
    symbol: String(row.symbol || 'BTC'),
    action: String(row.action || ''),
    size_signed: row.size_signed != null ? Number(row.size_signed) : null,
    previous_position: row.previous_position != null ? Number(row.previous_position) : null,
    price_usd: row.price_usd != null ? Number(row.price_usd) : null,
    closed_pnl_usd: row.closed_pnl_usd != null ? Number(row.closed_pnl_usd) : null,
    tx_hash: row.tx_hash ? String(row.tx_hash) : null,
  };
}

// Calculate hasMore from response
function hasMoreFills(rows: unknown[], limit: number): boolean {
  return rows.length > limit;
}

describe('calculateSizeSigned', () => {
  test('returns positive size for long-increasing actions', () => {
    expect(calculateSizeSigned('Increase Long', 0.5)).toBe(0.5);
    expect(calculateSizeSigned('Open Long', 1.0)).toBe(1.0);
  });

  test('returns positive size for short-decreasing actions', () => {
    expect(calculateSizeSigned('Decrease Short', 0.5)).toBe(0.5);
    expect(calculateSizeSigned('Close Short', 1.0)).toBe(1.0);
  });

  test('returns negative size for long-decreasing actions', () => {
    expect(calculateSizeSigned('Decrease Long', 0.5)).toBe(-0.5);
    expect(calculateSizeSigned('Close Long', 1.0)).toBe(-1.0);
  });

  test('returns negative size for short-increasing actions', () => {
    expect(calculateSizeSigned('Increase Short', 0.5)).toBe(-0.5);
    expect(calculateSizeSigned('Open Short', 1.0)).toBe(-1.0);
  });

  test('returns original size for unknown actions', () => {
    expect(calculateSizeSigned('Unknown', 0.5)).toBe(0.5);
    expect(calculateSizeSigned('', 1.0)).toBe(1.0);
  });
});

describe('isBtcOrEth', () => {
  test('accepts BTC symbol', () => {
    expect(isBtcOrEth('BTC')).toBe(true);
    expect(isBtcOrEth('btc')).toBe(true);
    expect(isBtcOrEth('Btc')).toBe(true);
  });

  test('accepts ETH symbol', () => {
    expect(isBtcOrEth('ETH')).toBe(true);
    expect(isBtcOrEth('eth')).toBe(true);
    expect(isBtcOrEth('Eth')).toBe(true);
  });

  test('accepts null symbol (legacy BTC)', () => {
    expect(isBtcOrEth(null)).toBe(true);
  });

  test('rejects other symbols', () => {
    expect(isBtcOrEth('SOL')).toBe(false);
    expect(isBtcOrEth('DOGE')).toBe(false);
    expect(isBtcOrEth('ARB')).toBe(false);
  });
});

describe('transformRow', () => {
  test('transforms complete row correctly', () => {
    const row = {
      id: 123,
      time_utc: '2025-11-25T12:00:00Z',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      symbol: 'BTC',
      action: 'Open Long',
      size_signed: 0.5,
      previous_position: 0,
      price_usd: 95000,
      closed_pnl_usd: null,
      tx_hash: '0xabcdef',
    };

    const result = transformRow(row);

    expect(result.id).toBe(123);
    expect(result.time_utc).toBe('2025-11-25T12:00:00Z');
    expect(result.address).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(result.symbol).toBe('BTC');
    expect(result.action).toBe('Open Long');
    expect(result.size_signed).toBe(0.5);
    expect(result.previous_position).toBe(0);
    expect(result.price_usd).toBe(95000);
    expect(result.closed_pnl_usd).toBeNull();
    expect(result.tx_hash).toBe('0xabcdef');
  });

  test('handles null symbol as BTC', () => {
    const row = {
      id: 1,
      time_utc: '2025-11-25T12:00:00Z',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      symbol: null,
      action: 'Open Long',
      size_signed: 0.5,
      previous_position: null,
      price_usd: null,
      closed_pnl_usd: null,
      tx_hash: null,
    };

    const result = transformRow(row);
    expect(result.symbol).toBe('BTC');
  });

  test('handles null values correctly', () => {
    const row = {
      id: 1,
      time_utc: '2025-11-25T12:00:00Z',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      symbol: 'ETH',
      action: null,
      size_signed: null,
      previous_position: null,
      price_usd: null,
      closed_pnl_usd: null,
      tx_hash: null,
    };

    const result = transformRow(row);
    expect(result.action).toBe('');
    expect(result.size_signed).toBeNull();
    expect(result.previous_position).toBeNull();
    expect(result.price_usd).toBeNull();
    expect(result.closed_pnl_usd).toBeNull();
    expect(result.tx_hash).toBeNull();
  });

  test('converts string numbers to numbers', () => {
    const row = {
      id: '456',
      time_utc: '2025-11-25T12:00:00Z',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      symbol: 'BTC',
      action: 'Close Long',
      size_signed: '0.123',
      previous_position: '1.5',
      price_usd: '96000.50',
      closed_pnl_usd: '250.75',
      tx_hash: '0xhash123',
    };

    const result = transformRow(row);
    expect(result.id).toBe(456);
    expect(result.size_signed).toBe(0.123);
    expect(result.previous_position).toBe(1.5);
    expect(result.price_usd).toBe(96000.50);
    expect(result.closed_pnl_usd).toBe(250.75);
  });
});

describe('hasMoreFills', () => {
  test('returns true when rows exceed limit', () => {
    const rows = Array(51).fill({});
    expect(hasMoreFills(rows, 50)).toBe(true);
  });

  test('returns false when rows equal limit', () => {
    const rows = Array(50).fill({});
    expect(hasMoreFills(rows, 50)).toBe(false);
  });

  test('returns false when rows less than limit', () => {
    const rows = Array(30).fill({});
    expect(hasMoreFills(rows, 50)).toBe(false);
  });

  test('returns false for empty rows', () => {
    expect(hasMoreFills([], 50)).toBe(false);
  });
});

describe('backfill pagination logic', () => {
  test('correctly determines oldestTime from fills array', () => {
    const fills: BackfillFill[] = [
      { id: 3, time_utc: '2025-11-25T12:02:00Z', address: '0x1', symbol: 'BTC', action: '', size_signed: null, previous_position: null, price_usd: null, closed_pnl_usd: null, tx_hash: null },
      { id: 2, time_utc: '2025-11-25T12:01:00Z', address: '0x1', symbol: 'BTC', action: '', size_signed: null, previous_position: null, price_usd: null, closed_pnl_usd: null, tx_hash: null },
      { id: 1, time_utc: '2025-11-25T12:00:00Z', address: '0x1', symbol: 'BTC', action: '', size_signed: null, previous_position: null, price_usd: null, closed_pnl_usd: null, tx_hash: null },
    ];

    const oldestTime = fills.length > 0 ? fills[fills.length - 1].time_utc : null;
    expect(oldestTime).toBe('2025-11-25T12:00:00Z');
  });

  test('returns null oldestTime for empty fills', () => {
    const fills: BackfillFill[] = [];
    const oldestTime = fills.length > 0 ? fills[fills.length - 1].time_utc : null;
    expect(oldestTime).toBeNull();
  });
});

describe('address filtering logic', () => {
  test('normalizes addresses to lowercase', () => {
    const addresses = [
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    ];

    const normalized = addresses.map(a => a.toLowerCase());

    expect(normalized).toEqual([
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  test('handles empty address array', () => {
    const addresses: string[] = [];
    const normalized = addresses.map(a => a.toLowerCase());
    expect(normalized).toEqual([]);
  });
});

describe('limit validation', () => {
  test('clamps limit to minimum of 1', () => {
    const safeLimit = (limit: number) => Math.max(1, Math.min(100, limit));
    expect(safeLimit(0)).toBe(1);
    expect(safeLimit(-5)).toBe(1);
  });

  test('clamps limit to maximum of 100', () => {
    const safeLimit = (limit: number) => Math.max(1, Math.min(100, limit));
    expect(safeLimit(150)).toBe(100);
    expect(safeLimit(1000)).toBe(100);
  });

  test('preserves valid limits', () => {
    const safeLimit = (limit: number) => Math.max(1, Math.min(100, limit));
    expect(safeLimit(50)).toBe(50);
    expect(safeLimit(1)).toBe(1);
    expect(safeLimit(100)).toBe(100);
  });

  test('defaults undefined to 50', () => {
    const safeLimit = (limit?: number) => Math.max(1, Math.min(100, limit ?? 50));
    expect(safeLimit(undefined)).toBe(50);
    expect(safeLimit()).toBe(50);
  });
});
