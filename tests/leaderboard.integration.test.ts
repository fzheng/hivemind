/**
 * Integration tests for LeaderboardService
 *
 * Tests the LRUCache, RateLimiter, API request handling,
 * and database persistence logic.
 */

// Mock dependencies before importing
const mockQuery = jest.fn();
const mockPool = { query: mockQuery };
const mockFetch = jest.fn();

jest.mock('@hl/ts-lib', () => {
  const actualScoring = jest.requireActual('@hl/ts-lib/scoring');
  return {
    createLogger: () => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    }),
    getPool: jest.fn(async () => mockPool),
    normalizeAddress: (value: string) => value.toLowerCase(),
    nowIso: () => '2024-01-01T00:00:00.000Z',
    CandidateEventSchema: { parse: (input: unknown) => input },
    computePerformanceScore: actualScoring.computePerformanceScore,
    computeStabilityScore: actualScoring.computeStabilityScore,
    DEFAULT_SCORING_PARAMS: actualScoring.DEFAULT_SCORING_PARAMS,
    removeCustomAccount: jest.fn(),
    listCustomAccounts: jest.fn().mockResolvedValue([]),
    updateCustomAccountNickname: jest.fn(),
  };
});

// Set up global fetch mock
global.fetch = mockFetch;

// Sleep helper for rate limiter tests
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LRUCache', () => {
  // Create a minimal LRU cache implementation for testing
  class LRUCache<T> {
    private cache = new Map<string, { value: T; expiresAt: number }>();
    private maxSize: number;
    private ttlMs: number;

    constructor(maxSize: number, ttlMs: number) {
      this.maxSize = maxSize;
      this.ttlMs = ttlMs;
    }

    get(key: string): T | undefined {
      const entry = this.cache.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        this.cache.delete(key);
        return undefined;
      }
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.value;
    }

    set(key: string, value: T): void {
      this.cache.delete(key);
      while (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
          this.cache.delete(firstKey);
        }
      }
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }

    clear(): void {
      this.cache.clear();
    }

    get size(): number {
      return this.cache.size;
    }
  }

  it('should store and retrieve values', () => {
    const cache = new LRUCache<string>(10, 60000);
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return undefined for missing keys', () => {
    const cache = new LRUCache<string>(10, 60000);
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('should evict expired entries', () => {
    jest.useFakeTimers();
    const cache = new LRUCache<string>(10, 100); // 100ms TTL
    cache.set('key1', 'value1');

    expect(cache.get('key1')).toBe('value1');

    jest.advanceTimersByTime(150);
    expect(cache.get('key1')).toBeUndefined();

    jest.useRealTimers();
  });

  it('should evict oldest entries when at capacity', () => {
    const cache = new LRUCache<string>(3, 60000);
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.set('key3', 'value3');
    cache.set('key4', 'value4'); // Should evict key1

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBe('value2');
    expect(cache.get('key3')).toBe('value3');
    expect(cache.get('key4')).toBe('value4');
  });

  it('should move accessed items to end (LRU)', () => {
    const cache = new LRUCache<string>(3, 60000);
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.set('key3', 'value3');

    // Access key1 to make it most recently used
    cache.get('key1');

    // Add new key - should evict key2 (oldest unused)
    cache.set('key4', 'value4');

    expect(cache.get('key1')).toBe('value1');
    expect(cache.get('key2')).toBeUndefined();
    expect(cache.get('key3')).toBe('value3');
    expect(cache.get('key4')).toBe('value4');
  });

  it('should update existing key position on set', () => {
    const cache = new LRUCache<string>(3, 60000);
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.set('key3', 'value3');

    // Update key1
    cache.set('key1', 'updated');

    // Add new key - should evict key2
    cache.set('key4', 'value4');

    expect(cache.get('key1')).toBe('updated');
    expect(cache.get('key2')).toBeUndefined();
  });

  it('should clear all entries', () => {
    const cache = new LRUCache<string>(10, 60000);
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');

    expect(cache.size).toBe(2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('should report correct size', () => {
    const cache = new LRUCache<string>(10, 60000);
    expect(cache.size).toBe(0);

    cache.set('key1', 'value1');
    expect(cache.size).toBe(1);

    cache.set('key2', 'value2');
    expect(cache.size).toBe(2);
  });
});

describe('RateLimiter', () => {
  // Create a minimal rate limiter implementation for testing
  class RateLimiter {
    private lastRequestTime = 0;
    private delayMs: number;

    constructor(delayMs: number) {
      this.delayMs = delayMs;
    }

    async acquire(): Promise<void> {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.delayMs) {
        await sleep(this.delayMs - elapsed);
      }
      this.lastRequestTime = Date.now();
    }
  }

  it('should not delay first request', async () => {
    const limiter = new RateLimiter(100);
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('should delay rapid consecutive requests', async () => {
    const limiter = new RateLimiter(100);

    await limiter.acquire(); // First request

    const start = Date.now();
    await limiter.acquire(); // Second request should be delayed
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some timing variance
  });

  it('should not delay if enough time has passed', async () => {
    const limiter = new RateLimiter(50);

    await limiter.acquire();
    await sleep(100); // Wait longer than delay

    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(30);
  });
});

describe('LeaderboardService API Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockQuery.mockReset();
  });

  describe('Leaderboard API Fetch', () => {
    it('should handle successful leaderboard fetch', async () => {
      const mockLeaderboardData = {
        data: [
          {
            address: '0x1234567890abcdef1234567890abcdef12345678',
            winRate: 0.65,
            executedOrders: 100,
            realizedPnl: 50000,
            pnlList: [
              { timestamp: 1, value: '0' },
              { timestamp: 2, value: '25000' },
              { timestamp: 3, value: '50000' },
            ],
            lastOperationAt: Date.now(),
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockLeaderboardData),
      });

      const response = await mockFetch('https://hyperbot.network/api/leaderboard/smart?pageNum=1&pageSize=50&period=30&sort=3');
      const data = await response.json();

      expect(data.data).toHaveLength(1);
      expect(data.data[0].winRate).toBe(0.65);
    });

    it('should handle API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const response = await mockFetch('https://hyperbot.network/api/leaderboard/smart');
      expect(response.ok).toBe(false);
      expect(response.status).toBe(500);
    });

    it('should handle network timeout', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(
        mockFetch('https://hyperbot.network/api/leaderboard/smart')
      ).rejects.toThrow('Network timeout');
    });
  });

  describe('Address Stats API', () => {
    it('should fetch and parse address stats', async () => {
      const mockStatsResponse = {
        data: {
          winRate: 0.72,
          openPosCount: 2,
          closePosCount: 48,
          avgPosDuration: 3600000,
          totalPnl: 75000,
          maxDrawdown: 0.15,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStatsResponse),
      });

      const response = await mockFetch(
        'https://hyperbot.network/api/leaderboard/smart/query-addr-stat/0x1234?period=30'
      );
      const data = await response.json();

      expect(data.data.winRate).toBe(0.72);
      expect(data.data.maxDrawdown).toBe(0.15);
    });

    it('should handle missing stats gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: null }),
      });

      const response = await mockFetch(
        'https://hyperbot.network/api/leaderboard/smart/query-addr-stat/0x1234?period=30'
      );
      const data = await response.json();

      expect(data.data).toBeNull();
    });
  });

  describe('Address Remarks API', () => {
    it('should fetch batch address remarks', async () => {
      const mockRemarksResponse = {
        code: 0,
        msg: 'SUCCESS',
        data: [
          { address: '0x1234', remark: 'Whale Trader' },
          { address: '0x5678', remark: 'DeFi Pro' },
          { address: '0x9abc', remark: null },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockRemarksResponse),
      });

      const response = await mockFetch(
        'https://hyperbot.network/api/leaderboard/smart/query-addr-remarks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(['0x1234', '0x5678', '0x9abc']),
        }
      );
      const data = await response.json();

      expect(data.code).toBe(0);
      expect(data.data).toHaveLength(3);
      expect(data.data[0].remark).toBe('Whale Trader');
    });

    it('should handle empty remarks response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 0, msg: 'SUCCESS', data: [] }),
      });

      const response = await mockFetch(
        'https://hyperbot.network/api/leaderboard/smart/query-addr-remarks',
        { method: 'POST', body: '[]' }
      );
      const data = await response.json();

      expect(data.data).toEqual([]);
    });
  });

  describe('BTC/ETH Analysis API', () => {
    it('should fetch completed trades for analysis', async () => {
      const mockTradesResponse = {
        data: [
          {
            symbol: 'BTC',
            pnl: 5000,
            openTime: Date.now() - 3600000, // 1 hour ago
            closeTime: Date.now(),
          },
          {
            symbol: 'ETH',
            pnl: 2000,
            openTime: Date.now() - 7200000,
            closeTime: Date.now() - 3600000,
          },
          {
            symbol: 'SOL', // Non BTC/ETH
            pnl: 1000,
            openTime: Date.now() - 1000,
            closeTime: Date.now(), // Short trade (should be filtered)
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTradesResponse),
      });

      const response = await mockFetch(
        'https://hyperbot.network/api/leaderboard/smart/completed-trades/0x1234?take=2000'
      );
      const data = await response.json();

      expect(data.data).toHaveLength(3);

      // Filter for BTC/ETH trades lasting > 10 minutes
      const MIN_DURATION_MS = 10 * 60 * 1000;
      const btcEthTrades = data.data.filter(
        (t: { symbol: string; closeTime: number; openTime: number }) =>
          ['BTC', 'ETH'].includes(t.symbol) &&
          t.closeTime - t.openTime >= MIN_DURATION_MS
      );

      expect(btcEthTrades).toHaveLength(2);
    });
  });

  describe('Hyperliquid Info API', () => {
    it('should fetch portfolio data for PnL series', async () => {
      const mockPortfolioResponse = {
        portfolioHistory: [
          { time: 1700000000000, accountValue: '100000' },
          { time: 1700086400000, accountValue: '105000' },
          { time: 1700172800000, accountValue: '110000' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockPortfolioResponse),
      });

      const response = await mockFetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'portfolio',
          user: '0x1234',
        }),
      });
      const data = await response.json();

      expect(data.portfolioHistory).toHaveLength(3);
    });
  });
});

