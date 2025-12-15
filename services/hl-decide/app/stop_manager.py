"""
Stop-Loss and Take-Profit Management

Phase 4.3: Position Management
Phase 6: Multi-Exchange Support
Phase 6.2: Native Stop Orders (Execution Resilience)

Monitors open positions and triggers exits when:
- Price hits stop-loss level
- Price hits take-profit level
- Position times out (configurable)

This module supports two modes:
1. Native stops (preferred): Place SL/TP orders directly on exchange
   - Lower latency, no polling required for stop execution
   - Exchange handles execution even if our service is down
2. Fallback polling: Monitor prices locally and execute market closes
   - Used when exchange doesn't support native stops
   - Required for trailing stops (dynamic stop prices)
   - Required for timeout-based exits

Supports multiple exchanges via ExchangeManager (Phase 6).

@module stop_manager
"""

import asyncio
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

import asyncpg

from .hl_exchange import get_exchange as get_hl_exchange, OrderResult
from .exchanges import (
    ExchangeType,
    get_exchange_manager,
    OrderResult as ExchangeOrderResult,
)


# Configuration
STOP_POLL_INTERVAL_S = int(os.getenv("STOP_POLL_INTERVAL_S", "5"))
DEFAULT_RR_RATIO = float(os.getenv("DEFAULT_RR_RATIO", "2.0"))  # 2:1 reward:risk
MAX_POSITION_HOURS = int(os.getenv("MAX_POSITION_HOURS", "168"))  # 7 days
TRAILING_STOP_ENABLED = os.getenv("TRAILING_STOP_ENABLED", "false").lower() == "true"
# Native stops are preferred for lower latency execution
USE_NATIVE_STOPS = os.getenv("USE_NATIVE_STOPS", "true").lower() == "true"


@dataclass
class StopConfig:
    """Configuration for a position's stop management."""

    decision_id: str
    symbol: str
    direction: str  # "long" or "short"
    entry_price: float
    entry_size: float
    stop_price: float
    take_profit_price: Optional[float]
    trailing_enabled: bool
    trail_distance_pct: float
    timeout_at: Optional[datetime]
    created_at: datetime
    exchange: str = "hyperliquid"  # Phase 6: track which exchange
    native_stop_placed: bool = False  # Phase 6.2: whether native stop is active on exchange


@dataclass
class StopTriggerResult:
    """Result when a stop is triggered."""

    decision_id: str
    trigger_reason: str  # "stop_loss", "take_profit", "timeout", "manual"
    trigger_price: float
    order_result: Optional[OrderResult]


