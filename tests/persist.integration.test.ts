/**
 * Integration tests for persist.ts database operations
 *
 * These tests use a mock pg Pool to test SQL query construction
 * and response handling without requiring a real database.
 */

// Mock the postgres module before any imports
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClient = {
  query: mockClientQuery,
  release: jest.fn(),
};
const mockPool = {
  query: mockQuery,
  connect: jest.fn(() => Promise.resolve(mockClient)),
};

jest.mock('../packages/ts-lib/src/postgres', () => ({
  getPool: jest.fn(() => Promise.resolve(mockPool)),
  closePool: jest.fn(() => Promise.resolve()),
}));

import {
  insertEvent,
  insertTradeIfNew,
  latestTrades,
  pageTrades,
  pageTradesByTime,
  deleteAllTrades,
  deleteTradesForAddress,
  countValidTradesForAddress,
  upsertCurrentPosition,
  clearPositionsForAddress,
  getAddressPerformance,
  listRecentFills,
  listLiveFills,
  fetchLatestFillForAddress,
  listCustomAccounts,
  addCustomAccount,
  removeCustomAccount,
  getCustomAccountCount,
  isCustomAccount,
  updateCustomAccountNickname,
  getLastRefreshTime,
  getBackfillFills,
  getOldestFillTime,
  listRecentDecisions,
  validatePositionChain,
  clearTradesForAddress,
  type InsertableEvent,
} from '../packages/ts-lib/src/persist';

// Mock console.error to prevent noise in test output from error handling paths
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});
afterAll(() => {
  console.error = originalConsoleError;
});

