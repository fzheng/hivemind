"""
Tests for Multi-Exchange Integration Module

Tests the abstract interface, factory, and adapter implementations.
Uses mocking to avoid actual API calls.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
import os

from app.exchanges import (
    ExchangeConfig,
    ExchangeInterface,
    ExchangeType,
    OrderParams,
    OrderResult,
    OrderSide,
    OrderType,
    Position,
    PositionSide,
    Balance,
    MarginMode,
    MarketData,
    create_exchange,
    get_exchange,
    list_available_exchanges,
    is_exchange_available,
)


class TestExchangeConfig:
    """Tests for ExchangeConfig dataclass."""

    def test_default_config(self):
        """Test default configuration values."""
        config = ExchangeConfig(exchange_type=ExchangeType.HYPERLIQUID)

        assert config.exchange_type == ExchangeType.HYPERLIQUID
        assert config.testnet is True
        assert config.default_leverage == 1
        assert config.default_margin_mode == MarginMode.CROSS
        assert config.default_slippage_pct == 0.5

    def test_get_credentials_from_env(self):
        """Test credential retrieval from environment."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            private_key_env="TEST_PRIVATE_KEY",
            api_key_env="TEST_API_KEY",
        )

        with patch.dict(os.environ, {"TEST_PRIVATE_KEY": "secret123"}):
            assert config.get_private_key() == "secret123"

        # Missing env var returns None
        assert config.get_api_key() is None

    def test_empty_env_names(self):
        """Test empty environment variable names return None."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            private_key_env="",
            api_key_env="",
        )

        assert config.get_private_key() is None
        assert config.get_api_key() is None


class TestOrderParams:
    """Tests for OrderParams dataclass."""

    def test_market_order(self):
        """Test market order parameters."""
        params = OrderParams(
            symbol="BTC",
            side=OrderSide.BUY,
            size=0.1,
        )

        assert params.symbol == "BTC"
        assert params.side == OrderSide.BUY
        assert params.size == 0.1
        assert params.order_type == OrderType.MARKET
        assert params.price is None
        assert params.reduce_only is False

    def test_limit_order_with_stops(self):
        """Test limit order with stop loss and take profit."""
        params = OrderParams(
            symbol="ETH",
            side=OrderSide.SELL,
            size=1.0,
            order_type=OrderType.LIMIT,
            price=2500.0,
            stop_loss=2400.0,
            take_profit=2700.0,
            leverage=5,
        )

        assert params.order_type == OrderType.LIMIT
        assert params.price == 2500.0
        assert params.stop_loss == 2400.0
        assert params.take_profit == 2700.0
        assert params.leverage == 5


class TestPosition:
    """Tests for Position dataclass."""

    def test_long_position(self):
        """Test long position properties."""
        pos = Position(
            symbol="BTCUSDT",
            side=PositionSide.LONG,
            size=0.5,
            entry_price=50000.0,
            mark_price=51000.0,
            leverage=10,
        )

        assert pos.is_long is True
        assert pos.is_short is False
        assert pos.notional_value == 0.5 * 51000.0

    def test_short_position(self):
        """Test short position properties."""
        pos = Position(
            symbol="ETHUSDT",
            side=PositionSide.SHORT,
            size=-2.0,
            entry_price=3000.0,
            mark_price=2900.0,
        )

        assert pos.is_long is False
        assert pos.is_short is True
        assert pos.notional_value == 2.0 * 2900.0


class TestBalance:
    """Tests for Balance dataclass."""

    def test_margin_ratio(self):
        """Test margin ratio calculation."""
        balance = Balance(
            total_equity=10000.0,
            available_balance=8000.0,
            margin_used=2000.0,
        )

        assert balance.margin_ratio == 0.2  # 2000/10000

    def test_zero_equity(self):
        """Test margin ratio with zero equity."""
        balance = Balance(
            total_equity=0.0,
            available_balance=0.0,
            margin_used=0.0,
        )

        assert balance.margin_ratio == 0.0


class TestMarketData:
    """Tests for MarketData dataclass."""

    def test_market_data_properties(self):
        """Test market data calculated properties."""
        data = MarketData(
            symbol="BTCUSDT",
            bid=50000.0,
            ask=50010.0,
            last=50005.0,
            mark_price=50005.0,
        )

        assert data.mid_price == 50005.0
        assert data.spread == 10.0
        assert data.spread_pct == pytest.approx(0.02, rel=0.01)


class TestFactory:
    """Tests for exchange factory functions."""

    def test_list_available_exchanges(self):
        """Test listing available exchanges."""
        exchanges = list_available_exchanges()

        # All three adapters should be available
        assert "hyperliquid" in exchanges
        assert "aster" in exchanges
        assert "bybit" in exchanges

    def test_is_exchange_available(self):
        """Test checking exchange availability."""
        assert is_exchange_available(ExchangeType.HYPERLIQUID) is True
        assert is_exchange_available(ExchangeType.ASTER) is True
        assert is_exchange_available(ExchangeType.BYBIT) is True

    def test_create_exchange_hyperliquid(self):
        """Test creating Hyperliquid adapter."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            testnet=True,
        )

        exchange = create_exchange(config)

        assert exchange is not None
        assert exchange.exchange_type == ExchangeType.HYPERLIQUID
        assert exchange.is_connected is False

    def test_create_exchange_aster(self):
        """Test creating Aster adapter."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.ASTER,
            testnet=True,
        )

        exchange = create_exchange(config)

        assert exchange is not None
        assert exchange.exchange_type == ExchangeType.ASTER

    def test_create_exchange_bybit(self):
        """Test creating Bybit adapter."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            testnet=True,
        )

        exchange = create_exchange(config)

        assert exchange is not None
        assert exchange.exchange_type == ExchangeType.BYBIT

    def test_get_exchange_with_defaults(self):
        """Test get_exchange uses correct default env vars."""
        exchange = get_exchange(ExchangeType.HYPERLIQUID, testnet=True)

        # Check default env var names were set
        assert exchange.config.private_key_env == "HL_PRIVATE_KEY"
        assert exchange.config.account_address_env == "HL_ACCOUNT_ADDRESS"


