"""
Tests for Native Stop Order Support (Phase 6.2)

Tests the execution resilience improvements:
- Native stop order placement on exchanges
- Cancel stop orders functionality
- StopManager native vs polling mode selection
"""

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from app.exchanges.interface import (
    ExchangeInterface,
    ExchangeConfig,
    ExchangeType,
    OrderResult,
    Position,
    PositionSide,
)
from app.exchanges.hyperliquid_adapter import HyperliquidAdapter
from app.exchanges.bybit_adapter import BybitAdapter
from app.exchanges.aster_adapter import AsterAdapter
from app.stop_manager import (
    StopManager,
    StopConfig,
    USE_NATIVE_STOPS,
)


# =============================================================================
# Test Exchange Interface Native Stop Support
# =============================================================================


class TestExchangeInterfaceNativeStops:
    """Tests for ExchangeInterface native stop methods."""

    def test_interface_has_supports_native_stops_property(self):
        """Interface has supports_native_stops property."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            testnet=True,
        )

        # Create a concrete implementation for testing
        class TestAdapter(ExchangeInterface):
            @property
            def is_configured(self) -> bool:
                return True

            async def connect(self) -> bool:
                return True

            async def disconnect(self) -> None:
                pass

            async def get_balance(self):
                return None

            async def get_positions(self):
                return []

            async def get_position(self, symbol: str):
                return None

            async def open_position(self, params):
                return OrderResult(success=False)

            async def close_position(self, symbol, size=None):
                return OrderResult(success=False)

            async def place_order(self, params):
                return OrderResult(success=False)

            async def get_order_status(self, order_id):
                return None

            async def cancel_order(self, symbol, order_id):
                return False

            async def cancel_all_orders(self, symbol=None):
                return 0

            async def set_leverage(self, symbol, leverage):
                return True

            async def set_stop_loss(self, symbol, stop_price, size=None):
                return OrderResult(success=True)

            async def set_take_profit(self, symbol, take_profit_price, size=None):
                return OrderResult(success=True)

            async def cancel_stop_orders(self, symbol):
                return 0

            async def get_market_price(self, symbol):
                return 100000.0

            async def get_market_data(self, symbol):
                return None

            def format_symbol(self, symbol):
                return symbol

            def format_quantity(self, symbol, quantity):
                return quantity

            def format_price(self, symbol, price):
                return price

        adapter = TestAdapter(config)
        assert adapter.supports_native_stops is True

    @pytest.mark.asyncio
    async def test_set_stop_loss_take_profit_combined(self):
        """Combined SL/TP method calls individual methods."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            testnet=True,
        )

        class TestAdapter(ExchangeInterface):
            def __init__(self, config):
                super().__init__(config)
                self.sl_called = False
                self.tp_called = False

            @property
            def is_configured(self) -> bool:
                return True

            async def connect(self) -> bool:
                return True

            async def disconnect(self) -> None:
                pass

            async def get_balance(self):
                return None

            async def get_positions(self):
                return []

            async def get_position(self, symbol: str):
                return Position(
                    symbol=symbol,
                    side=PositionSide.LONG,
                    size=0.1,
                    entry_price=100000,
                    mark_price=100000,
                )

            async def open_position(self, params):
                return OrderResult(success=False)

            async def close_position(self, symbol, size=None):
                return OrderResult(success=False)

            async def place_order(self, params):
                return OrderResult(success=False)

            async def get_order_status(self, order_id):
                return None

            async def cancel_order(self, symbol, order_id):
                return False

            async def cancel_all_orders(self, symbol=None):
                return 0

            async def set_leverage(self, symbol, leverage):
                return True

            async def set_stop_loss(self, symbol, stop_price, size=None):
                self.sl_called = True
                return OrderResult(success=True, order_id="sl_123")

            async def set_take_profit(self, symbol, take_profit_price, size=None):
                self.tp_called = True
                return OrderResult(success=True, order_id="tp_456")

            async def cancel_stop_orders(self, symbol):
                return 2

            async def get_market_price(self, symbol):
                return 100000.0

            async def get_market_data(self, symbol):
                return None

            def format_symbol(self, symbol):
                return symbol

            def format_quantity(self, symbol, quantity):
                return quantity

            def format_price(self, symbol, price):
                return price

        adapter = TestAdapter(config)

        sl_result, tp_result = await adapter.set_stop_loss_take_profit(
            symbol="BTC",
            stop_price=99000.0,
            take_profit_price=102000.0,
            size=0.1,
        )

        assert adapter.sl_called is True
        assert adapter.tp_called is True
        assert sl_result.success is True
        assert tp_result.success is True