describe('persist.ts database integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the client mock for transactional tests
    mockClientQuery.mockReset();
  });

  describe('insertEvent', () => {
    it('should insert event and return id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 123 }] });

      const event: InsertableEvent = {
        type: 'trade',
        at: '2025-01-01T00:00:00Z',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        payload: { price: 95000 },
      };

      const result = await insertEvent(event);

      expect(result).toBe(123);
      expect(mockQuery).toHaveBeenCalledWith(
        'insert into hl_events (at, address, type, symbol, payload) values ($1,$2,$3,$4,$5) returning id',
        [event.at, event.address, event.type, event.symbol, event.payload]
      );
    });

    it('should return null on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const event: InsertableEvent = {
        type: 'position',
        at: '2025-01-01T00:00:00Z',
        address: '0x1234',
        symbol: 'ETH',
        payload: {},
      };

      const result = await insertEvent(event);
      expect(result).toBeNull();
    });

    it('should return null when rows is empty', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const event: InsertableEvent = {
        type: 'trade',
        at: '2025-01-01T00:00:00Z',
        address: '0x1234',
        symbol: 'BTC',
        payload: {},
      };

      const result = await insertEvent(event);
      expect(result).toBeNull();
    });
  });

  describe('insertTradeIfNew', () => {
    it('should insert new trade when hash does not exist', async () => {
      // First query: check for existing hash - returns empty
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Second query: insert new trade
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 456 }] });

      const payload = {
        hash: '0xnewhash',
        at: '2025-01-01T00:00:00Z',
        symbol: 'BTC',
        price: 95000,
      };

      const result = await insertTradeIfNew('0xABCD', payload);

      expect(result.inserted).toBe(true);
      expect(result.id).toBe(456);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('should update existing trade when hash exists', async () => {
      // First query: check for existing hash - returns existing
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 789 }] });
      // Second query: update existing trade
      mockQuery.mockResolvedValueOnce({});

      const payload = {
        hash: '0xexistinghash',
        at: '2025-01-01T00:00:00Z',
        symbol: 'ETH',
      };

      const result = await insertTradeIfNew('0xABCD', payload);

      expect(result.inserted).toBe(false);
      expect(result.id).toBe(789);
    });

    it('should normalize address to lowercase', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      await insertTradeIfNew('0xABCDEF', { hash: '0x123' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("payload->>'hash'"),
        ['0xabcdef', '0x123']
      );
    });

    it('should handle missing hash in payload', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 100 }] });

      const payload = { price: 95000, symbol: 'BTC' };
      const result = await insertTradeIfNew('0x1234', payload);

      expect(result.id).toBe(100);
      expect(result.inserted).toBe(true);
    });
  });

  describe('latestTrades', () => {
    it('should return latest trades with default limit', async () => {
      const mockTrades = [
        { payload: { action: 'Open Long', price: 95000 } },
        { payload: { action: 'Close Long', price: 96000 } },
      ];
      mockQuery.mockResolvedValueOnce({ rows: mockTrades });

      const result = await latestTrades();

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        'select payload from hl_events where type = $1 order by id desc limit $2',
        ['trade', 50]
      );
    });

    it('should clamp limit between 1 and 200', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await latestTrades(500);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['trade', 200]
      );

      mockQuery.mockResolvedValueOnce({ rows: [] });
      await latestTrades(0);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['trade', 1]
      );
    });

    it('should return empty array on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      const result = await latestTrades();
      expect(result).toEqual([]);
    });
  });

  describe('pageTrades', () => {
    it('should paginate trades by id', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 100, payload: { action: 'Open Long' } },
          { id: 99, payload: { action: 'Close Long' } },
        ],
      });

      const result = await pageTrades({ limit: 50, beforeId: 101 });

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('id < $'),
        [101, 50]
      );
    });

    it('should filter by address', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await pageTrades({ address: '0xABCD', limit: 10 });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('address = $'),
        ['0xabcd', 10]
      );
    });

    it('should clamp limit between 1 and 200', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await pageTrades({ limit: 500 });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        [200]
      );
    });
  });

  describe('pageTradesByTime', () => {
    it('should paginate by time cursor', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, address: '0x1', at: '2025-01-01T00:00:00Z', payload: {} },
        ],
      });

      await pageTradesByTime({ beforeAt: '2025-01-02T00:00:00Z', limit: 25 });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('at < $'),
        ['2025-01-02T00:00:00Z', 25]
      );
    });

    it('should handle composite cursor (time + id)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await pageTradesByTime({
        beforeAt: '2025-01-02T00:00:00Z',
        beforeId: 100,
        limit: 10,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('(at < $'),
        ['2025-01-02T00:00:00Z', 100, 10]
      );
    });

    it('should filter by address with time cursor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await pageTradesByTime({
        address: '0xABCD',
        beforeAt: '2025-01-01T00:00:00Z',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('address = $'),
        expect.arrayContaining(['0xabcd'])
      );
    });
  });

  describe('deleteAllTrades', () => {
    it('should delete all trades and return count', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 150 });

      const result = await deleteAllTrades();

      expect(result).toBe(150);
      expect(mockQuery).toHaveBeenCalledWith(
        "delete from hl_events where type = 'trade'"
      );
    });

    it('should return 0 on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      const result = await deleteAllTrades();
      expect(result).toBe(0);
    });
  });

  describe('deleteTradesForAddress', () => {
    it('should delete trades for specific address', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 25 });

      const result = await deleteTradesForAddress('0xABCD');

      expect(result).toBe(25);
      expect(mockQuery).toHaveBeenCalledWith(
        "delete from hl_events where type = 'trade' and address = $1",
        ['0xabcd']
      );
    });
  });

  describe('countValidTradesForAddress', () => {
    it('should count trades with startPosition', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ c: 42 }] });

      const result = await countValidTradesForAddress('0x1234');

      expect(result).toBe(42);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("payload ? 'startPosition'"),
        ['0x1234']
      );
    });

    it('should return 0 on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      const result = await countValidTradesForAddress('0x1234');
      expect(result).toBe(0);
    });
  });

  describe('upsertCurrentPosition', () => {
    it('should upsert position when size > 0', async () => {
      mockQuery.mockResolvedValueOnce({});

      await upsertCurrentPosition({
        address: '0x1234',
        symbol: 'BTC',
        size: 0.5,
        entryPriceUsd: 95000,
        liquidationPriceUsd: 85000,
        leverage: 10,
        pnlUsd: 500,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('insert into hl_current_positions'),
        expect.arrayContaining(['0x1234', 'BTC', 0.5, 95000, 85000, 10, 500])
      );
    });

    it('should delete position when size = 0', async () => {
      mockQuery.mockResolvedValueOnce({});

      await upsertCurrentPosition({
        address: '0x1234',
        symbol: 'ETH',
        size: 0,
        entryPriceUsd: null,
        liquidationPriceUsd: null,
        leverage: null,
        pnlUsd: null,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM hl_current_positions WHERE address = $1 AND symbol = $2',
        ['0x1234', 'ETH']
      );
    });
  });

  describe('clearPositionsForAddress', () => {
    it('should delete all positions for address', async () => {
      mockQuery.mockResolvedValueOnce({});

      await clearPositionsForAddress('0x1234');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM hl_current_positions WHERE address = $1',
        ['0x1234']
      );
    });
  });

  describe('getAddressPerformance', () => {
    it('should aggregate performance metrics', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            address: '0x1234',
            trades: '50',
            wins: '35',
            pnl_total: '5000',
            pnl_7d: '1500',
            avg_size: '0.25',
          },
        ],
      });

      const result = await getAddressPerformance(7);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        address: '0x1234',
        trades: 50,
        wins: 35,
        winRate: 0.7,
        pnl7d: 1500,
        avgSize: 0.25,
        efficiency: 100, // 5000 / 50
      });
    });

    it('should handle empty results', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getAddressPerformance();
      expect(result).toEqual([]);
    });

    it('should handle zero trades', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            address: '0x1234',
            trades: 0,
            wins: 0,
            pnl_total: 0,
            pnl_7d: 0,
            avg_size: 0,
          },
        ],
      });

      const result = await getAddressPerformance();
      expect(result[0].winRate).toBe(0);
      expect(result[0].efficiency).toBe(0);
    });
  });

  describe('listRecentFills', () => {
    it('should return recent fills with proper transformation', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            address: '0x1234',
            at: '2025-01-01T00:00:00Z',
            payload: {
              side: 'sell',
              size: 0.5,
              priceUsd: 95000,
              realizedPnlUsd: 500,
              action: 'Close Long',
            },
          },
        ],
      });

      const result = await listRecentFills(10);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 1,
        address: '0x1234',
        side: 'sell',
        size: 0.5,
        priceUsd: 95000,
        realizedPnlUsd: 500,
        action: 'Close Long',
      });
    });

    it('should default side to buy', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, address: '0x1', at: '2025-01-01', payload: { side: 'buy' } },
        ],
      });

      const result = await listRecentFills();
      expect(result[0].side).toBe('buy');
    });
  });

  describe('listLiveFills', () => {
    it('should return live fills with signed size', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            time_utc: '2025-01-01T00:00:00Z',
            address: '0x1234',
            action: 'Open Long',
            size_signed: 0.5,
            previous_position: 0,
            price_usd: 95000,
            closed_pnl_usd: null,
            tx_hash: '0xhash',
            symbol: 'BTC',
            fee: 5.25,
            fee_token: 'USDC',
          },
        ],
      });

      const result = await listLiveFills(25);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        action: 'Open Long',
        size_signed: 0.5,
        previous_position: 0,
        symbol: 'BTC',
      });
    });

    it('should clamp limit between 1 and 200', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await listLiveFills(500);
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [200]);
    });
  });

  describe('fetchLatestFillForAddress', () => {
    it('should return latest fill for address', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 100,
            address: '0x1234',
            at: '2025-01-01T00:00:00Z',
            payload: { side: 'buy', size: 0.1, priceUsd: 95000 },
          },
        ],
      });

      const result = await fetchLatestFillForAddress('0x1234');

      expect(result).not.toBeNull();
      expect(result!.address).toBe('0x1234');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('address = $1'),
        ['0x1234']
      );
    });

    it('should return null when no fills exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await fetchLatestFillForAddress('0x1234');
      expect(result).toBeNull();
    });
  });

  describe('Custom Accounts', () => {
    describe('listCustomAccounts', () => {
      it('should return list of custom accounts', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [
            { id: 1, address: '0x1234', nickname: 'Whale', added_at: '2025-01-01' },
            { id: 2, address: '0x5678', nickname: null, added_at: '2025-01-02' },
          ],
        });

        const result = await listCustomAccounts();

        expect(result).toHaveLength(2);
        expect(result[0].nickname).toBe('Whale');
        expect(result[1].nickname).toBeNull();
      });
    });

    describe('addCustomAccount', () => {
      it('should add new custom account', async () => {
        // Transaction flow: BEGIN, LOCK TABLE, COUNT, INSERT, COMMIT
        mockClientQuery
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({}) // LOCK TABLE
          .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // COUNT (1 existing)
          .mockResolvedValueOnce({
            rows: [{ id: 3, address: '0xnew', nickname: 'NewWhale', added_at: '2025-01-01' }],
          }) // INSERT
          .mockResolvedValueOnce({}); // COMMIT

        const result = await addCustomAccount('0xNEW', 'NewWhale');

        expect(result.success).toBe(true);
        expect(result.account!.nickname).toBe('NewWhale');
      });

      it('should reject when limit reached', async () => {
        // Transaction flow: BEGIN, LOCK TABLE, COUNT (3 = limit), ROLLBACK
        mockClientQuery
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({}) // LOCK TABLE
          .mockResolvedValueOnce({ rows: [{ cnt: 3 }] }) // COUNT = 3 (limit reached)
          .mockResolvedValueOnce({}); // ROLLBACK

        const result = await addCustomAccount('0xnew');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Maximum');
      });

      it('should handle duplicate address', async () => {
        // Transaction flow: BEGIN, LOCK TABLE, COUNT, INSERT (returns empty = conflict), ROLLBACK
        mockClientQuery
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({}) // LOCK TABLE
          .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }) // COUNT = 0 existing accounts
          .mockResolvedValueOnce({ rows: [] }) // INSERT returns empty (ON CONFLICT DO NOTHING)
          .mockResolvedValueOnce({}); // ROLLBACK

        const result = await addCustomAccount('0xexisting');

        expect(result.success).toBe(false);
        expect(result.error).toContain('already exists');
      });
    });

    describe('removeCustomAccount', () => {
      it('should remove account and return true', async () => {
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });
        const result = await removeCustomAccount('0x1234');
        expect(result).toBe(true);
      });

      it('should return false when account not found', async () => {
        mockQuery.mockResolvedValueOnce({ rowCount: 0 });
        const result = await removeCustomAccount('0xnotfound');
        expect(result).toBe(false);
      });
    });

    describe('getCustomAccountCount', () => {
      it('should return count of custom accounts', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ cnt: 2 }] });
        const result = await getCustomAccountCount();
        expect(result).toBe(2);
      });
    });

    describe('isCustomAccount', () => {
      it('should return true for existing custom account', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
        const result = await isCustomAccount('0x1234');
        expect(result).toBe(true);
      });

      it('should return false for non-custom account', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const result = await isCustomAccount('0xnotcustom');
        expect(result).toBe(false);
      });
    });

    describe('updateCustomAccountNickname', () => {
      it('should update nickname successfully', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 1, address: '0x1234', nickname: 'NewName', added_at: '2025-01-01' }],
        });

        const result = await updateCustomAccountNickname('0x1234', 'NewName');

        expect(result.success).toBe(true);
        expect(result.account!.nickname).toBe('NewName');
      });

      it('should return error when account not found', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await updateCustomAccountNickname('0xnotfound', 'Name');

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });
    });
  });

  describe('getLastRefreshTime', () => {
    it('should return last refresh timestamp', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ last_refresh: '2025-01-01T12:00:00Z' }],
      });

      const result = await getLastRefreshTime(30);

      expect(result).toBe('2025-01-01T12:00:00Z');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('period_days = $1'),
        [30]
      );
    });

    it('should return null when no entries exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ last_refresh: null }] });
      const result = await getLastRefreshTime(30);
      expect(result).toBeNull();
    });
  });

  describe('getBackfillFills', () => {
    it('should return fills with hasMore flag', async () => {
      const mockRows = Array(51).fill(null).map((_, i) => ({
        id: i,
        time_utc: `2025-01-0${(i % 9) + 1}T00:00:00Z`,
        address: '0x1234',
        symbol: 'BTC',
        action: 'Open Long',
        size_signed: 0.1,
        previous_position: 0,
        price_usd: 95000,
        closed_pnl_usd: null,
        tx_hash: `0xhash${i}`,
      }));

      mockQuery.mockResolvedValueOnce({ rows: mockRows });

      const result = await getBackfillFills({ limit: 50 });

      expect(result.fills).toHaveLength(50);
      expect(result.hasMore).toBe(true);
    });

    it('should filter by addresses', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getBackfillFills({
        addresses: ['0xAAAA', '0xBBBB'],
        limit: 25,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('address = ANY($'),
        expect.arrayContaining([['0xaaaa', '0xbbbb']])
      );
    });

    it('should filter by beforeTime', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getBackfillFills({
        beforeTime: '2025-01-15T00:00:00Z',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('< $'),
        expect.arrayContaining(['2025-01-15T00:00:00Z'])
      );
    });
  });

  describe('getOldestFillTime', () => {
    it('should return oldest fill time', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ oldest: '2024-01-01T00:00:00Z' }],
      });

      const result = await getOldestFillTime();

      expect(result).toBe('2024-01-01T00:00:00Z');
    });

    it('should filter by addresses', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ oldest: '2024-06-01T00:00:00Z' }] });

      await getOldestFillTime(['0x1234', '0x5678']);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('address = ANY($1)'),
        [['0x1234', '0x5678']]
      );
    });

    it('should return null when no fills exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ oldest: null }] });
      const result = await getOldestFillTime();
      expect(result).toBeNull();
    });
  });

  describe('listRecentDecisions', () => {
    it('should return decisions with outcomes', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'uuid-1',
            address: '0x1234',
            asset: 'BTC',
            side: 'long',
            ts: '2025-01-01T00:00:00Z',
            closed_reason: 'take_profit',
            result_r: 2.5,
            closed_ts: '2025-01-02T00:00:00Z',
          },
        ],
      });

      const result = await listRecentDecisions(20);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        status: 'closed',
        closedReason: 'take_profit',
        result: 2.5,
      });
    });

    it('should mark open tickets correctly', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'uuid-2',
            address: '0x5678',
            asset: 'ETH',
            side: 'short',
            ts: '2025-01-01T00:00:00Z',
            closed_reason: null,
            result_r: null,
          },
        ],
      });

      const result = await listRecentDecisions();

      expect(result[0].status).toBe('open');
      expect(result[0].closedReason).toBeNull();
    });
  });
});

