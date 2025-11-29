/**
 * Tests for streaming fill aggregation
 * Tests the dynamic grouping behavior when fills arrive via WebSocket
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

interface AggregatedGroup {
  id: string;
  time_utc: string;
  oldest_time: string;
  address: string;
  symbol: string;
  action: string;
  fills: Fill[];
  totalSize: number;
  totalPnl: number;
  prices: number[];
  previous_position: number | null;
  isAggregated: boolean;
  fillCount: number;
  avgPrice: number | null;
  size_signed: number | null;
  closed_pnl_usd: number | null;
  price_usd: number | null;
}

const AGGREGATION_WINDOW_MS = 60000; // 1 minute
const MAX_AGGREGATED_GROUPS = 50;

// Mirrors createGroup from dashboard.js
function createGroup(fill: Fill): AggregatedGroup {
  const symbol = (fill.symbol || 'BTC').toUpperCase();
  return {
    id: `${fill.address}-${fill.time_utc}-${Math.random().toString(36).slice(2, 8)}`,
    time_utc: fill.time_utc,
    oldest_time: fill.time_utc,
    address: fill.address,
    symbol: symbol,
    action: fill.action || '',
    fills: [fill],
    totalSize: Math.abs(fill.size_signed || 0),
    totalPnl: fill.closed_pnl_usd || 0,
    prices: fill.price_usd ? [fill.price_usd] : [],
    previous_position: fill.previous_position,
    isAggregated: false,
    fillCount: 1,
    avgPrice: fill.price_usd || null,
    size_signed: fill.size_signed,
    closed_pnl_usd: fill.closed_pnl_usd,
    price_usd: fill.price_usd,
  };
}

// Mirrors canMergeIntoGroup from dashboard.js
function canMergeIntoGroup(group: AggregatedGroup, fill: Fill): boolean {
  const fillTime = new Date(fill.time_utc).getTime();
  const groupNewestTime = new Date(group.time_utc).getTime();
  const groupOldestTime = new Date(group.oldest_time).getTime();

  const timeDiffFromNewest = Math.abs(groupNewestTime - fillTime);
  const timeDiffFromOldest = Math.abs(groupOldestTime - fillTime);
  const withinWindow = timeDiffFromNewest <= AGGREGATION_WINDOW_MS || timeDiffFromOldest <= AGGREGATION_WINDOW_MS;

  const symbol = (fill.symbol || 'BTC').toUpperCase();
  const sameAddress = group.address === fill.address;
  const sameSymbol = group.symbol === symbol;
  const sameAction = group.action === (fill.action || '');

  return sameAddress && sameSymbol && sameAction && withinWindow;
}

// Mirrors mergeIntoGroup from dashboard.js
function mergeIntoGroup(group: AggregatedGroup, fill: Fill): void {
  const fillTime = new Date(fill.time_utc).getTime();

  group.fills.push(fill);
  group.totalSize += Math.abs(fill.size_signed || 0);
  group.totalPnl += fill.closed_pnl_usd || 0;
  if (fill.price_usd) {
    group.prices.push(fill.price_usd);
  }

  if (fillTime > new Date(group.time_utc).getTime()) {
    group.time_utc = fill.time_utc;
  }
  if (fillTime < new Date(group.oldest_time).getTime()) {
    group.oldest_time = fill.time_utc;
  }

  // Use largest absolute value for previous_position (true starting position)
  const fillPrev = fill.previous_position;
  const groupPrev = group.previous_position;
  if (fillPrev != null && (groupPrev == null || Math.abs(fillPrev) > Math.abs(groupPrev))) {
    group.previous_position = fillPrev;
  }

  group.fillCount = group.fills.length;
  group.isAggregated = group.fills.length > 1;
  group.avgPrice = group.prices.length > 0
    ? group.prices.reduce((a, b) => a + b, 0) / group.prices.length
    : null;

  const isShort = group.action.toLowerCase().includes('short');
  const isDecrease = group.action.toLowerCase().includes('decrease') || group.action.toLowerCase().includes('close');
  group.size_signed = isShort || isDecrease ? -group.totalSize : group.totalSize;
  group.closed_pnl_usd = group.totalPnl || null;
  group.price_usd = group.avgPrice;
}

// Streaming aggregation state
let aggregatedGroups: AggregatedGroup[] = [];

function resetAggregation(): void {
  aggregatedGroups = [];
}

// Mirrors addFillToAggregation from dashboard.js
function addFillToAggregation(fill: Fill): void {
  const symbol = (fill.symbol || 'BTC').toUpperCase();
  if (symbol !== 'BTC' && symbol !== 'ETH') return;

  let merged = false;
  for (let i = 0; i < aggregatedGroups.length; i++) {
    const group = aggregatedGroups[i];
    const groupTime = new Date(group.time_utc).getTime();
    const fillTime = new Date(fill.time_utc).getTime();

    if (Math.abs(groupTime - fillTime) > AGGREGATION_WINDOW_MS * 2) {
      if (fillTime > groupTime) continue;
      break;
    }

    if (canMergeIntoGroup(group, fill)) {
      mergeIntoGroup(group, fill);
      merged = true;
      break;
    }
  }

  if (!merged) {
    const newGroup = createGroup(fill);
    aggregatedGroups.unshift(newGroup);
  }

  aggregatedGroups.sort((a, b) => new Date(b.time_utc).getTime() - new Date(a.time_utc).getTime());

  if (aggregatedGroups.length > MAX_AGGREGATED_GROUPS) {
    aggregatedGroups = aggregatedGroups.slice(0, MAX_AGGREGATED_GROUPS);
  }
}

describe('Streaming Aggregation', () => {
  const baseTime = new Date('2025-11-25T12:00:00Z').getTime();

  beforeEach(() => {
    resetAggregation();
  });

  describe('createGroup', () => {
    test('creates group with correct initial values', () => {
      const fill: Fill = {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      };

      const group = createGroup(fill);

      expect(group.address).toBe(fill.address);
      expect(group.symbol).toBe('BTC');
      expect(group.action).toBe('Open Long');
      expect(group.fillCount).toBe(1);
      expect(group.isAggregated).toBe(false);
      expect(group.totalSize).toBe(0.5);
      expect(group.avgPrice).toBe(95000);
      expect(group.previous_position).toBe(0);
    });

    test('normalizes symbol to uppercase', () => {
      const fill: Fill = {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'btc',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      };

      const group = createGroup(fill);
      expect(group.symbol).toBe('BTC');
    });

    test('handles null price', () => {
      const fill: Fill = {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: null,
        closed_pnl_usd: null,
      };

      const group = createGroup(fill);
      expect(group.prices.length).toBe(0);
      expect(group.avgPrice).toBe(null);
    });
  });

  describe('canMergeIntoGroup', () => {
    test('returns true for matching fill within window', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime + 30000).toISOString(), // 30 seconds later
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0.5,
        price_usd: 95100,
        closed_pnl_usd: null,
      };

      expect(canMergeIntoGroup(group, fill)).toBe(true);
    });

    test('returns false for different address', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1111111111111111111111111111111111111111',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x2222222222222222222222222222222222222222',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0,
        price_usd: 95100,
        closed_pnl_usd: null,
      };

      expect(canMergeIntoGroup(group, fill)).toBe(false);
    });

    test('returns false for different symbol', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        action: 'Open Long',
        size_signed: 2.0,
        previous_position: 0,
        price_usd: 3500,
        closed_pnl_usd: null,
      };

      expect(canMergeIntoGroup(group, fill)).toBe(false);
    });

    test('returns false for different action', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Close Long',
        size_signed: -0.5,
        previous_position: 0.5,
        price_usd: 96000,
        closed_pnl_usd: 100,
      };

      expect(canMergeIntoGroup(group, fill)).toBe(false);
    });

    test('returns false for fill outside time window', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime + 120000).toISOString(), // 2 minutes later
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0.5,
        price_usd: 95100,
        closed_pnl_usd: null,
      };

      expect(canMergeIntoGroup(group, fill)).toBe(false);
    });

    test('returns true for fill before group (within window)', () => {
      const group = createGroup({
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime).toISOString(), // Earlier fill
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0,
        price_usd: 94900,
        closed_pnl_usd: null,
      };

      expect(canMergeIntoGroup(group, fill)).toBe(true);
    });
  });

  describe('mergeIntoGroup', () => {
    test('updates group totals correctly', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      const fill: Fill = {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0.5,
        price_usd: 95100,
        closed_pnl_usd: null,
      };

      mergeIntoGroup(group, fill);

      expect(group.fillCount).toBe(2);
      expect(group.isAggregated).toBe(true);
      expect(group.totalSize).toBeCloseTo(0.8, 10);
      expect(group.avgPrice).toBe(95050); // (95000 + 95100) / 2
    });

    test('updates time range correctly', () => {
      const group = createGroup({
        time_utc: new Date(baseTime + 20000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      // Add earlier fill
      mergeIntoGroup(group, {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.2,
        previous_position: 0,
        price_usd: 94900,
        closed_pnl_usd: null,
      });

      // Add later fill
      mergeIntoGroup(group, {
        time_utc: new Date(baseTime + 40000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0.7,
        price_usd: 95200,
        closed_pnl_usd: null,
      });

      expect(group.time_utc).toBe(new Date(baseTime + 40000).toISOString()); // Newest
      expect(group.oldest_time).toBe(new Date(baseTime).toISOString()); // Oldest
    });

    test('uses largest absolute previous_position', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Decrease Short',
        size_signed: 0.1,
        previous_position: -10.5, // Starting short position
        price_usd: 95000,
        closed_pnl_usd: 50,
      });

      // Concurrent fill with different previous_position
      mergeIntoGroup(group, {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Decrease Short',
        size_signed: 0.1,
        previous_position: -5.3, // Smaller absolute value
        price_usd: 95000,
        closed_pnl_usd: 50,
      });

      // Should keep the larger absolute value (-10.5)
      expect(group.previous_position).toBe(-10.5);
    });

    test('aggregates PnL correctly', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Close Long',
        size_signed: -0.2,
        previous_position: 0.5,
        price_usd: 96000,
        closed_pnl_usd: 100,
      });

      mergeIntoGroup(group, {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Close Long',
        size_signed: -0.3,
        previous_position: 0.3,
        price_usd: 96100,
        closed_pnl_usd: 150,
      });

      expect(group.totalPnl).toBe(250);
      expect(group.closed_pnl_usd).toBe(250);
    });

    test('calculates negative signed size for short/decrease actions', () => {
      const group = createGroup({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Short',
        size_signed: -0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      mergeIntoGroup(group, {
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Short',
        size_signed: -0.3,
        previous_position: -0.5,
        price_usd: 94900,
        closed_pnl_usd: null,
      });

      // Total size is 0.8, but signed should be negative for shorts
      expect(group.size_signed).toBe(-0.8);
    });
  });

  describe('addFillToAggregation', () => {
    test('creates new group for first fill', () => {
      const fill: Fill = {
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      };

      addFillToAggregation(fill);

      expect(aggregatedGroups.length).toBe(1);
      expect(aggregatedGroups[0].fillCount).toBe(1);
    });

    test('merges fill into existing group within window', () => {
      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      addFillToAggregation({
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0.5,
        price_usd: 95100,
        closed_pnl_usd: null,
      });

      expect(aggregatedGroups.length).toBe(1);
      expect(aggregatedGroups[0].fillCount).toBe(2);
      expect(aggregatedGroups[0].isAggregated).toBe(true);
    });

    test('creates separate groups for different addresses', () => {
      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1111111111111111111111111111111111111111',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      addFillToAggregation({
        time_utc: new Date(baseTime + 30000).toISOString(),
        address: '0x2222222222222222222222222222222222222222',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.3,
        previous_position: 0,
        price_usd: 95100,
        closed_pnl_usd: null,
      });

      expect(aggregatedGroups.length).toBe(2);
    });

    test('filters out non-BTC/ETH symbols', () => {
      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'SOL',
        action: 'Open Long',
        size_signed: 10,
        previous_position: 0,
        price_usd: 200,
        closed_pnl_usd: null,
      });

      expect(aggregatedGroups.length).toBe(0);
    });

    test('maintains descending time order', () => {
      // Add older fill first
      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1111111111111111111111111111111111111111',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
      });

      // Add newer fill
      addFillToAggregation({
        time_utc: new Date(baseTime + 120000).toISOString(), // 2 minutes later
        address: '0x2222222222222222222222222222222222222222',
        symbol: 'ETH',
        action: 'Open Short',
        size_signed: -5,
        previous_position: 0,
        price_usd: 3500,
        closed_pnl_usd: null,
      });

      expect(aggregatedGroups.length).toBe(2);
      // Newer group should be first
      expect(aggregatedGroups[0].symbol).toBe('ETH');
      expect(aggregatedGroups[1].symbol).toBe('BTC');
    });

    test('trims to max groups', () => {
      // Add more than MAX_AGGREGATED_GROUPS fills with different addresses
      for (let i = 0; i < 60; i++) {
        addFillToAggregation({
          time_utc: new Date(baseTime + i * 120000).toISOString(), // 2 min apart (no aggregation)
          address: `0x${i.toString(16).padStart(40, '0')}`,
          symbol: 'BTC',
          action: 'Open Long',
          size_signed: 0.1,
          previous_position: 0,
          price_usd: 95000 + i,
          closed_pnl_usd: null,
        });
      }

      expect(aggregatedGroups.length).toBe(MAX_AGGREGATED_GROUPS);
    });

    test('handles ETH fills correctly', () => {
      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        action: 'Open Long',
        size_signed: 5.0,
        previous_position: 0,
        price_usd: 3500,
        closed_pnl_usd: null,
      });

      expect(aggregatedGroups.length).toBe(1);
      expect(aggregatedGroups[0].symbol).toBe('ETH');
    });
  });

  describe('concurrent fill handling', () => {
    test('selects largest absolute previous_position for concurrent fills', () => {
      // Simulate concurrent fills (same timestamp) with different previous_positions
      // This happens when fills execute against order book in parallel
      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Decrease Short',
        size_signed: 5,
        previous_position: -18.98782, // True starting position
        price_usd: 95000,
        closed_pnl_usd: 50,
      });

      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(), // Same timestamp
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Decrease Short',
        size_signed: 5,
        previous_position: -13.01541, // Intermediate position
        price_usd: 95000,
        closed_pnl_usd: 50,
      });

      addFillToAggregation({
        time_utc: new Date(baseTime).toISOString(), // Same timestamp
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        action: 'Decrease Short',
        size_signed: 5,
        previous_position: -8.0, // Another intermediate
        price_usd: 95000,
        closed_pnl_usd: 50,
      });

      expect(aggregatedGroups.length).toBe(1);
      expect(aggregatedGroups[0].fillCount).toBe(3);
      // Should keep the largest absolute value (most negative)
      expect(aggregatedGroups[0].previous_position).toBe(-18.98782);
    });
  });
});
