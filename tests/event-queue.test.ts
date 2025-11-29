/**
 * Tests for EventQueue class
 * Covers event buffering, sequence numbers, capacity limits, and querying
 */

import { EventQueue, ChangeEvent } from '../packages/ts-lib/src/queue';

describe('EventQueue', () => {
  let queue: EventQueue;

  beforeEach(() => {
    queue = new EventQueue(100);
  });

  describe('constructor', () => {
    test('creates queue with specified capacity', () => {
      const q = new EventQueue(500);
      expect(q.latestSeq()).toBe(0);
    });

    test('enforces minimum capacity of 100', () => {
      const q = new EventQueue(10);
      // Push 150 events to verify capacity is at least 100
      for (let i = 0; i < 150; i++) {
        q.push({
          type: 'position',
          at: new Date().toISOString(),
          address: '0x1234567890abcdef1234567890abcdef12345678',
          symbol: 'BTC',
          size: 0.5,
          side: 'long',
          entryPriceUsd: 95000,
          liquidationPriceUsd: 90000,
          pnlUsd: 100,
          leverage: 10,
        });
      }
      // Should keep at least 100 events
      const events = q.listSince(0, 200);
      expect(events.length).toBeGreaterThanOrEqual(100);
    });

    test('uses default capacity when not specified', () => {
      const q = new EventQueue();
      expect(q.latestSeq()).toBe(0);
    });
  });

  describe('push', () => {
    test('assigns sequential sequence numbers', () => {
      const evt1 = queue.push({
        type: 'position',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        size: 0.5,
        side: 'long',
        entryPriceUsd: 95000,
        liquidationPriceUsd: 90000,
        pnlUsd: 100,
        leverage: 10,
      });

      const evt2 = queue.push({
        type: 'trade',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        side: 'buy',
        direction: 'long',
        effect: 'open',
        priceUsd: 3500,
        size: 1.0,
      });

      expect(evt1.seq).toBe(1);
      expect(evt2.seq).toBe(2);
    });

    test('returns event with sequence number', () => {
      const input = {
        type: 'trade' as const,
        at: '2025-01-01T00:00:00Z',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC' as const,
        side: 'buy' as const,
        direction: 'long' as const,
        effect: 'open' as const,
        priceUsd: 95000,
        size: 0.5,
      };

      const result = queue.push(input);

      expect(result.seq).toBe(1);
      expect(result.type).toBe('trade');
      expect(result.address).toBe(input.address);
      expect(result.priceUsd).toBe(95000);
    });

    test('evicts oldest events when capacity exceeded', () => {
      const smallQueue = new EventQueue(100);

      // Push 150 events
      for (let i = 1; i <= 150; i++) {
        smallQueue.push({
          type: 'position',
          at: new Date().toISOString(),
          address: '0x1234567890abcdef1234567890abcdef12345678',
          symbol: 'BTC',
          size: i * 0.1,
          side: 'long',
          entryPriceUsd: 95000,
          liquidationPriceUsd: 90000,
          pnlUsd: i * 10,
          leverage: 10,
        });
      }

      const events = smallQueue.listSince(0, 200);
      expect(events.length).toBe(100);
      // First event should be seq 51 (events 1-50 were evicted)
      expect(events[0].seq).toBe(51);
      // Last event should be seq 150
      expect(events[events.length - 1].seq).toBe(150);
    });
  });

  describe('listSince', () => {
    beforeEach(() => {
      // Push 10 events
      for (let i = 1; i <= 10; i++) {
        queue.push({
          type: 'position',
          at: new Date().toISOString(),
          address: '0x1234567890abcdef1234567890abcdef12345678',
          symbol: 'BTC',
          size: i * 0.1,
          side: 'long',
          entryPriceUsd: 95000,
          liquidationPriceUsd: 90000,
          pnlUsd: i * 10,
          leverage: 10,
        });
      }
    });

    test('returns all events since sequence 0', () => {
      const events = queue.listSince(0);
      expect(events.length).toBe(10);
      expect(events[0].seq).toBe(1);
      expect(events[9].seq).toBe(10);
    });

    test('returns events after specified sequence', () => {
      const events = queue.listSince(5);
      expect(events.length).toBe(5);
      expect(events[0].seq).toBe(6);
      expect(events[4].seq).toBe(10);
    });

    test('returns empty array when no events after sequence', () => {
      const events = queue.listSince(10);
      expect(events.length).toBe(0);
    });

    test('returns empty array for future sequence', () => {
      const events = queue.listSince(100);
      expect(events.length).toBe(0);
    });

    test('respects limit parameter', () => {
      const events = queue.listSince(0, 3);
      expect(events.length).toBe(3);
      expect(events[0].seq).toBe(1);
      expect(events[2].seq).toBe(3);
    });

    test('enforces minimum limit of 1', () => {
      const events = queue.listSince(0, 0);
      expect(events.length).toBe(1);
    });

    test('enforces maximum limit of 1000', () => {
      // Create queue with many events
      const largeQueue = new EventQueue(2000);
      for (let i = 1; i <= 1500; i++) {
        largeQueue.push({
          type: 'position',
          at: new Date().toISOString(),
          address: '0x1234567890abcdef1234567890abcdef12345678',
          symbol: 'BTC',
          size: 0.1,
          side: 'long',
          entryPriceUsd: 95000,
          liquidationPriceUsd: 90000,
          pnlUsd: 10,
          leverage: 10,
        });
      }

      const events = largeQueue.listSince(0, 2000);
      expect(events.length).toBe(1000);
    });

    test('uses default limit of 200', () => {
      const mediumQueue = new EventQueue(500);
      for (let i = 1; i <= 300; i++) {
        mediumQueue.push({
          type: 'position',
          at: new Date().toISOString(),
          address: '0x1234567890abcdef1234567890abcdef12345678',
          symbol: 'BTC',
          size: 0.1,
          side: 'long',
          entryPriceUsd: 95000,
          liquidationPriceUsd: 90000,
          pnlUsd: 10,
          leverage: 10,
        });
      }

      const events = mediumQueue.listSince(0);
      expect(events.length).toBe(200);
    });
  });

  describe('latestSeq', () => {
    test('returns 0 for empty queue', () => {
      expect(queue.latestSeq()).toBe(0);
    });

    test('returns latest sequence number', () => {
      queue.push({
        type: 'trade',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        side: 'buy',
        direction: 'long',
        effect: 'open',
        priceUsd: 95000,
        size: 0.5,
      });

      queue.push({
        type: 'trade',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        side: 'sell',
        direction: 'short',
        effect: 'open',
        priceUsd: 3500,
        size: 1.0,
      });

      expect(queue.latestSeq()).toBe(2);
    });
  });

  describe('reset', () => {
    test('clears all events', () => {
      queue.push({
        type: 'position',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        size: 0.5,
        side: 'long',
        entryPriceUsd: 95000,
        liquidationPriceUsd: 90000,
        pnlUsd: 100,
        leverage: 10,
      });

      queue.reset();

      expect(queue.latestSeq()).toBe(0);
      expect(queue.listSince(0).length).toBe(0);
    });

    test('resets sequence counter to 1', () => {
      queue.push({
        type: 'trade',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        side: 'buy',
        direction: 'long',
        effect: 'open',
        priceUsd: 95000,
        size: 0.5,
      });

      queue.reset();

      const newEvt = queue.push({
        type: 'trade',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        side: 'sell',
        direction: 'short',
        effect: 'open',
        priceUsd: 96000,
        size: 0.5,
      });

      expect(newEvt.seq).toBe(1);
    });
  });

  describe('event types', () => {
    test('handles position events correctly', () => {
      const evt = queue.push({
        type: 'position',
        at: '2025-01-01T12:00:00Z',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'BTC',
        size: -0.5,
        side: 'short',
        entryPriceUsd: 95000,
        liquidationPriceUsd: 100000,
        pnlUsd: -50,
        leverage: 20,
      });

      expect(evt.type).toBe('position');
      if (evt.type === 'position') {
        expect(evt.side).toBe('short');
        expect(evt.size).toBe(-0.5);
        expect(evt.leverage).toBe(20);
      }
    });

    test('handles trade events with optional fields', () => {
      const evt = queue.push({
        type: 'trade',
        at: '2025-01-01T12:00:00Z',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        side: 'buy',
        direction: 'long',
        effect: 'open',
        priceUsd: 3500,
        size: 2.0,
        realizedPnlUsd: 150,
        startPosition: 0,
        fee: 0.35,
        feeToken: 'USDC',
        hash: '0xabc123',
        action: 'Open Long',
        dbId: 12345,
      });

      expect(evt.type).toBe('trade');
      if (evt.type === 'trade') {
        expect(evt.realizedPnlUsd).toBe(150);
        expect(evt.startPosition).toBe(0);
        expect(evt.fee).toBe(0.35);
        expect(evt.hash).toBe('0xabc123');
        expect(evt.action).toBe('Open Long');
        expect(evt.dbId).toBe(12345);
      }
    });

    test('handles ETH symbol', () => {
      const evt = queue.push({
        type: 'position',
        at: new Date().toISOString(),
        address: '0x1234567890abcdef1234567890abcdef12345678',
        symbol: 'ETH',
        size: 5.0,
        side: 'long',
        entryPriceUsd: 3500,
        liquidationPriceUsd: 3000,
        pnlUsd: 200,
        leverage: 5,
      });

      if (evt.type === 'position') {
        expect(evt.symbol).toBe('ETH');
      }
    });
  });
});
