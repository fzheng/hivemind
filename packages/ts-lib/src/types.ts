export type Address = string;

export interface TrackedState {
  addresses: Address[];
}

export interface PositionInfo {
  symbol: string; // e.g., BTC-PERP or BTC
  size: number;   // positive for long, negative for short, in coin units
  entryPriceUsd?: number; // optional
  leverage?: number; // optional
}

export interface PriceInfo {
  symbol: string; // BTCUSDT
  price: number;  // in USD
}

// Recommendation interface removed (feature deprecated)
