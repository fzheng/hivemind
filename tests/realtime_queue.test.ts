import { EventQueue } from '../src/queue';

describe('EventQueue trade extension', () => {
  test('push assigns seq and retains extended fields', () => {
    const q = new EventQueue(10);
    const evt = q.push({
      type: 'trade',
      at: new Date().toISOString(),
      address: '0xabc',
      symbol: 'BTC',
      side: 'buy',
      direction: 'long',
      effect: 'open',
      priceUsd: 50000,
      size: 1,
      realizedPnlUsd: 10,
      startPosition: 0,
      fee: 0.1,
      feeToken: 'USDC',
      hash: '0xhash',
      action: 'Open Long',
      dbId: 42,
    });
    expect((evt as any).seq).toBe(1);
    expect((evt as any).hash).toBe('0xhash');
    expect((evt as any).action).toBe('Open Long');
    expect((evt as any).dbId).toBe(42);
  });

  test('listSince returns only events after seq', () => {
    const q = new EventQueue(10);
    for (let i=0;i<5;i++) {
      q.push({
        type: 'trade', at: new Date().toISOString(), address: '0x'+i, symbol: 'BTC',
        side: 'buy', direction: 'long', effect: 'open', priceUsd: 1, size: 1
      });
    }
    const after2 = q.listSince(2, 10);
    expect(after2.length).toBe(3);
    expect(after2[0].seq).toBe(3);
    expect(after2[after2.length-1].seq).toBe(5);
  });

  test('reset clears buffer and sequence', () => {
    const q = new EventQueue(10);
    q.push({
      type: 'trade', at: new Date().toISOString(), address: '0x0', symbol: 'BTC',
      side: 'buy', direction: 'long', effect: 'open', priceUsd: 1, size: 1
    });
    expect(q.latestSeq()).toBe(1);
    q.reset();
    expect(q.latestSeq()).toBe(0);
    expect(q.listSince(0, 10).length).toBe(0);
  });

  test('listSince returns empty when since >= latest', () => {
    const q = new EventQueue(2);
    q.push({
      type: 'trade', at: new Date().toISOString(), address: '0x0', symbol: 'BTC',
      side: 'buy', direction: 'long', effect: 'open', priceUsd: 1, size: 1
    });
    expect(q.listSince(5, 10).length).toBe(0);
  });

  test('push trims buffer to max capacity (100+)', () => {
    const q = new EventQueue(50);
    for (let i=0;i<150;i++) {
      q.push({
        type: 'trade', at: new Date().toISOString(), address: '0x'+i, symbol: 'BTC',
        side: 'buy', direction: 'long', effect: 'open', priceUsd: i, size: 1
      });
    }
    const events = q.listSince(0, 200);
    expect(events.length).toBe(100); // min capacity enforced
    expect(events[0].seq).toBe(51);
    expect(events[events.length - 1].seq).toBe(150);
  });
});