class TestHyperliquidAdapter:
    """Tests for Hyperliquid adapter."""

    def test_format_symbol(self):
        """Test symbol formatting - Hyperliquid just uppercases."""
        config = ExchangeConfig(exchange_type=ExchangeType.HYPERLIQUID)
        from app.exchanges.hyperliquid_adapter import HyperliquidAdapter

        adapter = HyperliquidAdapter(config)

        # Hyperliquid uses simple uppercase symbols
        assert adapter.format_symbol("BTC") == "BTC"
        assert adapter.format_symbol("btc") == "BTC"
        assert adapter.format_symbol("eth") == "ETH"

    def test_format_quantity(self):
        """Test quantity formatting - uses cached precision or default 3."""
        config = ExchangeConfig(exchange_type=ExchangeType.HYPERLIQUID)
        from app.exchanges.hyperliquid_adapter import HyperliquidAdapter

        adapter = HyperliquidAdapter(config)

        # Without cache, uses default sz_decimals=3
        assert adapter.format_quantity("BTC", 0.123456) == 0.123
        assert adapter.format_quantity("ETH", 1.23456) == 1.234

    def test_is_not_configured_without_key(self):
        """Test is_configured returns False without credentials."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            private_key_env="NONEXISTENT_KEY",
        )
        from app.exchanges.hyperliquid_adapter import HyperliquidAdapter

        adapter = HyperliquidAdapter(config)

        assert adapter.is_configured is False


class TestAsterAdapter:
    """Tests for Aster adapter."""

    def test_format_symbol(self):
        """Test symbol formatting adds -PERP suffix."""
        config = ExchangeConfig(exchange_type=ExchangeType.ASTER)
        from app.exchanges.aster_adapter import AsterAdapter

        adapter = AsterAdapter(config)

        # Aster appends -PERP if not present
        assert adapter.format_symbol("BTC") == "BTC-PERP"
        assert adapter.format_symbol("btc") == "BTC-PERP"
        assert adapter.format_symbol("BTC-PERP") == "BTC-PERP"
        assert adapter.format_symbol("ETH") == "ETH-PERP"

    def test_format_quantity(self):
        """Test quantity formatting - uses cached precision or default 4."""
        config = ExchangeConfig(exchange_type=ExchangeType.ASTER)
        from app.exchanges.aster_adapter import AsterAdapter

        adapter = AsterAdapter(config)

        # Without cache, uses default size_precision=4
        assert adapter.format_quantity("BTC", 0.123456) == 0.1234
        assert adapter.format_quantity("ETH", 1.234567) == 1.2345


class TestBybitAdapter:
    """Tests for Bybit adapter."""

    def test_format_symbol(self):
        """Test symbol formatting to USDT format."""
        config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        assert adapter.format_symbol("BTC") == "BTCUSDT"
        assert adapter.format_symbol("btc") == "BTCUSDT"
        assert adapter.format_symbol("BTC-PERP") == "BTCUSDT"
        assert adapter.format_symbol("BTCUSDT") == "BTCUSDT"
        assert adapter.format_symbol("ETH") == "ETHUSDT"

    def test_format_quantity(self):
        """Test quantity formatting."""
        config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        # BTCUSDT has 3 decimals
        assert adapter.format_quantity("BTC", 0.1234567) == 0.123

        # ETHUSDT has 2 decimals
        assert adapter.format_quantity("ETH", 1.23456) == 1.23

    def test_format_price(self):
        """Test price formatting."""
        config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        # BTCUSDT has 1 decimal for price
        assert adapter.format_price("BTC", 50000.123) == 50000.1

        # ETHUSDT has 2 decimals for price
        assert adapter.format_price("ETH", 3000.1234) == 3000.12

    def test_is_not_configured_without_credentials(self):
        """Test is_configured returns False without credentials."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            api_key_env="NONEXISTENT_KEY",
            api_secret_env="NONEXISTENT_SECRET",
        )
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        assert adapter.is_configured is False