describe('Error handling and edge cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle null rowCount in delete operations', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: null });
    const result = await deleteAllTrades();
    expect(result).toBe(0);
  });

  it('should handle undefined in performance rows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          address: '0x1',
          trades: undefined,
          wins: undefined,
          pnl_total: undefined,
          pnl_7d: undefined,
          avg_size: undefined,
        },
      ],
    });

    const result = await getAddressPerformance();
    expect(result[0].trades).toBe(0);
    expect(result[0].wins).toBe(0);
  });

  it('should handle missing payload fields in listRecentFills', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, address: '0x1', at: '2025-01-01', payload: {} },
      ],
    });

    const result = await listRecentFills();
    expect(result[0].size).toBe(0);
    expect(result[0].priceUsd).toBe(0);
    expect(result[0].realizedPnlUsd).toBeNull();
  });

  it('should handle nested payload in listRecentFills', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          address: '0x1',
          at: '2025-01-01',
          payload: { payload: { size: 0.5 } },
        },
      ],
    });

    const result = await listRecentFills();
    expect(result[0].size).toBe(0.5);
  });
});

describe('Position chain validation and repair', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('clearTradesForAddress', () => {
    it('should delete trades for a specific address', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 10 });

      const result = await clearTradesForAddress('0x1234567890abcdef1234567890abcdef12345678');

      expect(result).toBe(10);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM hl_events WHERE type = 'trade' AND LOWER(address) = LOWER($1)"),
        ['0x1234567890abcdef1234567890abcdef12345678']
      );
    });

    it('should filter by symbol when provided', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });

      const result = await clearTradesForAddress('0x1234', 'ETH');

      expect(result).toBe(5);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("payload->>'symbol', 'BTC') = $2"),
        ['0x1234', 'ETH']
      );
    });

    it('should return 0 on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await clearTradesForAddress('0x1234');

      expect(result).toBe(0);
    });

    it('should handle null rowCount', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: null });

      const result = await clearTradesForAddress('0x1234');

      expect(result).toBe(0);
    });
  });

  describe('validatePositionChain', () => {
    it('should return valid for continuous chain', async () => {
      // Fills sorted by time DESC (newest first)
      mockQuery.mockResolvedValueOnce({
        rows: [
          { time_utc: '2025-01-03T00:00:00Z', previous_position: 5, resulting_position: 0 },
          { time_utc: '2025-01-02T00:00:00Z', previous_position: 0, resulting_position: 5 },
        ],
      });

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(true);
      expect(result.gaps.length).toBe(0);
    });

    it('should detect gaps in position chain', async () => {
      // Gap: first fill starts at 5, but second fill results in 10 (missing fills)
      mockQuery.mockResolvedValueOnce({
        rows: [
          { time_utc: '2025-01-03T00:00:00Z', previous_position: 5, resulting_position: 0 },
          { time_utc: '2025-01-02T00:00:00Z', previous_position: 0, resulting_position: 10 },
        ],
      });

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(false);
      expect(result.gaps.length).toBe(1);
      expect(result.gaps[0].expected).toBe(10);
      expect(result.gaps[0].actual).toBe(5);
    });

    it('should allow small floating point differences', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { time_utc: '2025-01-03T00:00:00Z', previous_position: 5.00001, resulting_position: 0 },
          { time_utc: '2025-01-02T00:00:00Z', previous_position: 0, resulting_position: 5 },
        ],
      });

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(true);
    });

    it('should return valid for empty result set', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(true);
      expect(result.gaps.length).toBe(0);
    });

    it('should return valid for single fill', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { time_utc: '2025-01-01T00:00:00Z', previous_position: 0, resulting_position: 5 },
        ],
      });

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(false);
      expect(result.gaps.length).toBe(0);
    });

    it('should query with correct symbol filter', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await validatePositionChain('0x1234', 'BTC');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("COALESCE(payload->>'symbol', 'BTC') = $2"),
        ['0x1234', 'BTC']
      );
    });

    it('should detect multiple gaps', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { time_utc: '2025-01-04T00:00:00Z', previous_position: 0, resulting_position: 0 },
          { time_utc: '2025-01-03T00:00:00Z', previous_position: 5, resulting_position: 10 }, // gap: 10 != 0
          { time_utc: '2025-01-02T00:00:00Z', previous_position: 0, resulting_position: 2 },  // gap: 2 != 5
          { time_utc: '2025-01-01T00:00:00Z', previous_position: 0, resulting_position: 0 },
        ],
      });

      const result = await validatePositionChain('0x1234', 'ETH');

      expect(result.valid).toBe(false);
      expect(result.gaps.length).toBe(2);
    });
  });
});
