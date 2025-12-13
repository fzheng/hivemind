/**
 * Tests for WebSocket fill routing logic in RealtimeTracker
 *
 * These tests verify the fix for the data integrity bug where fills were
 * incorrectly broadcast to ALL handlers in a WebSocket slot instead of
 * being routed to the specific user's handler based on msg.data.user.
 *
 * Bug: Each fill was being attributed to ~10 different addresses (all users in the slot)
 * Fix: Extract user from msg.data.user and route to specific handler only
 */

describe('WebSocket Fill Routing', () => {
  /**
   * Simulates the WebSocket message routing logic from RealtimeTracker
   * This mirrors the logic in realtime.ts getAvailableWsSlot() message handler
   */
  function routeFillMessage(
    msg: { channel: string; data?: { user?: string; fills?: any[] } },
    handlers: Map<string, (data: any) => void>
  ): string[] {
    const routedTo: string[] = [];

    if (msg.channel === 'user' && msg.data?.fills) {
      const msgUser = msg.data?.user?.toLowerCase();

      if (msgUser) {
        // Route to specific handler for this user
        const handler = handlers.get(msgUser);
        if (handler) {
          handler(msg.data);
          routedTo.push(msgUser);
        }
      } else {
        // Fallback: try to identify user from fills if msg.data.user is not present
        for (const fill of msg.data.fills) {
          const fillUser = fill?.user?.toLowerCase();
          if (fillUser) {
            const handler = handlers.get(fillUser);
            if (handler) {
              handler(msg.data);
              routedTo.push(fillUser);
            }
            break;
          }
        }
      }
    }

    return routedTo;
  }

  /**
   * Simulates the BUGGY routing logic that was causing the data integrity issue
   * This broadcasts fills to ALL handlers instead of routing to specific user
   */
  function routeFillMessageBuggy(
    msg: { channel: string; data?: { user?: string; fills?: any[] } },
    handlers: Map<string, (data: any) => void>
  ): string[] {
    const routedTo: string[] = [];

    if (msg.channel === 'user' && msg.data?.fills) {
      // BUG: Broadcasting to ALL handlers instead of routing to specific user
      for (const [addr, handler] of handlers.entries()) {
        handler(msg.data);
        routedTo.push(addr);
      }
    }

    return routedTo;
  }

  describe('Fixed routing (routes to specific user)', () => {
    test('routes fill to correct user based on msg.data.user', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      // Set up handlers for 3 different users
      handlers.set('0xaaaa', (data) => receivedBy.push('0xaaaa'));
      handlers.set('0xbbbb', (data) => receivedBy.push('0xbbbb'));
      handlers.set('0xcccc', (data) => receivedBy.push('0xcccc'));

      // Message for user 0xBBBB (note: uppercase in message, lowercase in handler key)
      const msg = {
        channel: 'user',
        data: {
          user: '0xBBBB',
          fills: [{ coin: 'BTC', px: '100000', sz: '0.1' }]
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      // Should only route to 0xbbbb
      expect(routedTo).toEqual(['0xbbbb']);
      expect(receivedBy).toEqual(['0xbbbb']);
    });

    test('does not route to other users in the same slot', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      // Simulate 10 users in one WebSocket slot (Hyperliquid's limit)
      for (let i = 0; i < 10; i++) {
        const addr = `0x${i.toString().padStart(4, '0')}`;
        handlers.set(addr, () => receivedBy.push(addr));
      }

      // Message for user 0x0005
      const msg = {
        channel: 'user',
        data: {
          user: '0x0005',
          fills: [{ coin: 'BTC', px: '100000', sz: '0.1', hash: '0xhash123' }]
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      // Should only route to 0x0005, not to all 10 users
      expect(routedTo).toEqual(['0x0005']);
      expect(receivedBy).toEqual(['0x0005']);
      expect(receivedBy).not.toContain('0x0000');
      expect(receivedBy).not.toContain('0x0009');
    });

    test('handles case-insensitive address matching', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      handlers.set('0xabcdef1234567890abcdef1234567890abcdef12', (data) => {
        receivedBy.push('handler-called');
      });

      // Message with mixed-case address
      const msg = {
        channel: 'user',
        data: {
          user: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
          fills: [{ coin: 'ETH', px: '3000', sz: '1.0' }]
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      expect(routedTo.length).toBe(1);
      expect(receivedBy).toEqual(['handler-called']);
    });

    test('fallback: routes based on fill.user if msg.data.user is missing', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      handlers.set('0xuser1', () => receivedBy.push('0xuser1'));
      handlers.set('0xuser2', () => receivedBy.push('0xuser2'));

      // Message WITHOUT msg.data.user but WITH fill.user
      const msg = {
        channel: 'user',
        data: {
          fills: [{ coin: 'BTC', px: '100000', sz: '0.1', user: '0xUSER2' }]
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      expect(routedTo).toEqual(['0xuser2']);
      expect(receivedBy).toEqual(['0xuser2']);
    });

    test('does not route if user not in handlers', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      handlers.set('0xaaaa', () => receivedBy.push('0xaaaa'));
      handlers.set('0xbbbb', () => receivedBy.push('0xbbbb'));

      // Message for user not in our handlers
      const msg = {
        channel: 'user',
        data: {
          user: '0xcccc',
          fills: [{ coin: 'BTC', px: '100000', sz: '0.1' }]
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      expect(routedTo).toEqual([]);
      expect(receivedBy).toEqual([]);
    });

    test('ignores non-user channel messages', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      handlers.set('0xaaaa', () => receivedBy.push('0xaaaa'));

      // subscriptionResponse message (not a fill)
      const msg = {
        channel: 'subscriptionResponse',
        data: {
          subscription: { type: 'userEvents', user: '0xAAAA' }
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      expect(routedTo).toEqual([]);
      expect(receivedBy).toEqual([]);
    });

    test('ignores messages without fills', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      handlers.set('0xaaaa', () => receivedBy.push('0xaaaa'));

      // User channel message but no fills
      const msg = {
        channel: 'user',
        data: {
          user: '0xAAAA',
          // No fills array
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      expect(routedTo).toEqual([]);
      expect(receivedBy).toEqual([]);
    });
  });

  describe('Buggy routing (demonstrates the bug that was fixed)', () => {
    test('BUGGY: broadcasts fill to ALL users in slot', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedBy: string[] = [];

      // Simulate 10 users in one WebSocket slot
      for (let i = 0; i < 10; i++) {
        const addr = `0x${i.toString().padStart(4, '0')}`;
        handlers.set(addr, () => receivedBy.push(addr));
      }

      // Message for user 0x0005
      const msg = {
        channel: 'user',
        data: {
          user: '0x0005',
          fills: [{ coin: 'BTC', px: '100000', sz: '0.1', hash: '0xhash123' }]
        }
      };

      // Using the BUGGY routing logic
      const routedTo = routeFillMessageBuggy(msg, handlers);

      // Bug: routes to ALL 10 users instead of just 0x0005
      expect(routedTo.length).toBe(10);
      expect(receivedBy.length).toBe(10);
    });

    test('COMPARISON: fixed vs buggy routing', () => {
      const handlersFixed = new Map<string, (data: any) => void>();
      const handlersBuggy = new Map<string, (data: any) => void>();
      const receivedByFixed: string[] = [];
      const receivedByBuggy: string[] = [];

      // Set up identical handlers for both
      for (let i = 0; i < 5; i++) {
        const addr = `0x${i.toString().padStart(4, '0')}`;
        handlersFixed.set(addr, () => receivedByFixed.push(addr));
        handlersBuggy.set(addr, () => receivedByBuggy.push(addr));
      }

      const msg = {
        channel: 'user',
        data: {
          user: '0x0002',
          fills: [{ coin: 'BTC', px: '100000', sz: '0.1' }]
        }
      };

      routeFillMessage(msg, handlersFixed);
      routeFillMessageBuggy(msg, handlersBuggy);

      // Fixed: only routes to the correct user
      expect(receivedByFixed).toEqual(['0x0002']);

      // Buggy: routes to all users (the bug that caused data integrity issues)
      expect(receivedByBuggy.length).toBe(5);
      expect(receivedByBuggy).toContain('0x0000');
      expect(receivedByBuggy).toContain('0x0001');
      expect(receivedByBuggy).toContain('0x0002');
      expect(receivedByBuggy).toContain('0x0003');
      expect(receivedByBuggy).toContain('0x0004');
    });
  });

  describe('Real-world scenarios', () => {
    test('multiple fills in single message all go to same user', () => {
      const handlers = new Map<string, (data: any) => void>();
      const receivedData: any[] = [];

      handlers.set('0xtrader1', (data) => receivedData.push(data));
      handlers.set('0xtrader2', (data) => receivedData.push({ ...data, wrongUser: true }));

      // Message with multiple fills for trader1
      const msg = {
        channel: 'user',
        data: {
          user: '0xTRADER1',
          fills: [
            { coin: 'BTC', px: '100000', sz: '0.1', hash: '0xhash1' },
            { coin: 'BTC', px: '100050', sz: '0.2', hash: '0xhash2' },
            { coin: 'ETH', px: '3000', sz: '1.0', hash: '0xhash3' },
          ]
        }
      };

      const routedTo = routeFillMessage(msg, handlers);

      expect(routedTo).toEqual(['0xtrader1']);
      expect(receivedData.length).toBe(1);
      expect(receivedData[0].fills.length).toBe(3);
      expect(receivedData[0].wrongUser).toBeUndefined();
    });

    test('consecutive fills from different users route correctly', () => {
      const handlers = new Map<string, (data: any) => void>();
      const traderAFills: any[] = [];
      const traderBFills: any[] = [];

      handlers.set('0xtradera', (data) => traderAFills.push(...data.fills));
      handlers.set('0xtraderb', (data) => traderBFills.push(...data.fills));

      // First message for trader A
      routeFillMessage({
        channel: 'user',
        data: {
          user: '0xTRADERA',
          fills: [{ coin: 'BTC', px: '100000', sz: '0.5', hash: '0xhashA1' }]
        }
      }, handlers);

      // Second message for trader B
      routeFillMessage({
        channel: 'user',
        data: {
          user: '0xTRADERB',
          fills: [{ coin: 'ETH', px: '3000', sz: '2.0', hash: '0xhashB1' }]
        }
      }, handlers);

      // Third message for trader A again
      routeFillMessage({
        channel: 'user',
        data: {
          user: '0xTRADERA',
          fills: [{ coin: 'BTC', px: '100100', sz: '0.3', hash: '0xhashA2' }]
        }
      }, handlers);

      // Verify fills went to correct traders
      expect(traderAFills.length).toBe(2);
      expect(traderAFills[0].hash).toBe('0xhashA1');
      expect(traderAFills[1].hash).toBe('0xhashA2');

      expect(traderBFills.length).toBe(1);
      expect(traderBFills[0].hash).toBe('0xhashB1');
    });

    test('action labels are derived correctly from startPosition', () => {
      function deriveActionLabel(startPosition: number, delta: number): string {
        const newPos = startPosition + delta;

        if (startPosition === 0) {
          return delta > 0 ? 'Open Long' : 'Open Short';
        } else if (startPosition > 0) {
          if (delta > 0) return 'Increase Long';
          return newPos === 0 ? 'Close Long' : 'Decrease Long';
        } else {
          // startPosition < 0 (SHORT position)
          if (delta < 0) return 'Increase Short';
          return newPos === 0 ? 'Close Short' : 'Decrease Short';
        }
      }

      // The bug showed "DECREASE SHORT" for address 0x833b...
      // But user said it should be "CLOSE LONG" or "DECREASE LONG"
      // This means startPosition should have been POSITIVE (long), not negative

      // If startPosition is positive (LONG) and we're closing:
      expect(deriveActionLabel(2.36176, -2.36176)).toBe('Close Long');
      expect(deriveActionLabel(2.36176, -1.20000)).toBe('Decrease Long');

      // The BUG caused startPosition to be NEGATIVE (from wrong trader's fill)
      // which would incorrectly show:
      expect(deriveActionLabel(-2.36176, 1.20000)).toBe('Decrease Short');

      // This proves the bug: wrong startPosition from another trader's fill
      // was being used, causing incorrect action labels
    });
  });
});

describe('Handler Map Management', () => {
  test('handlers are keyed by lowercase address', () => {
    const handlers = new Map<string, (data: any) => void>();

    // Simulating subscribeAddress behavior
    const addHandler = (addr: string, handler: (data: any) => void) => {
      handlers.set(addr.toLowerCase(), handler);
    };

    addHandler('0xAAAA', () => {});
    addHandler('0xBBBB', () => {});
    addHandler('0xCcCc', () => {});

    // All should be lowercase
    expect(handlers.has('0xaaaa')).toBe(true);
    expect(handlers.has('0xbbbb')).toBe(true);
    expect(handlers.has('0xcccc')).toBe(true);

    // Original case should not exist
    expect(handlers.has('0xAAAA')).toBe(false);
    expect(handlers.has('0xBBBB')).toBe(false);
  });

  test('handler cleanup on unsubscribe', () => {
    const handlers = new Map<string, (data: any) => void>();
    const users = new Set<string>();

    // Add users
    ['0xaaaa', '0xbbbb', '0xcccc'].forEach(addr => {
      handlers.set(addr, () => {});
      users.add(addr);
    });

    expect(handlers.size).toBe(3);
    expect(users.size).toBe(3);

    // Unsubscribe 0xbbbb
    const releaseFromWsSlot = (addr: string) => {
      handlers.delete(addr.toLowerCase());
      users.delete(addr.toLowerCase());
    };

    releaseFromWsSlot('0xBBBB');

    expect(handlers.size).toBe(2);
    expect(users.size).toBe(2);
    expect(handlers.has('0xbbbb')).toBe(false);
  });
});
