"""
Tests for Account Normalizer

USDT is treated as equivalent to USD (1:1). No API calls needed.

@module tests.test_account_normalizer
"""

import pytest
from datetime import datetime, timezone

from app.account_normalizer import (
    AccountNormalizer,
    NormalizedBalance,
    NormalizedPosition,
    get_account_normalizer,
    init_account_normalizer,
)
from app.exchanges.interface import Balance, Position, PositionSide, MarginMode


# =============================================================================
# Test Fixtures
# =============================================================================


@pytest.fixture
def normalizer():
    """Create fresh account normalizer for testing."""
    return AccountNormalizer()


@pytest.fixture
def usd_balance():
    """Create USD-denominated balance."""
    return Balance(
        total_equity=100000.0,
        available_balance=80000.0,
        margin_used=20000.0,
        unrealized_pnl=500.0,
        realized_pnl_today=-200.0,
        currency="USD",
        timestamp=datetime.now(timezone.utc),
    )


@pytest.fixture
def usdt_balance():
    """Create USDT-denominated balance."""
    return Balance(
        total_equity=100000.0,
        available_balance=80000.0,
        margin_used=20000.0,
        unrealized_pnl=500.0,
        realized_pnl_today=-200.0,
        currency="USDT",
        timestamp=datetime.now(timezone.utc),
    )


@pytest.fixture
def btc_position():
    """Create BTC position."""
    return Position(
        symbol="BTC",
        side=PositionSide.LONG,
        size=1.0,
        entry_price=50000.0,
        mark_price=51000.0,
        unrealized_pnl=1000.0,
        leverage=1,
        margin_mode=MarginMode.CROSS,
        timestamp=datetime.now(timezone.utc),
    )


# =============================================================================
# NormalizedBalance Tests
# =============================================================================


class TestNormalizedBalance:
    """Tests for NormalizedBalance dataclass."""

    def test_margin_ratio(self):
        """Margin ratio calculated correctly."""
        balance = Balance(
            total_equity=100000.0,
            available_balance=80000.0,
            margin_used=20000.0,
            currency="USD",
        )
        normalized = NormalizedBalance(
            original=balance,
            total_equity_usd=100000.0,
            available_balance_usd=80000.0,
            margin_used_usd=20000.0,
            unrealized_pnl_usd=0.0,
            realized_pnl_today_usd=0.0,
        )
        assert normalized.margin_ratio == 0.2  # 20%

    def test_margin_ratio_zero_equity(self):
        """Margin ratio is 0 when equity is 0."""
        balance = Balance(
            total_equity=0.0,
            available_balance=0.0,
            margin_used=0.0,
            currency="USD",
        )
        normalized = NormalizedBalance(
            original=balance,
            total_equity_usd=0.0,
            available_balance_usd=0.0,
            margin_used_usd=0.0,
            unrealized_pnl_usd=0.0,
            realized_pnl_today_usd=0.0,
        )
        assert normalized.margin_ratio == 0.0

    def test_depeg_warning_always_false(self):
        """Depeg warning is always False (USDT=USD)."""
        balance = Balance(total_equity=100000.0, available_balance=80000.0, margin_used=20000.0, currency="USDT")
        normalized = NormalizedBalance(
            original=balance,
            total_equity_usd=100000.0,
            available_balance_usd=80000.0,
            margin_used_usd=20000.0,
            unrealized_pnl_usd=0.0,
            realized_pnl_today_usd=0.0,
        )
        assert normalized.is_depeg_warning is False


# =============================================================================
# AccountNormalizer Tests
# =============================================================================


