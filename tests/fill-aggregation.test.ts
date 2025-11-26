/**
 * Tests for fill aggregation logic
 * This mirrors the aggregateFills function in dashboard.js
 */

interface Fill {
  time_utc: string;
  address: string;
  symbol: string;
  action: string;
  size_signed: number | null;
  previous_position: number | null;
  price_usd: number | null;
  closed_pnl_usd: number | null;
}

interface AggregatedFill extends Fill {
  fills: Fill[];
  totalSize: number;
  totalPnl: number;
  prices: number[];
  oldest_time: string;
  isAggregated: boolean;
  fillCount: number;
  avgPrice: number | null;
}

const AGGREGATION_WINDOW_MS = 60000; // 1 minute

function finalizeGroup(group: AggregatedFill): void {
  group.isAggregated = group.fills.length > 1;
  group.fillCount = group.fills.length;
  group.avgPrice = group.prices.length > 0
    ? group.prices.reduce((a, b) => a + b, 0) / group.prices.length
    : null;
  const isShort = group.action.toLowerCase().includes('short');
  const isDecrease = group.action.toLowerCase().includes('decrease') || group.action.toLowerCase().includes('close');
  group.size_signed = isShort || isDecrease ? -group.totalSize : group.totalSize;
  group.closed_pnl_usd = group.totalPnl || null;
  group.price_usd = group.avgPrice;
}

function aggregateFills(fills: Fill[]): AggregatedFill[] {
  if (!fills.length) return [];

  const aggregated: AggregatedFill[] = [];
  let currentGroup: AggregatedFill | null = null;

  // Sort by time descending (newest first)
  const sorted = [...fills].sort((a, b) =>
    new Date(b.time_utc).getTime() - new Date(a.time_utc).getTime()
  );

  for (const fill of sorted) {
    const fillTime = new Date(fill.time_utc).getTime();
    const symbol = (fill.symbol || 'BTC').toUpperCase();
    const action = fill.action || '';
    const address = fill.address;

    if (currentGroup) {
      const groupTime = new Date(currentGroup.time_utc).getTime();
      const timeDiff = Math.abs(groupTime - fillTime);
      const sameAddress = currentGroup.address === address;
      const sameSymbol = currentGroup.symbol === symbol;
      const sameAction = currentGroup.action === action;

      if (sameAddress && sameSymbol && sameAction && timeDiff <= AGGREGATION_WINDOW_MS) {
        currentGroup.fills.push(fill);
        currentGroup.totalSize += Math.abs(fill.size_signed || 0);
        currentGroup.totalPnl += fill.closed_pnl_usd || 0;
        if (fill.price_usd) {
          currentGroup.prices.push(fill.price_usd);
        }
        if (fillTime < new Date(currentGroup.oldest_time).getTime()) {
          currentGroup.oldest_time = fill.time_utc;
        }
        continue;
      }
    }

    if (currentGroup) {
      finalizeGroup(currentGroup);
      aggregated.push(currentGroup);
    }

    currentGroup = {
      time_utc: fill.time_utc,
      oldest_time: fill.time_utc,
      address: address,
      symbol: symbol,
      action: action,
      fills: [fill],
      totalSize: Math.abs(fill.size_signed || 0),
      totalPnl: fill.closed_pnl_usd || 0,
      prices: fill.price_usd ? [fill.price_usd] : [],
      previous_position: fill.previous_position,
      isAggregated: false,
      fillCount: 1,
      avgPrice: null,
      size_signed: fill.size_signed,
      price_usd: fill.price_usd,
      closed_pnl_usd: fill.closed_pnl_usd,
    };
  }

  if (currentGroup) {
    finalizeGroup(currentGroup);
    aggregated.push(currentGroup);
  }

  return aggregated;
}

