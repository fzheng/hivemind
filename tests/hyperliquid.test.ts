/**
 * Tests for hyperliquid module functions
 * Tests the data transformation and filtering logic
 */

// Types for Hyperliquid fills
interface UserFill {
  coin: string;
  px: number;
  sz: number;
  side: 'B' | 'A';
  time: number;
  startPosition: number;
  closedPnl?: number;
  fee?: number;
  feeToken?: string;
  hash?: string;
}

// Helper functions extracted from hyperliquid.ts for testing
function isBtcCoin(coin: unknown): boolean {
  return typeof coin === 'string' && /^btc$/i.test(coin);
}

function isEthCoin(coin: unknown): boolean {
  return typeof coin === 'string' && /^eth$/i.test(coin);
}

function isBtcOrEthCoin(coin: unknown): boolean {
  return isBtcCoin(coin) || isEthCoin(coin);
}

// Transform raw fill data to UserFill
function transformFill(f: Record<string, unknown>): UserFill | null {
  const coin = f.coin;
  if (!isBtcOrEthCoin(coin)) return null;

  const px = Number(f.px);
  const sz = Number(f.sz);
  const time = Number(f.time);
  const start = Number(f.startPosition);
  const closedRaw = f.closedPnl;
  const feeRaw = f.fee;
  const feeToken = typeof f.feeToken === 'string' ? String(f.feeToken) : undefined;
  const hash = typeof f.hash === 'string' ? String(f.hash) : undefined;
  const side = (f.side === 'B' ? 'B' : 'A') as 'B' | 'A';

  if (!Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(time) || !Number.isFinite(start)) {
    return null;
  }

  const closed = Number.isFinite(Number(closedRaw)) ? Number(closedRaw) : undefined;
  const fee = Number.isFinite(Number(feeRaw)) ? Number(feeRaw) : undefined;

  return {
    coin: String(coin).toUpperCase(),
    px,
    sz,
    side,
    time,
    startPosition: start,
    closedPnl: closed,
    fee,
    feeToken,
    hash,
  };
}

// Filter fills by symbols
function filterBySymbols(fills: UserFill[], symbols: ('BTC' | 'ETH')[]): UserFill[] {
  return fills.filter(f => symbols.includes(f.coin as 'BTC' | 'ETH'));
}

describe('isBtcCoin', () => {
  test('accepts BTC in various cases', () => {
    expect(isBtcCoin('BTC')).toBe(true);
    expect(isBtcCoin('btc')).toBe(true);
    expect(isBtcCoin('Btc')).toBe(true);
    expect(isBtcCoin('bTc')).toBe(true);
  });

  test('rejects non-BTC strings', () => {
    expect(isBtcCoin('ETH')).toBe(false);
    expect(isBtcCoin('SOL')).toBe(false);
    expect(isBtcCoin('BITCOIN')).toBe(false);
    expect(isBtcCoin('')).toBe(false);
  });

  test('rejects non-string values', () => {
    expect(isBtcCoin(null)).toBe(false);
    expect(isBtcCoin(undefined)).toBe(false);
    expect(isBtcCoin(123)).toBe(false);
    expect(isBtcCoin({ coin: 'BTC' })).toBe(false);
  });
});

describe('isEthCoin', () => {
  test('accepts ETH in various cases', () => {
    expect(isEthCoin('ETH')).toBe(true);
    expect(isEthCoin('eth')).toBe(true);
    expect(isEthCoin('Eth')).toBe(true);
    expect(isEthCoin('eTh')).toBe(true);
  });

  test('rejects non-ETH strings', () => {
    expect(isEthCoin('BTC')).toBe(false);
    expect(isEthCoin('SOL')).toBe(false);
    expect(isEthCoin('ETHEREUM')).toBe(false);
    expect(isEthCoin('')).toBe(false);
  });

  test('rejects non-string values', () => {
    expect(isEthCoin(null)).toBe(false);
    expect(isEthCoin(undefined)).toBe(false);
    expect(isEthCoin(123)).toBe(false);
  });
});

describe('isBtcOrEthCoin', () => {
  test('accepts both BTC and ETH', () => {
    expect(isBtcOrEthCoin('BTC')).toBe(true);
    expect(isBtcOrEthCoin('btc')).toBe(true);
    expect(isBtcOrEthCoin('ETH')).toBe(true);
    expect(isBtcOrEthCoin('eth')).toBe(true);
  });

  test('rejects other coins', () => {
    expect(isBtcOrEthCoin('SOL')).toBe(false);
    expect(isBtcOrEthCoin('DOGE')).toBe(false);
    expect(isBtcOrEthCoin('ARB')).toBe(false);
  });
});

