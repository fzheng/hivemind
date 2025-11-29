/**
 * Event Queue Module
 *
 * Provides an in-memory circular buffer for streaming position and trade events
 * to WebSocket clients. Events are assigned sequential IDs for client-side
 * cursor-based polling.
 *
 * @module queue
 */

/**
 * Union type representing events that can be queued for streaming.
 * Either a position snapshot or a trade fill event.
 */
export type ChangeEvent =
  | {
      /** Event type discriminator */
      type: 'position';
      /** Monotonically increasing sequence number */
      seq: number;
      /** ISO timestamp when the event occurred */
      at: string;
      /** Ethereum address (lowercase) */
      address: string;
      /** Trading symbol */
      symbol: 'BTC' | 'ETH';
      /** Position size in coin units (positive=long, negative=short) */
      size: number;
      /** Derived position direction */
      side: 'long' | 'short' | 'flat';
      /** Entry price in USD, null if no position */
      entryPriceUsd: number | null;
      /** Liquidation price in USD, null if not applicable */
      liquidationPriceUsd: number | null;
      /** Unrealized PnL in USD, null if unavailable */
      pnlUsd: number | null;
      /** Leverage multiplier, null if not applicable */
      leverage: number | null;
    }
  | {
      /** Event type discriminator */
      type: 'trade';
      /** Monotonically increasing sequence number */
      seq: number;
      /** ISO timestamp when the trade occurred */
      at: string;
      /** Ethereum address (lowercase) */
      address: string;
      /** Trading symbol */
      symbol: 'BTC' | 'ETH';
      /** Trade side: buy or sell */
      side: 'buy' | 'sell';
      /** Resulting position direction after trade */
      direction: 'long' | 'short' | 'flat';
      /** Whether this trade opens or closes a position */
      effect: 'open' | 'close';
      /** Execution price in USD */
      priceUsd: number;
      /** Trade size in coin units (absolute value) */
      size: number;
      /** Realized PnL from this trade in USD */
      realizedPnlUsd?: number;
      /** Position size before this trade */
      startPosition?: number;
      /** Trading fee amount */
      fee?: number;
      /** Token used for fee payment */
      feeToken?: string;
      /** Transaction hash */
      hash?: string;
      /** Human-readable action label (e.g., "Open Long") */
      action?: string;
      /** Database ID if persisted */
      dbId?: number;
    };

/**
 * Circular buffer for streaming events to WebSocket clients.
 *
 * Maintains a bounded queue of position and trade events with monotonically
 * increasing sequence numbers. When capacity is exceeded, oldest events are
 * automatically evicted. Clients can poll using `listSince(lastSeq)` to
 * receive only new events.
 *
 * @example
 * ```typescript
 * const queue = new EventQueue(1000);
 * const event = queue.push({ type: 'trade', ... });
 * console.log(event.seq); // 1
 *
 * // Client polling
 * const newEvents = queue.listSince(clientLastSeq);
 * ```
 */
export class EventQueue {
  /** Maximum number of events to retain */
  private capacity: number;
  /** Internal event buffer */
  private buffer: ChangeEvent[] = [];
  /** Next sequence number to assign */
  private nextSeq = 1;

  /**
   * Creates a new EventQueue with the specified capacity.
   * @param capacity - Maximum events to retain (minimum 100, default 5000)
   */
  constructor(capacity = 5000) {
    this.capacity = Math.max(100, capacity);
  }

  /**
   * Adds an event to the queue and assigns a sequence number.
   * Automatically evicts oldest events if capacity is exceeded.
   *
   * @param evt - Event data without sequence number
   * @returns The event with assigned sequence number
   */
  push<T extends Omit<ChangeEvent, 'seq'>>(evt: T): ChangeEvent {
    const withSeq = { ...(evt as any), seq: this.nextSeq++ } as ChangeEvent;
    this.buffer.push(withSeq);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    return withSeq;
  }

  /**
   * Retrieves events with sequence numbers greater than the given value.
   * Used by clients to poll for new events since their last known sequence.
   *
   * @param sinceSeq - Return events with seq > sinceSeq (use 0 for all events)
   * @param limit - Maximum events to return (1-1000, default 200)
   * @returns Array of events in chronological order
   */
  listSince(sinceSeq: number, limit = 200): ChangeEvent[] {
    const startIdx = this.buffer.findIndex((e) => e.seq > sinceSeq);
    if (startIdx === -1) return [];
    return this.buffer.slice(startIdx, startIdx + Math.max(1, Math.min(1000, limit)));
  }

  /**
   * Returns the sequence number of the most recent event.
   * @returns Latest sequence number, or 0 if queue is empty
   */
  latestSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Clears all events and resets the sequence counter.
   * Useful for testing or when re-initializing the tracker.
   */
  reset(): void {
    this.buffer = [];
    this.nextSeq = 1;
  }
}

