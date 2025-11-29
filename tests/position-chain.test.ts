/**
 * Tests for position chain validation and previous position calculation
 *
 * Tests the logic for:
 * - Calculating previous position from resulting position and action
 * - Validating position chain integrity (each fill's resulting position should match next fill's previous position)
 * - Sign conventions for long/short positions
 */

describe('Position Chain Logic', () => {
  /**
   * Position sign conventions:
   * - Long positions are POSITIVE (e.g., +5.0 BTC long)
   * - Short positions are NEGATIVE (e.g., -5.0 BTC short)
   *
   * Action effects:
   * - "Open Long" / "Increase Long": position becomes MORE positive
   * - "Close Long" / "Decrease Long": position becomes LESS positive (toward 0)
   * - "Open Short" / "Increase Short": position becomes MORE negative
   * - "Close Short" / "Decrease Short": position becomes LESS negative (toward 0)
   */

  // Mirrors calculateGroupPreviousPosition from dashboard.js
  function calculatePreviousPosition(
    resultingPosition: number,
    totalSize: number,
    action: string
  ): number {
    const actionLower = action.toLowerCase();
    const isDecrease = actionLower.includes('decrease') || actionLower.includes('close');
    const isShort = actionLower.includes('short');

    if (isShort) {
      if (isDecrease) {
        // "Close Short" / "Decrease Short" means buying to cover
        // Position went from more negative to less negative (or 0)
        // prev = result - totalSize
        return resultingPosition - totalSize;
      } else {
        // "Open Short" / "Increase Short" means selling to go more negative
        // Position went from less negative to more negative
        // prev = result + totalSize
        return resultingPosition + totalSize;
      }
    } else {
      // LONG positions
      if (isDecrease) {
        // "Close Long" / "Decrease Long" means selling to reduce position
        // Position went from more positive to less positive (or 0)
        // prev = result + totalSize
        return resultingPosition + totalSize;
      } else {
        // "Open Long" / "Increase Long" means buying to increase position
        // Position went from less positive to more positive
        // prev = result - totalSize
        return resultingPosition - totalSize;
      }
    }
  }

  // Mirrors signed size XOR logic from dashboard.js
  function calculateSignedSize(totalSize: number, action: string): number {
    const actionLower = action.toLowerCase();
    const isShort = actionLower.includes('short');
    const isDecrease = actionLower.includes('decrease') || actionLower.includes('close');
    // XOR: negative when (decrease AND long) OR (increase AND short)
    const isNegative = isDecrease !== isShort;
    return isNegative ? -totalSize : totalSize;
  }

  describe('calculatePreviousPosition', () => {
    describe('Long positions', () => {
      test('Open Long: prev = result - size (0 -> +5)', () => {
        // Opening 5 BTC long from no position
        const prev = calculatePreviousPosition(5, 5, 'Open Long');
        expect(prev).toBe(0);
      });

      test('Increase Long: prev = result - size (+5 -> +8)', () => {
        // Adding 3 BTC to existing 5 BTC long
        const prev = calculatePreviousPosition(8, 3, 'Increase Long');
        expect(prev).toBe(5);
      });

      test('Decrease Long: prev = result + size (+5 -> +2)', () => {
        // Selling 3 BTC from 5 BTC long
        const prev = calculatePreviousPosition(2, 3, 'Decrease Long');
        expect(prev).toBe(5);
      });

      test('Close Long: prev = result + size (+5 -> 0)', () => {
        // Closing all 5 BTC long
        const prev = calculatePreviousPosition(0, 5, 'Close Long');
        expect(prev).toBe(5);
      });

      test('Close Long (Close All): prev = result + size', () => {
        // Same as Close Long
        const prev = calculatePreviousPosition(0, 10, 'Close Long (Close All)');
        expect(prev).toBe(10);
      });
    });

    describe('Short positions', () => {
      test('Open Short: prev = result + size (0 -> -5)', () => {
        // Opening 5 BTC short from no position
        const prev = calculatePreviousPosition(-5, 5, 'Open Short');
        expect(prev).toBe(0);
      });

      test('Increase Short: prev = result + size (-5 -> -8)', () => {
        // Adding 3 BTC to existing -5 BTC short
        const prev = calculatePreviousPosition(-8, 3, 'Increase Short');
        expect(prev).toBe(-5);
      });

      test('Decrease Short: prev = result - size (-5 -> -2)', () => {
        // Buying back 3 BTC from -5 BTC short
        const prev = calculatePreviousPosition(-2, 3, 'Decrease Short');
        expect(prev).toBe(-5);
      });

      test('Close Short: prev = result - size (-5 -> 0)', () => {
        // Closing all -5 BTC short
        const prev = calculatePreviousPosition(0, 5, 'Close Short');
        expect(prev).toBe(-5);
      });

      test('Close Short (Close All): prev = result - size', () => {
        // Same as Close Short
        const prev = calculatePreviousPosition(0, 10, 'Close Short (Close All)');
        expect(prev).toBe(-10);
      });
    });

    describe('Edge cases', () => {
      test('handles very small positions', () => {
        const prev = calculatePreviousPosition(0.00001, 0.00001, 'Open Long');
        expect(prev).toBeCloseTo(0, 10);
      });

      test('handles very large positions', () => {
        const prev = calculatePreviousPosition(1000000, 500000, 'Increase Long');
        expect(prev).toBe(500000);
      });

      test('handles decimal precision', () => {
        const prev = calculatePreviousPosition(-2860.66360, 170.61170, 'Decrease Short');
        expect(prev).toBeCloseTo(-3031.2753, 4);
      });
    });
  });

  describe('calculateSignedSize (XOR logic)', () => {
    describe('Long actions', () => {
      test('Open Long -> positive', () => {
        expect(calculateSignedSize(5, 'Open Long')).toBe(5);
      });

      test('Increase Long -> positive', () => {
        expect(calculateSignedSize(3, 'Increase Long')).toBe(3);
      });

      test('Decrease Long -> negative', () => {
        expect(calculateSignedSize(3, 'Decrease Long')).toBe(-3);
      });

      test('Close Long -> negative', () => {
        expect(calculateSignedSize(5, 'Close Long')).toBe(-5);
      });
    });

    describe('Short actions', () => {
      test('Open Short -> negative', () => {
        expect(calculateSignedSize(5, 'Open Short')).toBe(-5);
      });

      test('Increase Short -> negative', () => {
        expect(calculateSignedSize(3, 'Increase Short')).toBe(-3);
      });

      test('Decrease Short -> positive', () => {
        expect(calculateSignedSize(3, 'Decrease Short')).toBe(3);
      });

      test('Close Short -> positive', () => {
        expect(calculateSignedSize(5, 'Close Short')).toBe(5);
      });
    });

    describe('XOR truth table', () => {
      // isNegative = isDecrease !== isShort
      // | isDecrease | isShort | isNegative |
      // |------------|---------|------------|
      // | false      | false   | false      | Increase Long -> positive
      // | false      | true    | true       | Increase Short -> negative
      // | true       | false   | true       | Decrease Long -> negative
      // | true       | true    | false      | Decrease Short -> positive

      test('Increase Long (decrease=false, short=false) -> positive', () => {
        expect(calculateSignedSize(1, 'Increase Long')).toBe(1);
      });

      test('Increase Short (decrease=false, short=true) -> negative', () => {
        expect(calculateSignedSize(1, 'Increase Short')).toBe(-1);
      });

      test('Decrease Long (decrease=true, short=false) -> negative', () => {
        expect(calculateSignedSize(1, 'Decrease Long')).toBe(-1);
      });

      test('Decrease Short (decrease=true, short=true) -> positive', () => {
        expect(calculateSignedSize(1, 'Decrease Short')).toBe(1);
      });
    });
  });

  describe('Position chain validation', () => {
    interface Fill {
      time: string;
      action: string;
      size: number;
      startPosition: number;
      resultingPosition: number;
    }

    function calculateResultingPosition(startPosition: number, size: number, action: string): number {
      const actionLower = action.toLowerCase();
      const isShort = actionLower.includes('short');
      const isDecrease = actionLower.includes('decrease') || actionLower.includes('close');

      if (isShort) {
        if (isDecrease) {
          // Decrease Short: buying back, position goes toward 0
          return startPosition + size;
        } else {
          // Increase Short: selling, position becomes more negative
          return startPosition - size;
        }
      } else {
        if (isDecrease) {
          // Decrease Long: selling, position goes toward 0
          return startPosition - size;
        } else {
          // Increase Long: buying, position becomes more positive
          return startPosition + size;
        }
      }
    }

    function validateChain(fills: Fill[]): { valid: boolean; gaps: number[] } {
      const gaps: number[] = [];

      // Fills are sorted newest first, so we iterate in reverse for chronological order
      for (let i = fills.length - 1; i > 0; i--) {
        const current = fills[i];
        const next = fills[i - 1];

        // Current fill's resulting position should equal next fill's start position
        if (Math.abs(current.resultingPosition - next.startPosition) > 0.0001) {
          gaps.push(i);
        }
      }

      return { valid: gaps.length === 0, gaps };
    }

    test('valid chain with long positions', () => {
      const fills: Fill[] = [
        { time: '3', action: 'Close Long', size: 8, startPosition: 8, resultingPosition: 0 },
        { time: '2', action: 'Increase Long', size: 3, startPosition: 5, resultingPosition: 8 },
        { time: '1', action: 'Open Long', size: 5, startPosition: 0, resultingPosition: 5 },
      ];

      const result = validateChain(fills);
      expect(result.valid).toBe(true);
      expect(result.gaps.length).toBe(0);
    });

    test('valid chain with short positions', () => {
      const fills: Fill[] = [
        { time: '3', action: 'Close Short', size: 8, startPosition: -8, resultingPosition: 0 },
        { time: '2', action: 'Increase Short', size: 3, startPosition: -5, resultingPosition: -8 },
        { time: '1', action: 'Open Short', size: 5, startPosition: 0, resultingPosition: -5 },
      ];

      const result = validateChain(fills);
      expect(result.valid).toBe(true);
      expect(result.gaps.length).toBe(0);
    });

    test('detects gap in chain', () => {
      const fills: Fill[] = [
        { time: '3', action: 'Close Long', size: 5, startPosition: 5, resultingPosition: 0 },
        // Gap: resulting -11 doesn't match next start 5 (missing fills in between)
        { time: '2', action: 'Decrease Short', size: 100, startPosition: -111, resultingPosition: -11 },
        { time: '1', action: 'Open Short', size: 5, startPosition: 0, resultingPosition: -5 },
      ];

      const result = validateChain(fills);
      expect(result.valid).toBe(false);
      expect(result.gaps.length).toBeGreaterThan(0);
    });

    test('calculates resulting position correctly for all action types', () => {
      expect(calculateResultingPosition(0, 5, 'Open Long')).toBe(5);
      expect(calculateResultingPosition(5, 3, 'Increase Long')).toBe(8);
      expect(calculateResultingPosition(8, 3, 'Decrease Long')).toBe(5);
      expect(calculateResultingPosition(5, 5, 'Close Long')).toBe(0);

      expect(calculateResultingPosition(0, 5, 'Open Short')).toBe(-5);
      expect(calculateResultingPosition(-5, 3, 'Increase Short')).toBe(-8);
      expect(calculateResultingPosition(-8, 3, 'Decrease Short')).toBe(-5);
      expect(calculateResultingPosition(-5, 5, 'Close Short')).toBe(0);
    });
  });

  describe('Aggregated group previous position', () => {
    interface AggregatedGroup {
      resulting_position: number;
      totalSize: number;
      action: string;
      previous_position?: number;
    }

    function calculateGroupPreviousPosition(group: AggregatedGroup): number | undefined {
      const resultingPos = group.resulting_position;
      const totalSize = group.totalSize;

      if (resultingPos == null || totalSize == null) {
        return undefined;
      }

      const action = (group.action || '').toLowerCase();
      const isDecrease = action.includes('decrease') || action.includes('close');
      const isShort = action.includes('short');

      if (isShort) {
        if (isDecrease) {
          return resultingPos - totalSize;
        } else {
          return resultingPos + totalSize;
        }
      } else {
        if (isDecrease) {
          return resultingPos + totalSize;
        } else {
          return resultingPos - totalSize;
        }
      }
    }

    test('aggregated Decrease Short group: 37 fills with total size 170.61170', () => {
      // Real example from the dashboard: 37 fills aggregated together
      const group: AggregatedGroup = {
        resulting_position: -2860.66360,
        totalSize: 170.61170,
        action: 'Decrease Short',
      };

      const prev = calculateGroupPreviousPosition(group);
      // Decrease Short: prev = result - totalSize
      // prev = -2860.66360 - 170.61170 = -3031.2753
      expect(prev).toBeCloseTo(-3031.2753, 4);
    });

    test('aggregated Close Short group', () => {
      const group: AggregatedGroup = {
        resulting_position: 0,
        totalSize: 2690.05190,
        action: 'Close Short (Close All)',
      };

      const prev = calculateGroupPreviousPosition(group);
      // Close Short: prev = result - totalSize
      expect(prev).toBeCloseTo(-2690.05190, 4);
    });

    test('aggregated Increase Long group', () => {
      const group: AggregatedGroup = {
        resulting_position: 15.3,
        totalSize: 15.3,
        action: 'Open Long',
      };

      const prev = calculateGroupPreviousPosition(group);
      // Open Long: prev = result - totalSize
      expect(prev).toBeCloseTo(0, 4);
    });
  });
});