# =============================================================================
# Test StopConfig Native Stop Fields
# =============================================================================


class TestStopConfigNativeFields:
    """Tests for StopConfig native stop tracking."""

    def test_stop_config_has_native_stop_placed_field(self):
        """StopConfig has native_stop_placed field."""
        config = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=datetime.now(timezone.utc) + timedelta(hours=24),
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        assert config.native_stop_placed is True

    def test_stop_config_native_stop_defaults_false(self):
        """StopConfig native_stop_placed defaults to False."""
        config = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=datetime.now(timezone.utc) + timedelta(hours=24),
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
        )

        assert config.native_stop_placed is False


# =============================================================================
# Test StopManager Native Stop Placement
# =============================================================================


class TestStopManagerNativeStops:
    """Tests for StopManager native stop functionality."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database pool."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        mock_conn.execute = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        return mock_pool

    @pytest.mark.asyncio
    async def test_register_stop_attempts_native_stops(self, mock_db):
        """Register stop attempts to place native stops when enabled."""
        manager = StopManager(mock_db)

        # Mock exchange manager
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.supports_native_stops = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.set_stop_loss_take_profit.return_value = (
            OrderResult(success=True, order_id="sl_123"),
            OrderResult(success=True, order_id="tp_456"),
        )

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        # Patch _place_native_stops directly to simulate successful native stop placement
        with patch.object(manager, "_place_native_stops", return_value=True) as mock_place:
            config = await manager.register_stop(
                decision_id="test-123",
                symbol="BTC",
                direction="long",
                entry_price=100000.0,
                entry_size=0.1,
                stop_distance_pct=0.01,
                take_profit_rr=2.0,
                trailing_enabled=False,
                exchange="hyperliquid",
            )

        # Should have attempted to place native stops
        mock_place.assert_called_once()
        assert config.native_stop_placed is True

    @pytest.mark.asyncio
    async def test_register_stop_skips_native_for_trailing(self, mock_db):
        """Register stop skips native stops for trailing stops."""
        manager = StopManager(mock_db)

        # Mock _place_native_stops to verify it's not called
        with patch.object(manager, "_place_native_stops") as mock_place:
            config = await manager.register_stop(
                decision_id="test-123",
                symbol="BTC",
                direction="long",
                entry_price=100000.0,
                entry_size=0.1,
                stop_distance_pct=0.01,
                trailing_enabled=True,  # Trailing enabled
                exchange="hyperliquid",
            )

        # Should NOT have called _place_native_stops (trailing requires polling)
        mock_place.assert_not_called()
        assert config.native_stop_placed is False

    @pytest.mark.asyncio
    async def test_register_stop_falls_back_on_failure(self, mock_db):
        """Register stop falls back to polling if native stops fail."""
        manager = StopManager(mock_db)

        # Patch _place_native_stops to return False (simulating failure)
        with patch.object(manager, "_place_native_stops", return_value=False):
            config = await manager.register_stop(
                decision_id="test-123",
                symbol="BTC",
                direction="long",
                entry_price=100000.0,
                entry_size=0.1,
                stop_distance_pct=0.01,
                trailing_enabled=False,
                exchange="hyperliquid",
            )

        # Should fall back to polling
        assert config.native_stop_placed is False

    @pytest.mark.asyncio
    async def test_place_native_stops_success(self, mock_db):
        """_place_native_stops successfully places stops on exchange."""
        manager = StopManager(mock_db)

        # Mock exchange manager
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.supports_native_stops = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.set_stop_loss_take_profit.return_value = (
            OrderResult(success=True, order_id="sl_123"),
            OrderResult(success=True, order_id="tp_456"),
        )

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._place_native_stops(
                symbol="BTC",
                stop_price=99000.0,
                take_profit_price=102000.0,
                entry_size=0.1,
                exchange="hyperliquid",
            )

        assert result is True
        mock_exchange.set_stop_loss_take_profit.assert_called_once()

    @pytest.mark.asyncio
    async def test_place_native_stops_exchange_not_connected(self, mock_db):
        """_place_native_stops returns False when exchange not connected."""
        manager = StopManager(mock_db)

        mock_exchange = AsyncMock()
        mock_exchange.is_connected = False  # Not connected

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._place_native_stops(
                symbol="BTC",
                stop_price=99000.0,
                take_profit_price=102000.0,
                entry_size=0.1,
                exchange="hyperliquid",
            )

        assert result is False


# =============================================================================
# Test Cancel Stop Orders
# =============================================================================


class TestCancelStopOrders:
    """Tests for cancel_stop_orders in adapters."""

    @pytest.mark.asyncio
    async def test_hyperliquid_cancel_stop_orders_not_connected(self):
        """Hyperliquid returns 0 when not connected."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            testnet=True,
        )
        adapter = HyperliquidAdapter(config)
        # Not connected
        result = await adapter.cancel_stop_orders("BTC")
        assert result == 0

    @pytest.mark.asyncio
    async def test_bybit_cancel_stop_orders_not_connected(self):
        """Bybit returns 0 when not connected."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            testnet=True,
        )
        adapter = BybitAdapter(config)
        # Not connected
        result = await adapter.cancel_stop_orders("BTCUSDT")
        assert result == 0

    @pytest.mark.asyncio
    async def test_aster_cancel_stop_orders_not_connected(self):
        """Aster returns 0 when not connected."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.ASTER,
            testnet=True,
        )
        adapter = AsterAdapter(config)
        # Not connected
        result = await adapter.cancel_stop_orders("BTC-PERP")
        assert result == 0


