import * as hl from '@nktkas/hyperliquid';
import { clearinghouseState as infoClearinghouse } from '@nktkas/hyperliquid/api/info';
import { clearinghouseState as subClearinghouse, userEvents as subUserEvents } from '@nktkas/hyperliquid/api/subscription';
import { getCurrentBtcPrice } from './price';
import { EventQueue, type ChangeEvent } from './queue';
import { insertEvent, upsertCurrentPosition, insertTradeIfNew } from './persist';

type Address = string;

// Hyperliquid WebSocket API limits: max 10 users per connection
const MAX_USERS_PER_WS = 10;

export interface PositionSnapshot {
  size: number; // signed
  entryPriceUsd: number | null;
  liquidationPriceUsd: number | null;
  leverage: number | null;
}

function sideFromSize(size: number): 'long' | 'short' | 'flat' {
  if (size > 0) return 'long';
  if (size < 0) return 'short';
  return 'flat';
}

interface RealtimeOptions {
  onTrade?: (payload: { address: string; event: ChangeEvent }) => void;
}

/**
 * WebSocket connection pool to work around Hyperliquid's 10-user-per-connection limit.
 * Each connection can track up to 10 users.
 */
interface WsSlot {
  ws: any; // WebSocket instance
  users: Set<string>;
  handlers: Map<string, (data: any) => void>;
  ready: boolean;
}

export class RealtimeTracker {
  private ws: any; // shared WebSocketTransport for clearinghouseState
  private http: any; // HttpTransport
  private wsImpl: any; // WS ctor from 'ws' (lazy)
  private subs: Map<Address, { ch?: any; ue?: any; wsSlotIdx?: number }>; // subs + ws slot index
  private wsPool: WsSlot[] = []; // Pool of raw WebSocket connections
  private snapshots: Map<string, { data: PositionSnapshot; updatedAt: string }>; // key: "address:symbol"
  private getAddresses: () => Promise<Address[]>;
  private q: EventQueue;
  private primeInflight: Map<Address, Promise<void>>;
  private lastPrimeAt: Map<Address, number>;
  private onTrade?: (payload: { address: string; event: ChangeEvent }) => void;
  private _positionsReady: boolean = false;

  constructor(getAddresses: () => Promise<Address[]>, queue: EventQueue, opts?: RealtimeOptions) {
    this.getAddresses = getAddresses;
    this.q = queue;
    this.subs = new Map();
    this.snapshots = new Map();
    this.primeInflight = new Map();
    this.lastPrimeAt = new Map();
    this.onTrade = opts?.onTrade;
  }