describe('transformFill', () => {
  test('transforms valid BTC fill correctly', () => {
    const rawFill = {
      coin: 'BTC',
      px: 95000.50,
      sz: 0.1,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
      closedPnl: 0,
      fee: 5.25,
      feeToken: 'USDC',
      hash: '0xabcdef123456',
    };

    const result = transformFill(rawFill);

    expect(result).not.toBeNull();
    expect(result!.coin).toBe('BTC');
    expect(result!.px).toBe(95000.50);
    expect(result!.sz).toBe(0.1);
    expect(result!.side).toBe('B');
    expect(result!.time).toBe(1732550000000);
    expect(result!.startPosition).toBe(0);
    expect(result!.closedPnl).toBe(0);
    expect(result!.fee).toBe(5.25);
    expect(result!.feeToken).toBe('USDC');
    expect(result!.hash).toBe('0xabcdef123456');
  });

  test('transforms valid ETH fill correctly', () => {
    const rawFill = {
      coin: 'eth',
      px: 3500.00,
      sz: 1.5,
      side: 'A',
      time: 1732550000000,
      startPosition: 2.0,
      closedPnl: 150.00,
      fee: 2.50,
      feeToken: 'USDC',
      hash: '0x123456',
    };

    const result = transformFill(rawFill);

    expect(result).not.toBeNull();
    expect(result!.coin).toBe('ETH');
    expect(result!.side).toBe('A');
    expect(result!.closedPnl).toBe(150.00);
  });

  test('returns null for non-BTC/ETH coins', () => {
    const rawFill = {
      coin: 'SOL',
      px: 100.00,
      sz: 10,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
    };

    expect(transformFill(rawFill)).toBeNull();
  });

  test('returns null for invalid numeric fields', () => {
    const rawFill = {
      coin: 'BTC',
      px: 'invalid',
      sz: 0.1,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
    };

    expect(transformFill(rawFill)).toBeNull();
  });

  test('returns null for NaN time', () => {
    const rawFill = {
      coin: 'BTC',
      px: 95000,
      sz: 0.1,
      side: 'B',
      time: NaN,
      startPosition: 0,
    };

    expect(transformFill(rawFill)).toBeNull();
  });

  test('returns null for infinite values', () => {
    const rawFill = {
      coin: 'BTC',
      px: Infinity,
      sz: 0.1,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
    };

    expect(transformFill(rawFill)).toBeNull();
  });

  test('handles missing optional fields', () => {
    const rawFill = {
      coin: 'BTC',
      px: 95000,
      sz: 0.1,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
    };

    const result = transformFill(rawFill);

    expect(result).not.toBeNull();
    expect(result!.closedPnl).toBeUndefined();
    expect(result!.fee).toBeUndefined();
    expect(result!.feeToken).toBeUndefined();
    expect(result!.hash).toBeUndefined();
  });

  test('handles string numeric values', () => {
    const rawFill = {
      coin: 'BTC',
      px: '95000.50',
      sz: '0.1',
      side: 'B',
      time: '1732550000000',
      startPosition: '0',
      closedPnl: '100.50',
      fee: '5.25',
    };

    const result = transformFill(rawFill);

    expect(result).not.toBeNull();
    expect(result!.px).toBe(95000.50);
    expect(result!.sz).toBe(0.1);
    expect(result!.closedPnl).toBe(100.50);
    expect(result!.fee).toBe(5.25);
  });

  test('normalizes coin to uppercase', () => {
    const rawFill = {
      coin: 'btc',
      px: 95000,
      sz: 0.1,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
    };

    const result = transformFill(rawFill);
    expect(result!.coin).toBe('BTC');
  });

  test('defaults side to A if not B', () => {
    const rawFill = {
      coin: 'BTC',
      px: 95000,
      sz: 0.1,
      side: 'S', // Not 'B', should become 'A'
      time: 1732550000000,
      startPosition: 0,
    };

    const result = transformFill(rawFill);
    expect(result!.side).toBe('A');
  });

  test('handles null closedPnl and fee', () => {
    const rawFill = {
      coin: 'BTC',
      px: 95000,
      sz: 0.1,
      side: 'B',
      time: 1732550000000,
      startPosition: 0,
      closedPnl: null,
      fee: null,
    };

    const result = transformFill(rawFill);
    // null converts to 0 via Number(null), which is finite, so it becomes 0
    expect(result!.closedPnl).toBe(0);
    expect(result!.fee).toBe(0);
  });
});