# =============================================================================
# Test check_stops with Native Stops
# =============================================================================


class TestCheckStopsNativeMode:
    """Tests for check_stops behavior with native stops."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database pool."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        mock_conn.execute = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        return mock_pool

    @pytest.mark.asyncio
    async def test_check_stops_skips_price_polling_for_native(self, mock_db):
        """check_stops skips price polling for native stop positions."""
        manager = StopManager(mock_db)

        # Create a native stop config
        native_stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=datetime.now(timezone.utc) + timedelta(hours=24),
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,  # Native stop placed
        )

        # Mock get_active_stops to return our config
        mock_db.acquire.return_value.__aenter__.return_value.fetch.return_value = []

        with patch.object(manager, "get_active_stops", return_value=[native_stop]):
            with patch.object(manager, "_get_price_for_stop") as mock_get_price:
                with patch.object(manager, "_check_position_closed", return_value=False):
                    await manager.check_stops()

                    # Price should NOT be fetched for native stops
                    mock_get_price.assert_not_called()

    @pytest.mark.asyncio
    async def test_check_stops_monitors_timeout_for_native(self, mock_db):
        """check_stops monitors timeout even for native stops."""
        manager = StopManager(mock_db)

        # Create a native stop config that has timed out
        native_stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=datetime.now(timezone.utc) - timedelta(hours=1),  # Already timed out
            created_at=datetime.now(timezone.utc) - timedelta(hours=2),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        with patch.object(manager, "get_active_stops", return_value=[native_stop]):
            with patch.object(manager, "_cancel_native_stops") as mock_cancel:
                with patch.object(manager, "_trigger_stop", return_value=MagicMock()) as mock_trigger:
                    await manager.check_stops()

                    # Should cancel native stops before closing
                    mock_cancel.assert_called_once_with(native_stop)
                    # Should trigger timeout
                    mock_trigger.assert_called_once()
                    _, kwargs = mock_trigger.call_args
                    assert mock_trigger.call_args[0][1] == "timeout"


# =============================================================================
# Test USE_NATIVE_STOPS Configuration
# =============================================================================


class TestNativeStopsConfiguration:
    """Tests for USE_NATIVE_STOPS configuration."""

    def test_use_native_stops_env_var_parsing(self):
        """USE_NATIVE_STOPS parses from environment variable."""
        import os
        from importlib import reload

        # Test true
        with patch.dict(os.environ, {"USE_NATIVE_STOPS": "true"}):
            import app.stop_manager as sm
            reload(sm)
            assert sm.USE_NATIVE_STOPS is True

        # Test false
        with patch.dict(os.environ, {"USE_NATIVE_STOPS": "false"}):
            reload(sm)
            assert sm.USE_NATIVE_STOPS is False

        # Restore default
        with patch.dict(os.environ, {"USE_NATIVE_STOPS": "true"}):
            reload(sm)


# =============================================================================
# Test Exchange Adapter Native Stop Implementations
# =============================================================================


class TestHyperliquidAdapterNativeStops:
    """Tests for HyperliquidAdapter native stop implementation."""

    @pytest.mark.asyncio
    async def test_cancel_stop_orders_filters_by_symbol(self):
        """cancel_stop_orders only cancels orders for specified symbol."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            testnet=True,
        )
        adapter = HyperliquidAdapter(config)

        # Mock exchange and info
        adapter._exchange = MagicMock()
        adapter._info = MagicMock()
        adapter._connected = True

        # Mock _get_account_address to return a valid address
        adapter._get_account_address = MagicMock(return_value="0x1234567890abcdef")

        # Mock open orders with different symbols and types
        adapter._info.open_orders.return_value = [
            {"coin": "BTC", "orderType": "Stop Market", "oid": "123"},
            {"coin": "BTC", "orderType": "Take Profit Market", "oid": "456"},
            {"coin": "ETH", "orderType": "Stop Market", "oid": "789"},
            {"coin": "BTC", "orderType": "Limit", "oid": "101"},  # Not a stop order
        ]

        # Mock cancel_order to track calls
        cancel_calls = []

        async def mock_cancel(symbol, oid):
            cancel_calls.append((symbol, oid))
            return True

        adapter.cancel_order = mock_cancel

        # Cancel BTC stops
        result = await adapter.cancel_stop_orders("BTC")

        # Should have cancelled 2 BTC stop orders
        assert result == 2
        assert len(cancel_calls) == 2
        assert ("BTC", "123") in cancel_calls
        assert ("BTC", "456") in cancel_calls
        # ETH order should NOT be cancelled
        assert ("ETH", "789") not in cancel_calls