  /**
   * Get or create a WebSocket slot that has capacity for another user.
   * Returns the slot index and ensures the WebSocket is connected.
   */
  private async getAvailableWsSlot(): Promise<number> {
    await this.ensureSharedTransports();

    // Find existing slot with capacity and ready connection
    for (let i = 0; i < this.wsPool.length; i++) {
      const slot = this.wsPool[i];
      if (slot.ready && slot.users.size < MAX_USERS_PER_WS) {
        return i;
      }
    }

    // Create new WebSocket connection
    const slotIdx = this.wsPool.length;
    const ws = new this.wsImpl('wss://api.hyperliquid.xyz/ws');
    const slot: WsSlot = {
      ws,
      users: new Set(),
      handlers: new Map(),
      ready: false,
    };
    this.wsPool.push(slot);

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
      ws.on('open', () => {
        clearTimeout(timeout);
        slot.ready = true;
        console.log(`[realtime] Created new WebSocket slot ${slotIdx} (total: ${this.wsPool.length})`);
        resolve();
      });
      ws.on('error', (e: any) => {
        clearTimeout(timeout);
        reject(e);
      });
    });

    // Set up message handler for this slot
    ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        // Route user events to the appropriate handler based on user address
        if (msg.channel === 'user' && msg.data?.fills) {
          // Extract user address from the subscription info in the message
          // Hyperliquid sends user in msg.data.user or we can match against our known users
          const msgUser = msg.data?.user?.toLowerCase();
          if (msgUser) {
            // Route to specific handler for this user
            const handler = slot.handlers.get(msgUser);
            if (handler) {
              handler(msg.data);
            }
          } else {
            // Fallback: try to identify user from fills if msg.data.user is not present
            // This shouldn't normally happen but provides safety
            console.warn('[realtime] userEvents message missing user field, checking fills');
            for (const fill of msg.data.fills) {
              // Check if any fill has a user field
              const fillUser = fill?.user?.toLowerCase();
              if (fillUser) {
                const handler = slot.handlers.get(fillUser);
                if (handler) {
                  handler(msg.data);
                }
                break;
              }
            }
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      slot.ready = false;
      console.log(`[realtime] WebSocket slot ${slotIdx} closed`);
      // Reconnect and resubscribe users
      this.reconnectWsSlot(slotIdx).catch((e) => {
        console.warn(`[realtime] Failed to reconnect WebSocket slot ${slotIdx}:`, e);
      });
    });

    return slotIdx;
  }

  /**
   * Reconnect a WebSocket slot and resubscribe all users.
   */
  private async reconnectWsSlot(slotIdx: number): Promise<void> {
    if (slotIdx < 0 || slotIdx >= this.wsPool.length) return;
    const slot = this.wsPool[slotIdx];

    // Get list of users to resubscribe
    const usersToResubscribe = Array.from(slot.users);
    if (usersToResubscribe.length === 0) {
      console.log(`[realtime] WebSocket slot ${slotIdx} has no users, skipping reconnect`);
      return;
    }

    console.log(`[realtime] Reconnecting WebSocket slot ${slotIdx} with ${usersToResubscribe.length} users`);

    // Clear old slot data
    slot.users.clear();
    slot.handlers.clear();

    // Wait before reconnecting to avoid rapid reconnect loops
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create new WebSocket connection
    try {
      const newWs = new this.wsImpl('wss://api.hyperliquid.xyz/ws');

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS reconnect timeout')), 10000);
        newWs.on('open', () => {
          clearTimeout(timeout);
          slot.ws = newWs;
          slot.ready = true;
          console.log(`[realtime] WebSocket slot ${slotIdx} reconnected`);
          resolve();
        });
        newWs.on('error', (e: any) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      // Set up message handler for this slot
      newWs.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          // Route user events to the appropriate handler based on user address
          if (msg.channel === 'user' && msg.data?.fills) {
            // Extract user address from the message
            const msgUser = msg.data?.user?.toLowerCase();
            if (msgUser) {
              // Route to specific handler for this user
              const handler = slot.handlers.get(msgUser);
              if (handler) {
                handler(msg.data);
              }
            } else {
              // Fallback: try to identify user from fills if msg.data.user is not present
              console.warn('[realtime] reconnect: userEvents message missing user field, checking fills');
              for (const fill of msg.data.fills) {
                const fillUser = fill?.user?.toLowerCase();
                if (fillUser) {
                  const handler = slot.handlers.get(fillUser);
                  if (handler) {
                    handler(msg.data);
                  }
                  break;
                }
              }
            }
          }
        } catch {}
      });

      newWs.on('close', () => {
        slot.ready = false;
        console.log(`[realtime] WebSocket slot ${slotIdx} closed`);
        // Reconnect and resubscribe users
        this.reconnectWsSlot(slotIdx).catch((e) => {
          console.warn(`[realtime] Failed to reconnect WebSocket slot ${slotIdx}:`, e);
        });
      });

      // Resubscribe all users
      for (const addr of usersToResubscribe) {
        const user = addr as `0x${string}`;
        const subResult = await new Promise<'ok' | 'limit' | 'error'>((resolve) => {
          const timeout = setTimeout(() => resolve('error'), 5000);

          const handler = (data: any) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.channel === 'subscriptionResponse' &&
                  msg.data?.subscription?.type === 'userEvents' &&
                  msg.data?.subscription?.user?.toLowerCase() === user.toLowerCase()) {
                clearTimeout(timeout);
                newWs.removeListener('message', handler);
                resolve('ok');
              } else if (msg.channel === 'error' && msg.data?.includes('10 total users')) {
                clearTimeout(timeout);
                newWs.removeListener('message', handler);
                resolve('limit');
              }
            } catch {}
          };
          newWs.on('message', handler);

          try {
            newWs.send(JSON.stringify({
              method: 'subscribe',
              subscription: { type: 'userEvents', user }
            }));
          } catch {
            clearTimeout(timeout);
            newWs.removeListener('message', handler);
            resolve('error');
          }
        });

        if (subResult === 'ok') {
          slot.users.add(addr);

          // Update subs map to point to this slot
          const sub = this.subs.get(addr);
          if (sub) {
            sub.wsSlotIdx = slotIdx;
          }

          // Register handler for this user's fills
          slot.handlers.set(addr, (data: any) => {
            if (data?.fills) {
              this.onUserEvents(addr, data);
            }
          });

          console.log(`[realtime] Resubscribed to ${addr} (${slot.users.size}/${MAX_USERS_PER_WS})`);
        } else {
          console.warn(`[realtime] Failed to resubscribe ${addr}: ${subResult}`);
        }
      }

      console.log(`[realtime] WebSocket slot ${slotIdx} resubscribed ${slot.users.size}/${usersToResubscribe.length} users`);
    } catch (e) {
      console.warn(`[realtime] WebSocket slot ${slotIdx} reconnection failed:`, e);
      // Try again after delay
      setTimeout(() => {
        // Re-add users to slot for next reconnect attempt
        for (const addr of usersToResubscribe) {
          slot.users.add(addr);
        }
        this.reconnectWsSlot(slotIdx).catch(() => {});
      }, 10000);
    }
  }

  /**
   * Release a user from their WebSocket slot.
   */
  private releaseFromWsSlot(addr: Address, slotIdx: number | undefined): void {
    if (slotIdx == null || slotIdx < 0 || slotIdx >= this.wsPool.length) return;
    const slot = this.wsPool[slotIdx];
    slot.users.delete(addr);
    slot.handlers.delete(addr);
    // Note: We don't close empty WebSockets to allow reuse
  }

  /** Returns true when initial position priming is complete */
  get positionsReady(): boolean {
    return this._positionsReady;
  }

  async start(opts?: { awaitPositions?: boolean }) {
    await this.ensureSharedTransports();
    // Subscribe to addresses (WebSocket connections)
    await this.refresh();
    // If awaitPositions, wait for HTTP position priming with timeout
    if (opts?.awaitPositions) {
      const timeout = 30000; // 30 second timeout
      const primePromise = this.forceRefreshAllPositions();
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Position priming timeout')), timeout)
      );
      try {
        await Promise.race([primePromise, timeoutPromise]);
      } catch (e) {
        console.warn('[realtime] Position priming timed out or failed:', e);
      }
    }
    // Mark positions as ready (even if timed out, we've made our best effort)
    this._positionsReady = true;
  }

  private async ensureSharedTransports() {
    if (!this.wsImpl) {
      this.wsImpl = (await import('ws')).default as any;
    }
    if (!this.ws) {
      this.ws = new (hl as any).WebSocketTransport({ reconnect: { WebSocket: this.wsImpl } });
    }
    if (!this.http) {
      this.http = new (hl as any).HttpTransport();
    }
  }

  async stop() {
    for (const [, s] of this.subs) {
      try { await s.ch?.unsubscribe?.(); } catch {}
      try { await s.ue?.unsubscribe?.(); } catch {}
    }
    this.subs.clear();

    // Close all WebSocket slots
    for (const slot of this.wsPool) {
      try { slot.ws?.close?.(); } catch {}
      slot.users.clear();
      slot.handlers.clear();
    }
    this.wsPool = [];
  }

  async refresh(opts?: { awaitPositions?: boolean }) {
    const addrs = (await this.getAddresses()).map((a) => a.toLowerCase());
    const current = new Set(this.subs.keys());
    const newAddrs: string[] = [];

    // Unsubscribe removed addresses
    for (const addr of current) {
      if (!addrs.includes(addr)) {
        const s = this.subs.get(addr);
        try { await s?.ch?.unsubscribe?.(); } catch {}
        try { await s?.ue?.unsubscribe?.(); } catch {}
        this.releaseFromWsSlot(addr, s?.wsSlotIdx);
        this.subs.delete(addr);
        this.snapshots.delete(addr);
      }
    }

    // Subscribe new addresses - limit to MAX_USERS_PER_WS (10) due to Hyperliquid API limits
    for (const addr of addrs) {
      if (!this.subs.has(addr)) {
        newAddrs.push(addr);
      }
    }
    if (newAddrs.length > 0) {
      // Hyperliquid limits WebSocket subscriptions to 10 users total per IP
      // Subscribe to top 10 addresses only, HTTP polling handles the rest
      const wsAddrs = newAddrs.slice(0, MAX_USERS_PER_WS);
      const pollingAddrs = newAddrs.slice(MAX_USERS_PER_WS);

      if (pollingAddrs.length > 0) {
        console.log(`[realtime] WebSocket limit: subscribing to ${wsAddrs.length} addresses, ${pollingAddrs.length} will use HTTP polling`);
      } else {
        console.log(`[realtime] Subscribing to ${wsAddrs.length} addresses via WebSocket`);
      }

      // Subscribe to WebSocket addresses
      for (let i = 0; i < wsAddrs.length; i++) {
        const addr = wsAddrs[i];
        try {
          await this.subscribeAddress(addr);
          // Small delay between subscriptions
          if (i < wsAddrs.length - 1) {
            await new Promise(r => setTimeout(r, 100));
          }
        } catch (e) {
          console.warn('[realtime] subscribeAddress failed:', addr, (e as Error).message);
        }
      }

      // For polling addresses, just add to subs map without WebSocket subscription
      for (const addr of pollingAddrs) {
        this.subs.set(addr, {}); // No WebSocket, will be primed via HTTP
      }

      console.log(`[realtime] Subscription complete. ${this.wsPool.length} WebSocket slots, ${pollingAddrs.length} polling-only addresses`);
    }

    // If awaitPositions is true, wait for all position data to be populated
    if (opts?.awaitPositions && newAddrs.length > 0) {
      const primePromises = newAddrs.map(addr => this.primeFromHttp(addr, { force: true }));
      await Promise.allSettled(primePromises);
    }
  }

  private async subscribeAddress(addr: Address) {
    await this.ensureSharedTransports();
    const user = addr as `0x${string}`;
    const subs: { ch?: any; ue?: any; wsSlotIdx?: number } = {};

    // Position data is fetched via HTTP priming (clearinghouseState sub disabled due to 10-user limit)

    // userEvents: fills/trades - use single WebSocket connection (Hyperliquid limits to 10 users per IP)
    let slotIdx: number;
    try {
      slotIdx = await this.getAvailableWsSlot();
    } catch (e) {
      console.warn('[realtime] Failed to get WebSocket slot for', addr, (e as Error).message);
      this.subs.set(addr, subs);
      void this.primeFromHttp(addr);
      return;
    }

    const slot = this.wsPool[slotIdx];

    // Subscribe to userEvents with confirmation
    const subResult = await new Promise<'ok' | 'limit' | 'error'>((resolve) => {
      const timeout = setTimeout(() => resolve('error'), 5000);

      // Temporary handler for subscription response
      const handler = (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.channel === 'subscriptionResponse' &&
              msg.data?.subscription?.type === 'userEvents' &&
              msg.data?.subscription?.user?.toLowerCase() === user.toLowerCase()) {
            clearTimeout(timeout);
            slot.ws.removeListener('message', handler);
            resolve('ok');
          } else if (msg.channel === 'error' && msg.data?.includes('10 total users')) {
            clearTimeout(timeout);
            slot.ws.removeListener('message', handler);
            resolve('limit');
          }
        } catch {}
      };
      slot.ws.on('message', handler);

      // Send subscription request
      try {
        slot.ws.send(JSON.stringify({
          method: 'subscribe',
          subscription: { type: 'userEvents', user }
        }));
      } catch {
        clearTimeout(timeout);
        slot.ws.removeListener('message', handler);
        resolve('error');
      }
    });

    if (subResult === 'ok') {
      slot.users.add(addr);
      subs.wsSlotIdx = slotIdx;

      // Register handler for this user's fills
      slot.handlers.set(addr, (data: any) => {
        if (data?.fills) {
          this.onUserEvents(addr, data);
        }
      });

      console.log(`[realtime] Subscribed to ${addr} (${slot.users.size}/${MAX_USERS_PER_WS})`);
    } else if (subResult === 'limit') {
      console.log(`[realtime] WebSocket limit reached, cannot subscribe to ${addr}`);
    } else {
      console.warn('[realtime] userEvents sub failed for', addr, 'timeout or error');
    }

    this.subs.set(addr, subs);
    // Prime position data via HTTP
    void this.primeFromHttp(addr);
  }

  private onClearinghouse(addr: Address, evt: any) {
    try {
      const positions = evt?.clearinghouseState?.assetPositions || [];

      // Track which coins we see in this update
      const coinsInUpdate = new Set<string>();

      // Process both BTC and ETH positions
      for (const ap of positions as any[]) {
        const coin = String((ap as any)?.position?.coin ?? '').toUpperCase();
        if (coin !== 'BTC' && coin !== 'ETH') continue;

        coinsInUpdate.add(coin);

        const szi = Number(ap?.position?.szi ?? 0);
        const entry = Number(ap?.position?.entryPx ?? NaN);
        const levValue = Number(ap?.position?.leverage?.value ?? NaN);
        const liq = Number(ap?.position?.liquidationPx ?? NaN);

        const snapshot: PositionSnapshot = {
          size: Number.isFinite(szi) ? szi : 0,
          entryPriceUsd: Number.isFinite(entry) ? entry : null,
          liquidationPriceUsd: Number.isFinite(liq) ? liq : null,
          leverage: Number.isFinite(levValue) ? levValue : null,
        };

        const snapshotKey = `${addr}:${coin}`;
        const prev = this.snapshots.get(snapshotKey)?.data;
        const changed = !prev
          || prev.size !== snapshot.size
          || prev.entryPriceUsd !== snapshot.entryPriceUsd
          || prev.liquidationPriceUsd !== snapshot.liquidationPriceUsd
          || prev.leverage !== snapshot.leverage;

        if (changed) {
          const updatedAt = new Date().toISOString();
          this.snapshots.set(snapshotKey, { data: snapshot, updatedAt });

          // For now, only BTC has price tracking; ETH PnL will be null
          const mark = coin === 'BTC' ? (getCurrentBtcPrice().price ?? null) as number | null : null;
          const pnl = (snapshot.entryPriceUsd != null && mark != null)
            ? snapshot.size * (mark - snapshot.entryPriceUsd)
            : null;

          const posEvt = this.q.push({
            type: 'position',
            at: updatedAt,
            address: addr,
            symbol: coin,
            size: snapshot.size,
            side: sideFromSize(snapshot.size),
            entryPriceUsd: snapshot.entryPriceUsd,
            liquidationPriceUsd: snapshot.liquidationPriceUsd,
            leverage: snapshot.leverage,
            pnlUsd: pnl,
          });
          insertEvent({ type: 'position', at: posEvt.at, address: addr, symbol: coin, payload: posEvt })
            .catch((err) => console.error('[realtime] insertEvent failed:', err));
          upsertCurrentPosition({
            address: addr,
            symbol: coin,
            size: snapshot.size,
            entryPriceUsd: snapshot.entryPriceUsd,
            liquidationPriceUsd: snapshot.liquidationPriceUsd,
            leverage: snapshot.leverage,
            pnlUsd: pnl,
            updatedAt,
          }).catch((err) => console.error('[realtime] upsertCurrentPosition failed:', err));
        }
      }

      // Handle closed positions: if we had a position for BTC or ETH but it's not in this update,
      // it means the position was closed (size = 0)
      for (const coin of ['BTC', 'ETH'] as const) {
        const snapshotKey = `${addr}:${coin}`;
        const prev = this.snapshots.get(snapshotKey)?.data;
        // If we had a non-zero position but coin is not in update, position was closed
        if (prev && prev.size !== 0 && !coinsInUpdate.has(coin)) {
          const updatedAt = new Date().toISOString();
          const closedSnapshot: PositionSnapshot = {
            size: 0,
            entryPriceUsd: null,
            liquidationPriceUsd: null,
            leverage: null,
          };
          this.snapshots.set(snapshotKey, { data: closedSnapshot, updatedAt });

          const posEvt = this.q.push({
            type: 'position',
            at: updatedAt,
            address: addr,
            symbol: coin,
            size: 0,
            side: 'flat',
            entryPriceUsd: null,
            liquidationPriceUsd: null,
            leverage: null,
            pnlUsd: null,
          });
          insertEvent({ type: 'position', at: posEvt.at, address: addr, symbol: coin, payload: posEvt })
            .catch((err) => console.error('[realtime] insertEvent (closed) failed:', err));
          upsertCurrentPosition({
            address: addr,
            symbol: coin,
            size: 0,
            entryPriceUsd: null,
            liquidationPriceUsd: null,
            leverage: null,
            pnlUsd: null,
            updatedAt,
          }).catch((err) => console.error('[realtime] upsertCurrentPosition (closed) failed:', err));
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[realtime] clearinghouse handler error', e);
    }
  }

  private async onUserEvents(addr: Address, evt: any) {
    try {
      // We care about FillEvent variant: { fills: [...] }
      if (!evt || !('fills' in evt)) return;
      const fills: any[] = Array.isArray(evt.fills) ? evt.fills : [];
      let touched = false;
      for (const f of fills) {
        const coin = String(f?.coin ?? '').toUpperCase();
        // Only process BTC and ETH fills
        if (coin !== 'BTC' && coin !== 'ETH') continue;
        const px = Number(f?.px ?? NaN);
        const sz = Number(f?.sz ?? NaN);
        const side = f?.side === 'B' ? 'buy' : 'sell';
        const startPosition = Number(f?.startPosition ?? NaN);
        const hash = typeof f?.hash === 'string' ? String(f.hash) : undefined;
        const fee = f?.fee != null ? Number(f.fee) : undefined;
        const feeToken = typeof f?.feeToken === 'string' ? String(f.feeToken) : undefined;
        if (!Number.isFinite(px) || !Number.isFinite(sz) || !Number.isFinite(startPosition)) continue;

        // Signed delta based on side
        const delta = side === 'buy' ? +sz : -sz;
        const newPos = startPosition + delta;
        const effect: 'open' | 'close' = Math.abs(newPos) > Math.abs(startPosition) ? 'open' : (newPos === 0 ? 'close' : 'close');
        const direction = sideFromSize(newPos) === 'flat' ? (delta > 0 ? 'long' : (delta < 0 ? 'short' : 'flat')) : sideFromSize(newPos);
        const realizedPnl = Number(f?.closedPnl ?? NaN);

        const at = new Date((Number(f?.time) || Date.now())).toISOString();
        // Derive action label
        let actionLabel = '';
        if (startPosition === 0) actionLabel = delta > 0 ? 'Open Long' : 'Open Short';
        else if (startPosition > 0) {
          if (delta > 0) actionLabel = 'Increase Long';
          else actionLabel = newPos === 0 ? 'Close Long' : 'Decrease Long';
        } else if (startPosition < 0) {
          if (delta < 0) actionLabel = 'Increase Short';
          else actionLabel = newPos === 0 ? 'Close Short' : 'Decrease Short';
        }

        const persistencePayload = {
          at,
          address: addr,
          symbol: coin,
          action: actionLabel,
          size: Math.abs(sz),
          startPosition,
          priceUsd: px,
          realizedPnlUsd: Number.isFinite(realizedPnl) ? realizedPnl : null,
          fee,
          feeToken,
          hash,
        };
        const persistResult = await insertTradeIfNew(addr, persistencePayload);
        const evt = this.q.push({
          type: 'trade',
          at,
          address: addr,
          symbol: coin,
          side,
          direction,
          effect,
          priceUsd: px,
          size: Math.abs(sz),
          realizedPnlUsd: Number.isFinite(realizedPnl) ? realizedPnl : undefined,
          startPosition,
          fee,
          feeToken,
          hash,
          action: actionLabel,
          dbId: persistResult.id ?? undefined,
        });
        this.onTrade?.({ address: addr, event: evt });
        touched = true;
      }
      if (touched) {
        void this.primeFromHttp(addr, { force: false, minIntervalMs: 2000 });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[realtime] userEvents handler error', e);
    }
  }

  getAllSnapshots(): Array<{
    address: string;
    symbol: 'BTC' | 'ETH';
    size: number;
    side: 'long' | 'short' | 'flat';
    entryPriceUsd: number | null;
    liquidationPriceUsd: number | null;
    leverage: number | null;
    pnlUsd: number | null;
    updatedAt: string;
  }> {
    const btcMark = (getCurrentBtcPrice().price ?? null) as number | null;
    const out: Array<{
      address: string;
      symbol: 'BTC' | 'ETH';
      size: number;
      side: 'long' | 'short' | 'flat';
      entryPriceUsd: number | null;
      liquidationPriceUsd: number | null;
      leverage: number | null;
      pnlUsd: number | null;
      updatedAt: string;
    }> = [];
    for (const [key, { data, updatedAt }] of this.snapshots.entries()) {
      // key format: "address:symbol"
      const [address, symbol] = key.split(':');
      // For now, only BTC has price tracking
      const mark = symbol === 'BTC' ? btcMark : null;
      const pnl = (data.entryPriceUsd != null && mark != null)
        ? data.size * (mark - data.entryPriceUsd)
        : null;
      out.push({
        address,
        symbol: (symbol || 'BTC') as 'BTC' | 'ETH',
        size: data.size,
        side: sideFromSize(data.size),
        entryPriceUsd: data.entryPriceUsd,
        liquidationPriceUsd: data.liquidationPriceUsd,
        leverage: data.leverage,
        pnlUsd: pnl,
        updatedAt,
      });
    }
    // sort by address and symbol for stable output
    out.sort((a, b) => {
      const addrCmp = a.address.localeCompare(b.address);
      return addrCmp !== 0 ? addrCmp : a.symbol.localeCompare(b.symbol);
    });
    return out;
  }

  // Immediate prime via HTTP info API for newly added addresses
  async primeFromHttp(addr: Address, opts?: { force?: boolean; minIntervalMs?: number }): Promise<void> {
    const { force = true, minIntervalMs = 0 } = opts || {};
    const inflight = this.primeInflight.get(addr);
    if (inflight) return inflight;
    if (!force && minIntervalMs > 0) {
      const last = this.lastPrimeAt.get(addr) ?? 0;
      if (Date.now() - last < minIntervalMs) return Promise.resolve();
    }
    const task = this.performPrime(addr).finally(() => {
      this.lastPrimeAt.set(addr, Date.now());
      this.primeInflight.delete(addr);
    });
    this.primeInflight.set(addr, task);
    return task;
  }

  private async performPrime(addr: Address): Promise<void> {
    try {
      if (!this.http) {
        this.http = new (hl as any).HttpTransport();
      }
      const user = addr as `0x${string}`;
      const data = await infoClearinghouse(
        { transport: this.http },
        { user }
      );
      const positions = data.assetPositions || [];

      // Track which coins we see in this response
      const coinsInResponse = new Set<string>();

      // Collect position upsert promises so we can await them
      // This ensures DB writes complete before primeFromHttp returns
      const upsertPromises: Promise<void>[] = [];

      // Process both BTC and ETH positions
      for (const ap of positions as any[]) {
        const coin = String((ap as any)?.position?.coin ?? '').toUpperCase();
        if (coin !== 'BTC' && coin !== 'ETH') continue;

        coinsInResponse.add(coin);

        const szi = Number(ap?.position?.szi ?? 0);
        const entry = Number(ap?.position?.entryPx ?? NaN);
        const levValue = Number(ap?.position?.leverage?.value ?? NaN);
        const liq = Number(ap?.position?.liquidationPx ?? NaN);

        const snapshot: PositionSnapshot = {
          size: Number.isFinite(szi) ? szi : 0,
          entryPriceUsd: Number.isFinite(entry) ? entry : null,
          liquidationPriceUsd: Number.isFinite(liq) ? liq : null,
          leverage: Number.isFinite(levValue) ? levValue : null,
        };

        const updatedAt = new Date().toISOString();
        const snapshotKey = `${addr}:${coin}`;
        this.snapshots.set(snapshotKey, { data: snapshot, updatedAt });

        // For now, only BTC has price tracking
        const mark = coin === 'BTC' ? (getCurrentBtcPrice().price ?? null) as number | null : null;
        const pnl = (snapshot.entryPriceUsd != null && mark != null)
          ? snapshot.size * (mark - snapshot.entryPriceUsd)
          : null;

        const posEvt = this.q.push({
          type: 'position',
          at: updatedAt,
          address: addr,
          symbol: coin,
          size: snapshot.size,
          side: sideFromSize(snapshot.size),
          entryPriceUsd: snapshot.entryPriceUsd,
          liquidationPriceUsd: snapshot.liquidationPriceUsd,
          leverage: snapshot.leverage,
          pnlUsd: pnl,
        });
        // Fire-and-forget for event log (not critical for UI)
        insertEvent({ type: 'position', at: posEvt.at, address: addr, symbol: coin, payload: posEvt })
          .catch((err) => console.error('[realtime] performPrime insertEvent failed:', err));
        // Await position upsert - critical for immediate UI display
        upsertPromises.push(
          upsertCurrentPosition({
            address: addr,
            symbol: coin,
            size: snapshot.size,
            entryPriceUsd: snapshot.entryPriceUsd,
            liquidationPriceUsd: snapshot.liquidationPriceUsd,
            leverage: snapshot.leverage,
            pnlUsd: pnl,
            updatedAt,
          }).catch((err) => {
            console.error('[realtime] performPrime upsertCurrentPosition failed:', err);
          })
        );
      }

      // Handle closed positions: if we had a position for BTC or ETH but it's not in this response,
      // it means the position was closed (size = 0)
      for (const coin of ['BTC', 'ETH'] as const) {
        if (!coinsInResponse.has(coin)) {
          const snapshotKey = `${addr}:${coin}`;
          const prev = this.snapshots.get(snapshotKey)?.data;
          // If we had a non-zero position but coin is not in response, position was closed
          if (prev && prev.size !== 0) {
            const updatedAt = new Date().toISOString();
            const closedSnapshot: PositionSnapshot = {
              size: 0,
              entryPriceUsd: null,
              liquidationPriceUsd: null,
              leverage: null,
            };
            this.snapshots.set(snapshotKey, { data: closedSnapshot, updatedAt });

            const posEvt = this.q.push({
              type: 'position',
              at: updatedAt,
              address: addr,
              symbol: coin,
              size: 0,
              side: 'flat',
              entryPriceUsd: null,
              liquidationPriceUsd: null,
              leverage: null,
              pnlUsd: null,
            });
            // Fire-and-forget for event log
            insertEvent({ type: 'position', at: posEvt.at, address: addr, symbol: coin, payload: posEvt })
              .catch((err) => console.error('[realtime] performPrime insertEvent (closed) failed:', err));
            // Await position upsert for closed position
            upsertPromises.push(
              upsertCurrentPosition({
                address: addr,
                symbol: coin,
                size: 0,
                entryPriceUsd: null,
                liquidationPriceUsd: null,
                leverage: null,
                pnlUsd: null,
                updatedAt,
              }).catch((err) => {
                console.error('[realtime] performPrime upsertCurrentPosition (closed) failed:', err);
              })
            );
          }
        }
      }

      // Wait for all position upserts to complete before returning
      // This ensures positions are in DB when awaitPositions: true is used
      if (upsertPromises.length > 0) {
        await Promise.all(upsertPromises);
      }
    } catch (e) {
      console.error('[realtime] performPrime failed:', { address: addr, error: e });
    }
  }

  async ensureFreshSnapshots(maxAgeMs = 60000): Promise<void> {
    try {
      const addrs = (await this.getAddresses()).map((a) => a.toLowerCase());
      const now = Date.now();
      const tasks: Promise<void>[] = [];
      for (const addr of addrs) {
        const snap = this.snapshots.get(addr);
        const updatedMs = snap?.updatedAt ? Date.parse(snap.updatedAt) : NaN;
        if (!snap || !Number.isFinite(updatedMs) || now - updatedMs > maxAgeMs) {
          tasks.push(this.primeFromHttp(addr, { force: true }));
        }
      }
      if (tasks.length) await Promise.allSettled(tasks);
    } catch {
      // best-effort safeguard; ignore failures
    }
  }

  /**
   * Force refresh positions for all tracked addresses via HTTP.
   * Awaits all position data to be populated in the database before returning.
   * Use after leaderboard refresh to ensure positions are immediately available.
   */
  async forceRefreshAllPositions(): Promise<void> {
    const addrs = (await this.getAddresses()).map((a) => a.toLowerCase());
    const tasks = addrs.map(addr => this.primeFromHttp(addr, { force: true }));
    await Promise.allSettled(tasks);
  }
}