class TestExchangeIntegration:
    """Integration tests for exchange adapters (mocked)."""

    @pytest.mark.asyncio
    async def test_hyperliquid_connect_without_creds(self):
        """Test Hyperliquid connection fails without credentials."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.HYPERLIQUID,
            private_key_env="NONEXISTENT",
        )
        from app.exchanges.hyperliquid_adapter import HyperliquidAdapter

        adapter = HyperliquidAdapter(config)
        result = await adapter.connect()

        assert result is False
        assert adapter.is_connected is False

    @pytest.mark.asyncio
    async def test_bybit_connect_without_creds(self):
        """Test Bybit connection fails without credentials."""
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            api_key_env="NONEXISTENT",
            api_secret_env="NONEXISTENT",
        )
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)
        result = await adapter.connect()

        assert result is False
        assert adapter.is_connected is False

    @pytest.mark.asyncio
    async def test_get_balance_not_connected(self):
        """Test get_balance returns None when not connected."""
        config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        balance = await adapter.get_balance()
        assert balance is None

    @pytest.mark.asyncio
    async def test_get_positions_not_connected(self):
        """Test get_positions returns empty list when not connected."""
        config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        positions = await adapter.get_positions()
        assert positions == []

    @pytest.mark.asyncio
    async def test_place_order_not_connected(self):
        """Test place_order fails when not connected."""
        config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        from app.exchanges.bybit_adapter import BybitAdapter

        adapter = BybitAdapter(config)

        result = await adapter.place_order(
            OrderParams(symbol="BTC", side=OrderSide.BUY, size=0.01)
        )

        assert result.success is False
        assert "Not connected" in result.error


class TestOrderResult:
    """Tests for OrderResult dataclass."""

    def test_successful_order(self):
        """Test successful order result."""
        result = OrderResult(
            success=True,
            order_id="12345",
            fill_price=50000.0,
            fill_size=0.1,
            filled_pct=100.0,
            status="filled",
            fees=5.0,
        )

        assert result.success is True
        assert result.order_id == "12345"
        assert result.error is None

    def test_failed_order(self):
        """Test failed order result."""
        result = OrderResult(
            success=False,
            error="Insufficient balance",
            status="rejected",
        )

        assert result.success is False
        assert result.error == "Insufficient balance"


class TestExchangeTypeValidation:
    """Tests for exchange type validation."""

    def test_bybit_adapter_rejects_wrong_type(self):
        """Test Bybit adapter rejects wrong exchange type."""
        config = ExchangeConfig(exchange_type=ExchangeType.HYPERLIQUID)

        with pytest.raises(ValueError, match="Invalid exchange type"):
            from app.exchanges.bybit_adapter import BybitAdapter

            BybitAdapter(config)

    def test_exchange_type_property(self):
        """Test exchange_type property returns correct type."""
        from app.exchanges.hyperliquid_adapter import HyperliquidAdapter
        from app.exchanges.aster_adapter import AsterAdapter
        from app.exchanges.bybit_adapter import BybitAdapter

        hl_config = ExchangeConfig(exchange_type=ExchangeType.HYPERLIQUID)
        assert HyperliquidAdapter(hl_config).exchange_type == ExchangeType.HYPERLIQUID

        aster_config = ExchangeConfig(exchange_type=ExchangeType.ASTER)
        assert AsterAdapter(aster_config).exchange_type == ExchangeType.ASTER

        bybit_config = ExchangeConfig(exchange_type=ExchangeType.BYBIT)
        assert BybitAdapter(bybit_config).exchange_type == ExchangeType.BYBIT