class TestAccountNormalizer:
    """Tests for AccountNormalizer class."""

    @pytest.mark.asyncio
    async def test_normalize_usd_balance(self, normalizer, usd_balance):
        """USD balance normalizes with identity conversion."""
        normalized = await normalizer.normalize_balance(usd_balance)

        assert normalized.total_equity_usd == usd_balance.total_equity
        assert normalized.available_balance_usd == usd_balance.available_balance
        assert normalized.margin_used_usd == usd_balance.margin_used
        assert normalized.conversion_rate == 1.0
        assert normalized.conversion_source == "identity"

    @pytest.mark.asyncio
    async def test_normalize_usdt_balance(self, normalizer, usdt_balance):
        """USDT balance normalizes as 1:1 with USD."""
        normalized = await normalizer.normalize_balance(usdt_balance)

        # USDT = USD (1:1)
        assert normalized.total_equity_usd == usdt_balance.total_equity
        assert normalized.available_balance_usd == usdt_balance.available_balance
        assert normalized.conversion_rate == 1.0
        assert normalized.conversion_source == "identity"

    def test_normalize_balance_sync_usd(self, normalizer, usd_balance):
        """Sync normalization works for USD."""
        normalized = normalizer.normalize_balance_sync(usd_balance)

        assert normalized.total_equity_usd == usd_balance.total_equity
        assert normalized.conversion_source == "identity"

    def test_normalize_balance_sync_usdt(self, normalizer, usdt_balance):
        """Sync normalization treats USDT as USD."""
        normalized = normalizer.normalize_balance_sync(usdt_balance)

        # USDT = USD (1:1)
        assert normalized.total_equity_usd == usdt_balance.total_equity
        assert normalized.conversion_rate == 1.0
        assert normalized.conversion_source == "identity"

    @pytest.mark.asyncio
    async def test_normalize_position_usd(self, normalizer, btc_position):
        """Position with USD quote normalizes correctly."""
        normalized = await normalizer.normalize_position(btc_position, quote_currency="USD")

        assert normalized.notional_value_usd == btc_position.notional_value
        assert normalized.conversion_rate == 1.0
        assert normalized.conversion_source == "identity"

    @pytest.mark.asyncio
    async def test_normalize_position_usdt(self, normalizer, btc_position):
        """Position with USDT quote normalizes as 1:1."""
        normalized = await normalizer.normalize_position(btc_position, quote_currency="USDT")

        # USDT = USD (1:1)
        assert normalized.notional_value_usd == btc_position.notional_value
        assert normalized.conversion_rate == 1.0

    def test_normalize_position_sync(self, normalizer, btc_position):
        """Sync position normalization works."""
        normalized = normalizer.normalize_position_sync(btc_position, quote_currency="USD")

        assert normalized.notional_value_usd == btc_position.notional_value

    def test_get_conversion_rate_usd(self, normalizer):
        """USD conversion is identity."""
        rate, source = normalizer.get_conversion_rate("USD")
        assert rate == 1.0
        assert source == "identity"

    def test_get_conversion_rate_usdt(self, normalizer):
        """USDT conversion is identity (USDT=USD)."""
        rate, source = normalizer.get_conversion_rate("USDT")
        assert rate == 1.0
        assert source == "identity"

    def test_get_conversion_rate_unknown(self, normalizer):
        """Unknown currency assumes 1:1."""
        rate, source = normalizer.get_conversion_rate("BTC")
        assert rate == 1.0
        assert source == "assumed"

    def test_clear_cache_noop(self, normalizer):
        """Cache clear is no-op (no caching needed)."""
        normalizer.clear_cache()  # Should not raise

    def test_get_cache_status_empty(self, normalizer):
        """Cache status is empty (no caching needed)."""
        status = normalizer.get_cache_status()
        assert status == {}

    @pytest.mark.asyncio
    async def test_close_noop(self, normalizer):
        """Close is no-op (no HTTP client)."""
        await normalizer.close()  # Should not raise


class TestAccountNormalizerSingleton:
    """Tests for global singleton."""

    def test_get_account_normalizer_singleton(self):
        """get_account_normalizer returns same instance."""
        # Reset singleton for test
        import app.account_normalizer as module
        module._account_normalizer = None

        normalizer1 = get_account_normalizer()
        normalizer2 = get_account_normalizer()

        assert normalizer1 is normalizer2

    @pytest.mark.asyncio
    async def test_init_account_normalizer(self):
        """init_account_normalizer creates new instance."""
        import app.account_normalizer as module
        module._account_normalizer = None

        normalizer = await init_account_normalizer()

        assert normalizer is not None
        assert get_account_normalizer() is normalizer


class TestIntegration:
    """Integration-style tests."""

    @pytest.mark.asyncio
    async def test_aggregate_multi_exchange_exposure(self):
        """Aggregate exposure across multiple exchanges."""
        normalizer = AccountNormalizer()

        # Simulate HL balance (USD)
        hl_balance = Balance(
            total_equity=50000.0,
            available_balance=40000.0,
            margin_used=10000.0,
            currency="USD",
        )

        # Simulate Bybit balance (USDT)
        bybit_balance = Balance(
            total_equity=30000.0,
            available_balance=25000.0,
            margin_used=5000.0,
            currency="USDT",
        )

        hl_normalized = await normalizer.normalize_balance(hl_balance)
        bybit_normalized = await normalizer.normalize_balance(bybit_balance)

        # Aggregate totals (USDT = USD, so direct addition)
        total_equity = hl_normalized.total_equity_usd + bybit_normalized.total_equity_usd
        total_margin = hl_normalized.margin_used_usd + bybit_normalized.margin_used_usd

        # Expected: 50000 + 30000 = 80000 (no conversion)
        assert total_equity == 80000.0
        # Expected: 10000 + 5000 = 15000 (no conversion)
        assert total_margin == 15000.0

        await normalizer.close()

    @pytest.mark.asyncio
    async def test_risk_check_with_normalization(self):
        """Risk check with normalized values across venues."""
        normalizer = AccountNormalizer()

        # 10% max position size rule
        MAX_POSITION_PCT = 0.10

        # Bybit position (USDT quote)
        position = Position(
            symbol="BTCUSDT",
            side=PositionSide.LONG,
            size=0.5,
            entry_price=100000.0,
            mark_price=100000.0,  # $50k notional
        )

        # Bybit balance
        balance = Balance(
            total_equity=200000.0,
            available_balance=150000.0,
            margin_used=50000.0,
            currency="USDT",
        )

        norm_balance = await normalizer.normalize_balance(balance)
        norm_position = await normalizer.normalize_position(position, quote_currency="USDT")

        # Position size as % of equity
        position_pct = norm_position.notional_value_usd / norm_balance.total_equity_usd

        # 50000 / 200000 = 25%
        assert position_pct == 0.25
        assert position_pct > MAX_POSITION_PCT  # Would fail risk check

        await normalizer.close()
