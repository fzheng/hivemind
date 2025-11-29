import { mergeTrades, TradeRow, canLoadMore, RateState } from '../packages/ts-lib/src/pagination';

describe('mergeTrades', () => {
  const base: TradeRow[] = [
    { id: 3, time: '2024-01-01T00:00:03.000Z', address: 'a', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
    { id: 2, time: '2024-01-01T00:00:02.000Z', address: 'a', action: 'Sell', size: 2, startPosition: 1, price: 101, closedPnl: null },
    { id: 1, time: '2024-01-01T00:00:01.000Z', address: 'b', action: 'Buy', size: 3, startPosition: 0, price: 102, closedPnl: null },
  ];

  test('adds non-duplicate trades preserving descending order', () => {
    const incoming: TradeRow[] = [
      { id: 6, time: '2024-01-01T00:00:06.000Z', address: 'c', action: 'Buy', size: 1, startPosition: 0, price: 110, closedPnl: null },
      { id: 5, time: '2024-01-01T00:00:05.000Z', address: 'c', action: 'Sell', size: 1, startPosition: 1, price: 109, closedPnl: null },
      { id: 4, time: '2024-01-01T00:00:04.000Z', address: 'a', action: 'Buy', size: 1, startPosition: 0, price: 108, closedPnl: null },
    ];
    const merged = mergeTrades(base, incoming);
    expect(merged.map(t => t.id)).toEqual([6,5,4,3,2,1]);
  });

  test('dedupes identical id/time combos', () => {
    const incoming: TradeRow[] = [
      { id: 2, time: '2024-01-01T00:00:02.000Z', address: 'a', action: 'Sell', size: 2, startPosition: 1, price: 101, closedPnl: null }, // duplicate
      { id: 7, time: '2024-01-01T00:00:07.000Z', address: 'd', action: 'Buy', size: 1, startPosition: 0, price: 120, closedPnl: null },
    ];
    const merged = mergeTrades(base, incoming);
    expect(merged.find(t => t.id === 7)).toBeTruthy();
    expect(merged.filter(t => t.id === 2).length).toBe(1);
  });

  test('uses tx hash when ids differ', () => {
    const incoming: TradeRow[] = [
      { id: 999, time: '2024-01-01T00:00:02.000Z', address: 'a', action: 'Sell', size: 2, startPosition: 1, price: 101, closedPnl: null, tx: '0xabc' },
    ];
    const existingWithHash: TradeRow[] = [
      { id: 123, time: '2024-01-01T00:00:02.000Z', address: 'a', action: 'Sell', size: 2, startPosition: 1, price: 101, closedPnl: null, tx: '0xabc' },
    ];
    const merged = mergeTrades(existingWithHash, incoming);
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe(123);
  });

  test('uses hash field fallback when tx missing', () => {
    const existing: TradeRow[] = [
      { id: 42, time: '2024-02-01T00:00:02.000Z', address: '0xabc', action: 'Sell', size: 1, startPosition: 0, price: 100, closedPnl: null, tx: null },
    ];
    const incoming = [
      { id: 99, time: '2024-02-01T00:00:02.000Z', address: '0xabc', action: 'Sell', size: 1, startPosition: 0, price: 100, closedPnl: null, tx: null, hash: '0xhash' } as unknown as TradeRow,
      { id: 100, time: '2024-02-01T00:00:02.000Z', address: '0xabc', action: 'Sell', size: 1, startPosition: 0, price: 100, closedPnl: null, tx: null, hash: '0xhash' } as unknown as TradeRow,
    ];
    const merged = mergeTrades(existing, incoming as TradeRow[]);
    expect(merged.length).toBe(2); // one existing + one hashed addition
    expect(merged.filter((t: any) => t.hash === '0xhash').length).toBe(1);
  });

  test('falls back to time/address signature when id omitted', () => {
    const existing: TradeRow[] = [
      { id: 11, time: '2024-03-01T00:00:01.000Z', address: '0x1', action: 'Buy', size: 0.5, startPosition: 0, price: 10, closedPnl: null } as unknown as TradeRow,
    ];
    (existing[0] as any).id = undefined;
    const incoming = [
      { time: '2024-03-01T00:00:01.000Z', address: '0x1', action: 'Buy', size: 0.5, startPosition: 0, price: 10, closedPnl: null } as unknown as TradeRow,
    ];
    const merged = mergeTrades(existing, incoming);
    expect(merged.length).toBe(1);
  });

  test('stable when incoming empty', () => {
    const merged = mergeTrades(base, []);
    expect(merged).toEqual(base);
  });

  test('canLoadMore enforces interval', () => {
    const st: RateState = { lastAt: 0 };
    expect(canLoadMore(st, 200)).toBe(true); // first call
    expect(canLoadMore(st, 200)).toBe(false); // too soon
    // simulate time passage
    st.lastAt -= 250;
    expect(canLoadMore(st, 200)).toBe(true);
  });

  // Additional edge case tests for tradeKey fallback paths
  test('uses id-only key when no time or tx hash', () => {
    const existing: TradeRow[] = [
      { id: 42, time: '', address: '0x1', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
    ];
    const incoming: TradeRow[] = [
      { id: 42, time: '', address: '0x1', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
      { id: 43, time: '', address: '0x1', action: 'Sell', size: 1, startPosition: 1, price: 101, closedPnl: null },
    ];
    const merged = mergeTrades(existing, incoming);
    expect(merged.length).toBe(2); // id:42 deduped, id:43 added
    expect(merged.find(t => t.id === 42)).toBeTruthy();
    expect(merged.find(t => t.id === 43)).toBeTruthy();
  });

  test('uses fallback key when no id, time, or address available', () => {
    // This tests the fallback path in tradeKey: `fallback:${t.address ?? ''}:${t.time ?? ''}`
    const existing: TradeRow[] = [];
    const incoming: TradeRow[] = [
      { address: '', time: '', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null } as TradeRow,
      { address: '', time: '', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null } as TradeRow,
    ];
    const merged = mergeTrades(existing, incoming);
    // Both have same fallback key, so only one is kept
    expect(merged.length).toBe(1);
  });

  test('handles invalid time strings with fallback to 0 timestamp', () => {
    const existing: TradeRow[] = [
      { id: 1, time: 'invalid-time', address: '0x1', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
      { id: 2, time: '2024-01-01T00:00:01.000Z', address: '0x1', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
    ];
    const merged = mergeTrades(existing, []);
    // Should still sort without error, invalid time treated as 0
    expect(merged.length).toBe(2);
    // Valid time should come first (newer)
    expect(merged[0].id).toBe(2);
    expect(merged[1].id).toBe(1);
  });

  test('sorts by id when timestamps are equal', () => {
    const sameTime = '2024-01-01T12:00:00.000Z';
    const existing: TradeRow[] = [
      { id: 1, time: sameTime, address: '0x1', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
      { id: 5, time: sameTime, address: '0x2', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
      { id: 3, time: sameTime, address: '0x3', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
    ];
    const merged = mergeTrades(existing, []);
    // Should sort by id desc when time is equal
    expect(merged.map(t => t.id)).toEqual([5, 3, 1]);
  });

  test('handles undefined id in sorting', () => {
    const existing: TradeRow[] = [
      { time: '2024-01-01T12:00:00.000Z', address: '0x1', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null } as TradeRow,
      { id: 5, time: '2024-01-01T12:00:00.000Z', address: '0x2', action: 'Buy', size: 1, startPosition: 0, price: 100, closedPnl: null },
    ];
    const merged = mergeTrades(existing, []);
    // id:5 should come before undefined id (5 > 0)
    expect(merged[0].id).toBe(5);
    expect(merged[1].id).toBeUndefined();
  });
});