class TestBybitAdapterNativeStops:
    """Tests for BybitAdapter native stop implementation."""

    @pytest.mark.asyncio
    async def test_cancel_stop_orders_calls_set_trading_stop(self):
        """cancel_stop_orders uses set_trading_stop with 0 values."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            testnet=True,
        )
        adapter = BybitAdapter(config)

        # Mock client
        adapter._client = MagicMock()
        adapter._connected = True
        adapter._client.set_trading_stop.return_value = {"retCode": 0}

        result = await adapter.cancel_stop_orders("BTCUSDT")

        # Should call set_trading_stop with 0 values
        adapter._client.set_trading_stop.assert_called_once()
        call_kwargs = adapter._client.set_trading_stop.call_args[1]
        assert call_kwargs["stopLoss"] == "0"
        assert call_kwargs["takeProfit"] == "0"
        assert result == 2  # Cleared both SL and TP

    @pytest.mark.asyncio
    async def test_cancel_stop_orders_handles_no_stops(self):
        """cancel_stop_orders handles case where no stops exist."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            testnet=True,
        )
        adapter = BybitAdapter(config)

        # Mock client to return "no stops to cancel" error
        adapter._client = MagicMock()
        adapter._connected = True
        adapter._client.set_trading_stop.return_value = {
            "retCode": 110020,  # No trading stop to cancel
            "retMsg": "No trading stop to cancel",
        }

        result = await adapter.cancel_stop_orders("BTCUSDT")

        assert result == 0  # No stops to cancel


