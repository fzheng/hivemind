import { mergeTrades, TradeRow, canLoadMore, RateState } from '../src/pagination';

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
});