describe('filterBySymbols', () => {
  const fills: UserFill[] = [
    { coin: 'BTC', px: 95000, sz: 0.1, side: 'B', time: 1000, startPosition: 0 },
    { coin: 'ETH', px: 3500, sz: 1.0, side: 'A', time: 2000, startPosition: 0 },
    { coin: 'BTC', px: 95100, sz: 0.2, side: 'A', time: 3000, startPosition: 0.1 },
  ];

  test('filters to BTC only', () => {
    const result = filterBySymbols(fills, ['BTC']);
    expect(result).toHaveLength(2);
    expect(result.every(f => f.coin === 'BTC')).toBe(true);
  });

  test('filters to ETH only', () => {
    const result = filterBySymbols(fills, ['ETH']);
    expect(result).toHaveLength(1);
    expect(result[0].coin).toBe('ETH');
  });

  test('includes both BTC and ETH', () => {
    const result = filterBySymbols(fills, ['BTC', 'ETH']);
    expect(result).toHaveLength(3);
  });

  test('handles empty fills array', () => {
    const result = filterBySymbols([], ['BTC', 'ETH']);
    expect(result).toHaveLength(0);
  });

  test('handles empty symbols array', () => {
    const result = filterBySymbols(fills, []);
    expect(result).toHaveLength(0);
  });
});

describe('fill sorting', () => {
  test('sorts fills by time descending (newest first)', () => {
    const fills: UserFill[] = [
      { coin: 'BTC', px: 95000, sz: 0.1, side: 'B', time: 1000, startPosition: 0 },
      { coin: 'BTC', px: 95100, sz: 0.1, side: 'B', time: 3000, startPosition: 0 },
      { coin: 'BTC', px: 95050, sz: 0.1, side: 'B', time: 2000, startPosition: 0 },
    ];

    const sorted = [...fills].sort((a, b) => b.time - a.time);

    expect(sorted[0].time).toBe(3000);
    expect(sorted[1].time).toBe(2000);
    expect(sorted[2].time).toBe(1000);
  });
});

describe('action determination from fill', () => {
  function determineAction(fill: { side: 'B' | 'A'; startPosition: number; sz: number }): string {
    const delta = fill.side === 'B' ? fill.sz : -fill.sz;
    const newPos = fill.startPosition + delta;

    if (fill.startPosition === 0) {
      return delta > 0 ? 'Open Long (Open New)' : 'Open Short (Open New)';
    } else if (fill.startPosition > 0) {
      if (delta > 0) return 'Increase Long';
      return newPos === 0 ? 'Close Long (Close All)' : 'Decrease Long';
    } else {
      if (delta < 0) return 'Increase Short';
      return newPos === 0 ? 'Close Short (Close All)' : 'Decrease Short';
    }
  }

  test('determines Open Long for buy with no position', () => {
    expect(determineAction({ side: 'B', startPosition: 0, sz: 0.1 })).toBe('Open Long (Open New)');
  });

  test('determines Open Short for sell with no position', () => {
    expect(determineAction({ side: 'A', startPosition: 0, sz: 0.1 })).toBe('Open Short (Open New)');
  });

  test('determines Increase Long for buy with existing long', () => {
    expect(determineAction({ side: 'B', startPosition: 0.5, sz: 0.1 })).toBe('Increase Long');
  });

  test('determines Decrease Long for sell with existing long', () => {
    expect(determineAction({ side: 'A', startPosition: 0.5, sz: 0.2 })).toBe('Decrease Long');
  });

  test('determines Close Long for sell that closes entire long', () => {
    expect(determineAction({ side: 'A', startPosition: 0.5, sz: 0.5 })).toBe('Close Long (Close All)');
  });

  test('determines Increase Short for sell with existing short', () => {
    expect(determineAction({ side: 'A', startPosition: -0.5, sz: 0.1 })).toBe('Increase Short');
  });

  test('determines Decrease Short for buy with existing short', () => {
    expect(determineAction({ side: 'B', startPosition: -0.5, sz: 0.2 })).toBe('Decrease Short');
  });

  test('determines Close Short for buy that closes entire short', () => {
    expect(determineAction({ side: 'B', startPosition: -0.5, sz: 0.5 })).toBe('Close Short (Close All)');
  });
});

describe('fill data validation', () => {
  test('validates required numeric fields are finite', () => {
    const isValidFill = (f: Record<string, unknown>): boolean => {
      const px = Number(f.px);
      const sz = Number(f.sz);
      const time = Number(f.time);
      const start = Number(f.startPosition);
      return Number.isFinite(px) && Number.isFinite(sz) && Number.isFinite(time) && Number.isFinite(start);
    };

    expect(isValidFill({ px: 95000, sz: 0.1, time: 1000, startPosition: 0 })).toBe(true);
    expect(isValidFill({ px: NaN, sz: 0.1, time: 1000, startPosition: 0 })).toBe(false);
    expect(isValidFill({ px: 95000, sz: Infinity, time: 1000, startPosition: 0 })).toBe(false);
    expect(isValidFill({ px: 95000, sz: 0.1, time: 'invalid', startPosition: 0 })).toBe(false);
  });
});