class TestAsterAdapterNativeStops:
    """Tests for AsterAdapter native stop implementation."""

    @pytest.mark.asyncio
    async def test_cancel_stop_orders_calls_cancel_all(self):
        """cancel_stop_orders uses conditional-orders/cancel-all endpoint."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.ASTER,
            testnet=True,
        )
        adapter = AsterAdapter(config)

        # Mock signed request
        adapter._signed_request = AsyncMock(return_value={
            "data": {"cancelledCount": 3}
        })
        adapter._connected = True

        result = await adapter.cancel_stop_orders("BTC-PERP")

        # Should call cancel-all endpoint
        adapter._signed_request.assert_called_once_with(
            "POST",
            "/v1/private/conditional-orders/cancel-all",
            {"symbol": "BTC-PERP"},
        )
        assert result == 3


# =============================================================================
# Test StopManager Cancel Native Stops
# =============================================================================


class TestStopManagerCancelNativeStops:
    """Tests for StopManager._cancel_native_stops()."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database pool."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        mock_conn.execute = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        return mock_pool

    @pytest.mark.asyncio
    async def test_cancel_native_stops_success(self, mock_db):
        """_cancel_native_stops cancels orders on exchange."""
        manager = StopManager(mock_db)

        stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=datetime.now(timezone.utc) + timedelta(hours=24),
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        # Mock exchange - use MagicMock base with async methods explicitly set
        mock_exchange = MagicMock()
        mock_exchange.is_connected = True
        mock_exchange.format_symbol.return_value = "BTC"  # Sync method
        mock_exchange.cancel_stop_orders = AsyncMock(return_value=2)  # Async method

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            await manager._cancel_native_stops(stop)

        mock_exchange.cancel_stop_orders.assert_called_once_with("BTC")

    @pytest.mark.asyncio
    async def test_cancel_native_stops_handles_exchange_error(self, mock_db):
        """_cancel_native_stops handles exchange errors gracefully."""
        manager = StopManager(mock_db)

        stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=None,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=None,
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        # Mock exchange manager to raise exception
        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.side_effect = Exception("Connection failed")

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            # Should not raise exception
            await manager._cancel_native_stops(stop)


# =============================================================================
# Test StopManager Check Position Closed
# =============================================================================


class TestStopManagerCheckPositionClosed:
    """Tests for StopManager._check_position_closed()."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database pool."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        mock_conn.execute = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        return mock_pool

    @pytest.mark.asyncio
    async def test_check_position_closed_returns_true_when_no_position(self, mock_db):
        """_check_position_closed returns True when position doesn't exist."""
        manager = StopManager(mock_db)

        stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=None,
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        # Mock exchange with no position
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.get_position.return_value = None

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._check_position_closed(stop)

        assert result is True

    @pytest.mark.asyncio
    async def test_check_position_closed_returns_true_when_zero_size(self, mock_db):
        """_check_position_closed returns True when position size is 0."""
        manager = StopManager(mock_db)

        stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=None,
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        # Mock exchange with zero-size position
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.get_position.return_value = Position(
            symbol="BTC",
            side=PositionSide.LONG,
            size=0,  # Zero size = closed
            entry_price=100000,
            mark_price=100000,
        )

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._check_position_closed(stop)

        assert result is True

    @pytest.mark.asyncio
    async def test_check_position_closed_returns_false_when_open(self, mock_db):
        """_check_position_closed returns False when position is still open."""
        manager = StopManager(mock_db)

        stop = StopConfig(
            decision_id="test-123",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            entry_size=0.1,
            stop_price=99000.0,
            take_profit_price=102000.0,
            trailing_enabled=False,
            trail_distance_pct=0.01,
            timeout_at=None,
            created_at=datetime.now(timezone.utc),
            exchange="hyperliquid",
            native_stop_placed=True,
        )

        # Mock exchange with open position
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.get_position.return_value = Position(
            symbol="BTC",
            side=PositionSide.LONG,
            size=0.1,  # Still has size
            entry_price=100000,
            mark_price=99500,
        )

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._check_position_closed(stop)

        assert result is False


