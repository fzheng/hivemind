/**
 * Common Type Definitions
 *
 * Shared TypeScript types used across the ts-lib modules
 * and consuming services.
 *
 * @module types
 */

/**
 * Ethereum address type alias.
 * Should be a lowercase, 0x-prefixed hex string.
 */
export type Address = string;

/**
 * State container for tracked addresses.
 * Used to maintain the list of addresses being monitored.
 */
export interface TrackedState {
  /** List of Ethereum addresses being tracked */
  addresses: Address[];
}

/**
 * Represents a perpetual futures position for a single asset.
 * Used when fetching position data from Hyperliquid.
 */
export interface PositionInfo {
  /** Trading symbol (e.g., 'BTC', 'ETH') */
  symbol: string;
  /** Position size in coin units (positive=long, negative=short) */
  size: number;
  /** Entry price in USD, if available */
  entryPriceUsd?: number;
  /** Leverage multiplier, if available */
  leverage?: number;
}

/**
 * Price information for an asset.
 * Used for price feed responses.
 */
export interface PriceInfo {
  /** Trading symbol (e.g., 'BTCUSD') */
  symbol: string;
  /** Current price in USD */
  price: number;
}