class StopManager:
    """
    Manages stop-loss and take-profit levels for open positions.

    Runs as a background task, polling positions and prices every N seconds.
    When price crosses a stop level, triggers a position close.

    Usage:
        manager = StopManager(db_pool)
        await manager.register_stop(decision_id, symbol, entry_price, stop_pct, direction)
        asyncio.create_task(manager.run_loop())
    """

    def __init__(self, db: asyncpg.Pool):
        """
        Initialize StopManager.

        Args:
            db: Database pool for state persistence
        """
        self.db = db
        self._running = False
        self._poll_interval = STOP_POLL_INTERVAL_S

    async def register_stop(
        self,
        decision_id: str,
        symbol: str,
        direction: str,
        entry_price: float,
        entry_size: float,
        stop_distance_pct: float,
        take_profit_rr: float = DEFAULT_RR_RATIO,
        trailing_enabled: bool = TRAILING_STOP_ENABLED,
        timeout_hours: int = MAX_POSITION_HOURS,
        exchange: str = "hyperliquid",
    ) -> StopConfig:
        """
        Register a stop for a newly opened position.

        For non-trailing stops, attempts to place native SL/TP orders on the exchange
        for lower latency execution. Falls back to polling if native stops fail.

        Args:
            decision_id: ID of the decision that opened this position
            symbol: Asset symbol (BTC, ETH)
            direction: Position direction (long, short)
            entry_price: Entry price
            entry_size: Position size in coins
            stop_distance_pct: Stop distance as fraction (0.02 = 2%)
            take_profit_rr: Reward:risk ratio for take-profit
            trailing_enabled: Whether to trail the stop
            timeout_hours: Maximum hours to hold position
            exchange: Exchange where position is held (Phase 6)

        Returns:
            StopConfig with all stop parameters
        """
        # Calculate stop and take-profit prices
        stop_price = self._calculate_stop_price(
            entry_price, direction, stop_distance_pct
        )
        take_profit_price = self._calculate_take_profit(
            entry_price, stop_price, direction, take_profit_rr
        )

        # Calculate timeout
        timeout_at = datetime.now(timezone.utc) + timedelta(hours=timeout_hours)

        # Try to place native stop orders if enabled and not trailing
        native_stop_placed = False
        if USE_NATIVE_STOPS and not trailing_enabled:
            native_stop_placed = await self._place_native_stops(
                symbol=symbol,
                stop_price=stop_price,
                take_profit_price=take_profit_price,
                entry_size=entry_size,
                exchange=exchange,
            )

        config = StopConfig(
            decision_id=decision_id,
            symbol=symbol,
            direction=direction,
            entry_price=entry_price,
            entry_size=entry_size,
            stop_price=stop_price,
            take_profit_price=take_profit_price,
            trailing_enabled=trailing_enabled,
            trail_distance_pct=stop_distance_pct,
            timeout_at=timeout_at,
            created_at=datetime.now(timezone.utc),
            exchange=exchange,
            native_stop_placed=native_stop_placed,
        )

        # Persist to database
        await self._save_stop(config)

        mode = "NATIVE" if native_stop_placed else "POLLING"
        tp_str = f"${take_profit_price:.2f}" if take_profit_price else "None"
        print(
            f"[stop_manager] Registered stop for {decision_id} [{mode}]: "
            f"{symbol} {direction} on {exchange} entry=${entry_price:.2f}, "
            f"stop=${stop_price:.2f}, tp={tp_str}"
        )

        return config

    async def _place_native_stops(
        self,
        symbol: str,
        stop_price: float,
        take_profit_price: Optional[float],
        entry_size: float,
        exchange: str,
    ) -> bool:
        """
        Place native stop-loss and take-profit orders on the exchange.

        Args:
            symbol: Asset symbol
            stop_price: Stop-loss trigger price
            take_profit_price: Take-profit trigger price (optional)
            entry_size: Position size
            exchange: Exchange name

        Returns:
            True if native stops were placed successfully
        """
        exchange_manager = get_exchange_manager()

        try:
            exchange_type = ExchangeType(exchange)
            exchange_adapter = exchange_manager.get_exchange(exchange_type)

            if not exchange_adapter or not exchange_adapter.is_connected:
                print(f"[stop_manager] Exchange {exchange} not connected, using polling")
                return False

            if not exchange_adapter.supports_native_stops:
                print(f"[stop_manager] Exchange {exchange} doesn't support native stops")
                return False

            # Place stop-loss and take-profit atomically if possible
            formatted_symbol = exchange_adapter.format_symbol(symbol)
            sl_result, tp_result = await exchange_adapter.set_stop_loss_take_profit(
                symbol=formatted_symbol,
                stop_price=stop_price,
                take_profit_price=take_profit_price,
                size=entry_size,
            )

            if sl_result.success:
                print(
                    f"[stop_manager] Native SL placed on {exchange}: "
                    f"{symbol} @ ${stop_price:.2f}"
                )
            else:
                print(
                    f"[stop_manager] Native SL failed on {exchange}: {sl_result.error}"
                )
                return False

            if take_profit_price and tp_result.success:
                print(
                    f"[stop_manager] Native TP placed on {exchange}: "
                    f"{symbol} @ ${take_profit_price:.2f}"
                )
            elif take_profit_price and not tp_result.success:
                print(
                    f"[stop_manager] Native TP failed on {exchange}: {tp_result.error}"
                )
                # Still return True since SL was placed successfully
                # We'll monitor TP via polling

            return sl_result.success

        except (ValueError, Exception) as e:
            print(f"[stop_manager] Failed to place native stops: {e}")
            return False

    def _calculate_stop_price(
        self,
        entry_price: float,
        direction: str,
        stop_distance_pct: float,
    ) -> float:
        """Calculate stop-loss price based on direction and distance."""
        if direction == "long":
            return entry_price * (1 - stop_distance_pct)
        else:
            return entry_price * (1 + stop_distance_pct)

    def _calculate_take_profit(
        self,
        entry_price: float,
        stop_price: float,
        direction: str,
        rr_ratio: float,
    ) -> Optional[float]:
        """Calculate take-profit price based on reward:risk ratio."""
        if rr_ratio <= 0:
            return None

        stop_distance = abs(entry_price - stop_price)
        profit_distance = stop_distance * rr_ratio

        if direction == "long":
            return entry_price + profit_distance
        else:
            return entry_price - profit_distance

    async def _save_stop(self, config: StopConfig) -> None:
        """Save stop configuration to database."""
        try:
            async with self.db.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO active_stops
                    (decision_id, symbol, direction, entry_price, entry_size,
                     stop_price, take_profit_price, trailing_enabled,
                     trail_distance_pct, timeout_at, status, exchange, native_stop_placed)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12)
                    ON CONFLICT (symbol, decision_id) DO UPDATE SET
                        stop_price = EXCLUDED.stop_price,
                        take_profit_price = EXCLUDED.take_profit_price,
                        exchange = EXCLUDED.exchange,
                        native_stop_placed = EXCLUDED.native_stop_placed,
                        status = 'active'
                    """,
                    config.decision_id,
                    config.symbol,
                    config.direction,
                    config.entry_price,
                    config.entry_size,
                    config.stop_price,
                    config.take_profit_price,
                    config.trailing_enabled,
                    config.trail_distance_pct,
                    config.timeout_at,
                    config.exchange,
                    config.native_stop_placed,
                )
        except Exception as e:
            print(f"[stop_manager] Failed to save stop: {e}")

    async def get_active_stops(self) -> list[StopConfig]:
        """Get all active stops from database."""
        try:
            async with self.db.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT decision_id, symbol, direction, entry_price, entry_size,
                           stop_price, take_profit_price, trailing_enabled,
                           trail_distance_pct, timeout_at, created_at,
                           COALESCE(exchange, 'hyperliquid') as exchange,
                           COALESCE(native_stop_placed, FALSE) as native_stop_placed
                    FROM active_stops
                    WHERE status = 'active'
                    """
                )
                return [
                    StopConfig(
                        decision_id=str(row["decision_id"]),
                        symbol=row["symbol"],
                        direction=row["direction"],
                        entry_price=float(row["entry_price"]),
                        entry_size=float(row["entry_size"]),
                        stop_price=float(row["stop_price"]),
                        take_profit_price=(
                            float(row["take_profit_price"])
                            if row["take_profit_price"]
                            else None
                        ),
                        trailing_enabled=row["trailing_enabled"],
                        trail_distance_pct=float(row["trail_distance_pct"] or 0.02),
                        timeout_at=row["timeout_at"],
                        created_at=row["created_at"],
                        exchange=row["exchange"],
                        native_stop_placed=row["native_stop_placed"],
                    )
                    for row in rows
                ]
        except Exception as e:
            print(f"[stop_manager] Failed to get active stops: {e}")
            return []

    async def check_stops(self) -> list[StopTriggerResult]:
        """
        Check all active stops against current prices.

        For positions with native stops placed:
        - Only monitor for timeout (exchange handles SL/TP execution)
        - Reduced latency since exchange executes stops directly

        For positions without native stops (trailing or fallback):
        - Poll prices and check SL/TP levels locally
        - Execute market closes when triggered

        Uses ExchangeManager for multi-exchange price lookups.
        Falls back to legacy Hyperliquid API if exchange not connected.

        Returns:
            List of triggered stops
        """
        triggered = []
        stops = await self.get_active_stops()

        if not stops:
            return triggered

        # Get current prices grouped by exchange
        # Only needed for non-native stops and trailing stops
        exchange_manager = get_exchange_manager()
        prices: dict[tuple[str, str], float] = {}  # (exchange, symbol) -> price

        # Only fetch prices for stops that need polling
        for stop in stops:
            # Native stops don't need price polling for SL/TP (only for timeout)
            if stop.native_stop_placed and not stop.trailing_enabled:
                continue

            key = (stop.exchange, stop.symbol)
            if key in prices:
                continue

            price = await self._get_price_for_stop(stop, exchange_manager)
            if price:
                prices[key] = price

        now = datetime.now(timezone.utc)

        for stop in stops:
            key = (stop.exchange, stop.symbol)
            current_price = prices.get(key)

            trigger_reason = None
            trigger_price = current_price or 0.0

            # Check timeout first (applies to all stops)
            if stop.timeout_at and now >= stop.timeout_at:
                # For native stops, we need to cancel them first
                if stop.native_stop_placed:
                    await self._cancel_native_stops(stop)
                trigger_reason = "timeout"

            # For native stops, exchange handles SL/TP execution
            # We only monitor for timeout
            elif stop.native_stop_placed and not stop.trailing_enabled:
                # Check if position was closed by exchange (native stop triggered)
                position_closed = await self._check_position_closed(stop)
                if position_closed:
                    # Mark as triggered by exchange
                    trigger_reason = "native_stop"
                    # Get last trade price if available
                    trigger_price = await self._get_last_fill_price(stop) or current_price or 0.0
                continue

            # For non-native stops, check price levels
            elif current_price:
                # Check stop-loss
                if self._is_stop_hit(stop, current_price):
                    trigger_reason = "stop_loss"

                # Check take-profit
                elif stop.take_profit_price and self._is_tp_hit(stop, current_price):
                    trigger_reason = "take_profit"

                # Update trailing stop if enabled and price favorable
                elif stop.trailing_enabled:
                    await self._maybe_update_trailing(stop, current_price)

            if trigger_reason:
                result = await self._trigger_stop(stop, trigger_reason, trigger_price)
                triggered.append(result)

        return triggered

    async def _cancel_native_stops(self, stop: StopConfig) -> None:
        """Cancel native stop orders on exchange (e.g., before timeout close)."""
        exchange_manager = get_exchange_manager()

        try:
            exchange_type = ExchangeType(stop.exchange)
            exchange_adapter = exchange_manager.get_exchange(exchange_type)

            if exchange_adapter and exchange_adapter.is_connected:
                formatted_symbol = exchange_adapter.format_symbol(stop.symbol)
                cancelled = await exchange_adapter.cancel_stop_orders(formatted_symbol)
                if cancelled > 0:
                    print(
                        f"[stop_manager] Cancelled {cancelled} native stops for "
                        f"{stop.symbol} on {stop.exchange}"
                    )
        except Exception as e:
            print(f"[stop_manager] Failed to cancel native stops: {e}")

    async def _check_position_closed(self, stop: StopConfig) -> bool:
        """Check if position was closed (e.g., by native stop on exchange)."""
        exchange_manager = get_exchange_manager()

        try:
            exchange_type = ExchangeType(stop.exchange)
            exchange_adapter = exchange_manager.get_exchange(exchange_type)

            if exchange_adapter and exchange_adapter.is_connected:
                formatted_symbol = exchange_adapter.format_symbol(stop.symbol)
                position = await exchange_adapter.get_position(formatted_symbol)
                # Position is closed if it doesn't exist or has zero size
                return position is None or position.size == 0

        except Exception as e:
            print(f"[stop_manager] Failed to check position: {e}")

        return False

    async def _get_last_fill_price(self, stop: StopConfig) -> Optional[float]:
        """Get the last fill price for a position (for native stop reporting)."""
        # This would require order history API - for now return None
        # and let the caller use current price
        return None

    async def _get_price_for_stop(
        self,
        stop: StopConfig,
        exchange_manager,
    ) -> Optional[float]:
        """
        Get price for a stop from the correct exchange.

        Args:
            stop: Stop config with exchange info
            exchange_manager: ExchangeManager instance

        Returns:
            Current price or None
        """
        # Try ExchangeManager first
        try:
            exchange_type = ExchangeType(stop.exchange)
            exchange = exchange_manager.get_exchange(exchange_type)
            if exchange and exchange.is_connected:
                formatted_symbol = exchange.format_symbol(stop.symbol)
                price = await exchange.get_market_price(formatted_symbol)
                if price:
                    return price
        except (ValueError, Exception) as e:
            # Exchange type not recognized or API error - fall through
            pass

        # Fall back to legacy Hyperliquid API
        try:
            hl_exchange = get_hl_exchange()
            return await hl_exchange.get_mid_price(stop.symbol)
        except Exception:
            return None

    def _is_stop_hit(self, stop: StopConfig, current_price: float) -> bool:
        """Check if stop-loss is hit."""
        if stop.direction == "long":
            return current_price <= stop.stop_price
        else:
            return current_price >= stop.stop_price

    def _is_tp_hit(self, stop: StopConfig, current_price: float) -> bool:
        """Check if take-profit is hit."""
        if not stop.take_profit_price:
            return False
        if stop.direction == "long":
            return current_price >= stop.take_profit_price
        else:
            return current_price <= stop.take_profit_price

    async def _maybe_update_trailing(
        self, stop: StopConfig, current_price: float
    ) -> None:
        """Update trailing stop if price has moved favorably."""
        # Calculate new stop based on current price
        new_stop = self._calculate_stop_price(
            current_price, stop.direction, stop.trail_distance_pct
        )

        # Only move stop in favorable direction
        should_update = False
        if stop.direction == "long" and new_stop > stop.stop_price:
            should_update = True
        elif stop.direction == "short" and new_stop < stop.stop_price:
            should_update = True

        if should_update:
            try:
                async with self.db.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE active_stops
                        SET stop_price = $1
                        WHERE decision_id = $2 AND symbol = $3 AND status = 'active'
                        """,
                        new_stop,
                        stop.decision_id,
                        stop.symbol,
                    )
                print(
                    f"[stop_manager] Trailing stop updated: "
                    f"{stop.symbol} {stop.direction} {stop.stop_price:.2f} -> {new_stop:.2f}"
                )
            except Exception as e:
                print(f"[stop_manager] Failed to update trailing stop: {e}")

    async def _trigger_stop(
        self,
        stop: StopConfig,
        reason: str,
        trigger_price: float,
    ) -> StopTriggerResult:
        """Execute stop trigger and close position on correct exchange."""
        print(
            f"[stop_manager] STOP TRIGGERED: {stop.symbol} {stop.direction} on {stop.exchange} "
            f"reason={reason} price=${trigger_price:.2f}"
        )

        # Close the position on the correct exchange
        order_result = await self._close_position_on_exchange(stop)

        # Update database
        try:
            async with self.db.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE active_stops
                    SET status = 'triggered',
                        triggered_at = NOW(),
                        triggered_price = $1,
                        triggered_reason = $2
                    WHERE decision_id = $3 AND symbol = $4
                    """,
                    trigger_price,
                    reason,
                    stop.decision_id,
                    stop.symbol,
                )
        except Exception as e:
            print(f"[stop_manager] Failed to update triggered stop: {e}")

        return StopTriggerResult(
            decision_id=stop.decision_id,
            trigger_reason=reason,
            trigger_price=trigger_price,
            order_result=order_result,
        )

    async def _close_position_on_exchange(
        self,
        stop: StopConfig,
    ) -> Optional[OrderResult]:
        """
        Close position on the correct exchange.

        Uses ExchangeManager for multi-exchange support.
        Falls back to legacy Hyperliquid API if exchange not connected.

        Args:
            stop: Stop config with exchange info

        Returns:
            OrderResult or None
        """
        exchange_manager = get_exchange_manager()

        # Try ExchangeManager first
        try:
            exchange_type = ExchangeType(stop.exchange)
            exchange = exchange_manager.get_exchange(exchange_type)
            if exchange and exchange.is_connected:
                formatted_symbol = exchange.format_symbol(stop.symbol)
                result = await exchange.close_position(formatted_symbol)
                # Convert ExchangeOrderResult to legacy OrderResult format
                return OrderResult(
                    success=result.success,
                    order_id=result.order_id,
                    fill_price=result.fill_price,
                    fill_size=result.fill_size,
                    slippage_actual=result.slippage_actual,
                    error=result.error,
                )
        except (ValueError, Exception) as e:
            print(f"[stop_manager] ExchangeManager close failed, trying legacy: {e}")

        # Fall back to legacy Hyperliquid API
        try:
            hl_exchange = get_hl_exchange()
            return await hl_exchange.close_position(stop.symbol)
        except Exception as e:
            print(f"[stop_manager] Legacy close failed: {e}")
            return None

    async def cancel_stop(self, decision_id: str, symbol: str) -> bool:
        """
        Cancel an active stop (e.g., when position manually closed).

        Args:
            decision_id: Decision ID
            symbol: Asset symbol

        Returns:
            True if cancelled
        """
        try:
            async with self.db.acquire() as conn:
                result = await conn.execute(
                    """
                    UPDATE active_stops
                    SET status = 'cancelled'
                    WHERE decision_id = $1 AND symbol = $2 AND status = 'active'
                    """,
                    decision_id,
                    symbol,
                )
                return "UPDATE 1" in result
        except Exception as e:
            print(f"[stop_manager] Failed to cancel stop: {e}")
            return False

    async def run_loop(self) -> None:
        """
        Main monitoring loop.

        Runs continuously, checking stops at regular intervals.
        """
        self._running = True
        print(f"[stop_manager] Starting with {self._poll_interval}s poll interval")

        while self._running:
            try:
                triggered = await self.check_stops()
                if triggered:
                    print(f"[stop_manager] {len(triggered)} stops triggered")
            except Exception as e:
                print(f"[stop_manager] Error in check loop: {e}")

            await asyncio.sleep(self._poll_interval)

    def stop(self) -> None:
        """Stop the monitoring loop."""
        self._running = False
        print("[stop_manager] Stopping...")


# Global stop manager instance
_stop_manager: Optional[StopManager] = None


def get_stop_manager(db: asyncpg.Pool) -> StopManager:
    """Get or create global stop manager instance."""
    global _stop_manager
    if _stop_manager is None:
        _stop_manager = StopManager(db)
    return _stop_manager