describe('aggregateFills', () => {
  const baseTime = new Date('2025-11-25T12:00:00Z').getTime();

  test('returns empty array for empty input', () => {
    expect(aggregateFills([])).toEqual([]);
  });

  test('returns single fill unchanged', () => {
    const fills: Fill[] = [{
      time_utc: new Date(baseTime).toISOString(),
      address: '0x1234567890abcdef1234567890abcdef12345678',
      symbol: 'BTC',
      action: 'Open Long',
      size_signed: 0.5,
      previous_position: 0,
      price_usd: 95000,
      closed_pnl_usd: null,
    }];

    const result = aggregateFills(fills);
    expect(result.length).toBe(1);
    expect(result[0].isAggregated).toBe(false);
    expect(result[0].fillCount).toBe(1);
  });

  test('aggregates fills within 1 minute window', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(), // 30 seconds later
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.2,
        previous_position: 0.1,
        price_usd: 95100,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(1);
    expect(result[0].isAggregated).toBe(true);
    expect(result[0].fillCount).toBe(2);
    expect(result[0].totalSize).toBeCloseTo(0.3, 10);
    expect(result[0].avgPrice).toBe(95050);
  });

  test('does not aggregate fills outside 1 minute window', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 120000).toISOString(), // 2 minutes later
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.2,
        previous_position: 0.1,
        price_usd: 95100,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(2);
    expect(result[0].isAggregated).toBe(false);
    expect(result[1].isAggregated).toBe(false);
  });

  test('does not aggregate fills with different addresses', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1111111111111111111111111111111111111111',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x2222222222222222222222222222222222222222',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.2,
        previous_position: 0,
        price_usd: 95100,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(2);
  });

  test('does not aggregate fills with different symbols', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        action: 'Open Long',
        size_signed: 1.0,
        previous_position: 0,
        price_usd: 3500,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(2);
  });

  test('does not aggregate fills with different actions', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Close Long',
        size_signed: -0.1,
        previous_position: 0.1,
        price_usd: 96000,
        closed_pnl_usd: 100,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(2);
  });

  test('calculates correct signed size for short actions', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Short',
        size_signed: -0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result[0].size_signed).toBe(-0.5);
  });

  test('aggregates PnL correctly', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Close Long',
        size_signed: -0.1,
        previous_position: 0.3,
        price_usd: 96000,
        closed_pnl_usd: 50,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Close Long',
        size_signed: -0.2,
        previous_position: 0.2,
        price_usd: 96100,
        closed_pnl_usd: 100,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(1);
    expect(result[0].totalPnl).toBe(150);
    expect(result[0].closed_pnl_usd).toBe(150);
  });

  test('handles multiple aggregation groups', () => {
    // Note: The aggregation algorithm groups consecutive fills by time order.
    // When sorted by time descending, fills from different addresses/symbols
    // will break the grouping sequence.
    const fills: Fill[] = [
      // Group 1: Two BTC opens - consecutive in time order
      {
        time_utc: new Date(baseTime + 40000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0.1,
        price_usd: 95050,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      // Group 2: ETH fill from different address - later in timeline
      {
        time_utc: new Date(baseTime + 60000).toISOString(),
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        symbol: 'ETH',
        action: 'Open Short',
        size_signed: -5.0,
        previous_position: 0,
        price_usd: 3500,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(2);

    // Find the BTC group (should be aggregated)
    const btcGroup = result.find(g => g.symbol === 'BTC');
    expect(btcGroup?.isAggregated).toBe(true);
    expect(btcGroup?.fillCount).toBe(2);

    // Find the ETH group (single fill, not aggregated)
    const ethGroup = result.find(g => g.symbol === 'ETH');
    expect(ethGroup?.isAggregated).toBe(false);
    expect(ethGroup?.fillCount).toBe(1);
  });

  test('tracks oldest_time correctly for aggregated fills', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime + 50000).toISOString(), // newest
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0.2,
        price_usd: 95100,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime).toISOString(), // oldest
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 25000).toISOString(), // middle
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0.1,
        price_usd: 95050,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(1);
    expect(result[0].oldest_time).toBe(new Date(baseTime).toISOString());
    expect(result[0].time_utc).toBe(new Date(baseTime + 50000).toISOString());
  });

  test('handles fills with null prices', () => {
    const fills: Fill[] = [
      {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: null,
        closed_pnl_usd: null,
      },
      {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0.1,
        price_usd: 95000,
        closed_pnl_usd: null,
      },
    ];

    const result = aggregateFills(fills);
    expect(result.length).toBe(1);
    expect(result[0].avgPrice).toBe(95000); // Only the non-null price
    expect(result[0].prices.length).toBe(1);
  });
});