# =============================================================================
# Test Edge Cases
# =============================================================================


class TestNativeStopsEdgeCases:
    """Tests for edge cases in native stop functionality."""

    @pytest.fixture
    def mock_db(self):
        """Create a mock database pool."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        mock_conn.execute = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        return mock_pool

    @pytest.mark.asyncio
    async def test_native_stops_with_no_take_profit(self, mock_db):
        """Native stops work with only stop-loss (no take-profit)."""
        manager = StopManager(mock_db)

        # Mock exchange manager
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.supports_native_stops = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.set_stop_loss_take_profit.return_value = (
            OrderResult(success=True, order_id="sl_123"),
            OrderResult(success=True, status="skipped"),  # TP skipped
        )

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._place_native_stops(
                symbol="BTC",
                stop_price=99000.0,
                take_profit_price=None,  # No take profit
                entry_size=0.1,
                exchange="hyperliquid",
            )

        assert result is True
        # Should still call the method with None for TP
        mock_exchange.set_stop_loss_take_profit.assert_called_once()

    @pytest.mark.asyncio
    async def test_native_stops_sl_success_tp_failure(self, mock_db):
        """Native stops return True if SL succeeds but TP fails."""
        manager = StopManager(mock_db)

        # Mock exchange manager
        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.supports_native_stops = True
        mock_exchange.format_symbol.return_value = "BTC"
        mock_exchange.set_stop_loss_take_profit.return_value = (
            OrderResult(success=True, order_id="sl_123"),
            OrderResult(success=False, error="Rate limited"),  # TP failed
        )

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._place_native_stops(
                symbol="BTC",
                stop_price=99000.0,
                take_profit_price=102000.0,
                entry_size=0.1,
                exchange="hyperliquid",
            )

        # Should return True since SL was placed successfully
        # TP will be monitored via polling
        assert result is True

    @pytest.mark.asyncio
    async def test_native_stops_invalid_exchange_type(self, mock_db):
        """Native stops handle invalid exchange type gracefully."""
        manager = StopManager(mock_db)

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = None

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._place_native_stops(
                symbol="BTC",
                stop_price=99000.0,
                take_profit_price=102000.0,
                entry_size=0.1,
                exchange="invalid_exchange",
            )

        # Should return False (fall back to polling)
        assert result is False

    @pytest.mark.asyncio
    async def test_native_stops_exchange_not_supporting(self, mock_db):
        """Native stops fall back when exchange doesn't support them."""
        manager = StopManager(mock_db)

        mock_exchange = AsyncMock()
        mock_exchange.is_connected = True
        mock_exchange.supports_native_stops = False  # Exchange doesn't support

        mock_exchange_manager = MagicMock()
        mock_exchange_manager.get_exchange.return_value = mock_exchange

        with patch("app.stop_manager.get_exchange_manager", return_value=mock_exchange_manager):
            result = await manager._place_native_stops(
                symbol="BTC",
                stop_price=99000.0,
                take_profit_price=102000.0,
                entry_size=0.1,
                exchange="hyperliquid",
            )

        assert result is False