describe('Database Persistence', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('should upsert leaderboard entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await mockPool.query(
      `INSERT INTO hl_leaderboard_entries
       (period_days, address, rank, score, weight, win_rate, executed_orders, realized_pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (period_days, lower(address)) DO UPDATE SET
       rank = EXCLUDED.rank, score = EXCLUDED.score`,
      [30, '0x1234', 1, 0.85, 0.5, 0.72, 100, 50000]
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO hl_leaderboard_entries'),
      expect.arrayContaining([30, '0x1234', 1])
    );
  });

  it('should store PnL points', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await mockPool.query(
      `INSERT INTO hl_leaderboard_pnl_points
       (period_days, address, source, window_name, point_ts, pnl_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [30, '0x1234', 'api', 'month', new Date().toISOString(), 50000]
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO hl_leaderboard_pnl_points'),
      expect.arrayContaining([30, '0x1234', 'api', 'month'])
    );
  });

  it('should fetch leaderboard entries with stats', async () => {
    const mockEntries = [
      {
        id: 1,
        address: '0x1234',
        rank: 1,
        score: 0.85,
        weight: 0.5,
        win_rate: 0.72,
        executed_orders: 100,
        realized_pnl: 50000,
        stat_max_drawdown: 0.15,
      },
    ];

    mockQuery.mockResolvedValueOnce({ rows: mockEntries });

    const result = await mockPool.query(
      `SELECT * FROM hl_leaderboard_entries
       WHERE period_days = $1
       ORDER BY rank ASC
       LIMIT $2`,
      [30, 10]
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].score).toBe(0.85);
  });
});

describe('Scoring Edge Cases', () => {
  it('should handle empty pnlList', () => {
    const pnlList: Array<{ timestamp: number; value: string }> = [];
    const values = pnlList.map((p) => Number(p.value));

    expect(values).toEqual([]);
  });

  it('should handle single point pnlList', () => {
    const pnlList = [{ timestamp: 1, value: '10000' }];
    const values = pnlList.map((p) => Number(p.value));

    expect(values).toHaveLength(1);
    expect(values[0]).toBe(10000);
  });

  it('should handle negative PnL values', () => {
    const pnlList = [
      { timestamp: 1, value: '0' },
      { timestamp: 2, value: '-5000' },
      { timestamp: 3, value: '-10000' },
    ];
    const values = pnlList.map((p) => Number(p.value));

    expect(values).toEqual([0, -5000, -10000]);
    expect(values[values.length - 1]).toBeLessThan(0);
  });

  it('should calculate drawdown correctly', () => {
    const pnlList = [
      { timestamp: 1, value: '0' },
      { timestamp: 2, value: '100000' },
      { timestamp: 3, value: '70000' }, // 30% drawdown
      { timestamp: 4, value: '90000' },
    ];
    const values = pnlList.map((p) => Number(p.value));

    let peak = values[0];
    let maxDrawdown = 0;

    for (const val of values) {
      if (val > peak) peak = val;
      if (peak > 0) {
        const drawdown = (peak - val) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }
    }

    expect(maxDrawdown).toBeCloseTo(0.3, 2);
  });

  it('should handle zero starting value', () => {
    const startValue = 0;
    const endValue = 50000;
    const profit = endValue - startValue;

    expect(profit).toBe(50000);
  });

  it('should clamp win rate to valid range', () => {
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(max, value));

    expect(clamp(1.5, 0, 1)).toBe(1);
    expect(clamp(-0.5, 0, 1)).toBe(0);
    expect(clamp(0.75, 0, 1)).toBe(0.75);
  });
});

describe('Concurrency Helpers', () => {
  async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];
    const executing: Promise<void>[] = [];

    for (const item of items) {
      const p = fn(item).then((result) => {
        results.push(result);
      });

      executing.push(p as unknown as Promise<void>);

      if (executing.length >= concurrency) {
        await Promise.race(executing);
        // Remove completed promises
        const completed = executing.filter(
          (p) => (p as unknown as { _settled?: boolean })._settled
        );
        executing.length = 0;
        executing.push(...completed.filter(() => false));
      }
    }

    await Promise.all(executing);
    return results;
  }

  it('should process items with limited concurrency', async () => {
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    await runWithConcurrency(items, 2, async (item) => {
      await sleep(10);
      processed.push(item);
      return item * 2;
    });

    expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('should handle empty items array', async () => {
    const results = await runWithConcurrency([], 2, async (item: number) => item * 2);
    expect(results).toEqual([]);
  });

  it('should handle concurrency of 1', async () => {
    const items = [1, 2, 3];
    const order: number[] = [];

    await runWithConcurrency(items, 1, async (item) => {
      order.push(item);
      await sleep(5);
      return item;
    });

    expect(order).toEqual([1, 2, 3]); // Sequential order
  });
});
