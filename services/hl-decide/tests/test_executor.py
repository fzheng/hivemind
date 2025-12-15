"""
Tests for Multi-Exchange Trade Executor

Tests account state normalization, Kelly sizing, and risk validation.

@module tests.test_executor
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from app.executor import HyperliquidExecutor, ExecutionResult
from app.exchanges.interface import Balance, Position, PositionSide, MarginMode


# =============================================================================
# Test Fixtures
# =============================================================================


@pytest.fixture
def executor():
    """Create executor instance for testing."""
    return HyperliquidExecutor(address="0x1234567890abcdef1234567890abcdef12345678")


@pytest.fixture
def usd_balance():
    """Create USD-denominated balance (Hyperliquid)."""
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
    """Create USDT-denominated balance (Bybit)."""
    return Balance(
        total_equity=50000.0,
        available_balance=40000.0,
        margin_used=10000.0,
        unrealized_pnl=250.0,
        realized_pnl_today=-100.0,
        currency="USDT",
        timestamp=datetime.now(timezone.utc),
    )


@pytest.fixture
def btc_position():
    """Create BTC long position."""
    return Position(
        symbol="BTC",
        side=PositionSide.LONG,
        size=0.5,
        entry_price=50000.0,
        mark_price=51000.0,
        unrealized_pnl=500.0,
        leverage=1,
        margin_mode=MarginMode.CROSS,
        timestamp=datetime.now(timezone.utc),
    )


@pytest.fixture
def eth_position():
    """Create ETH short position."""
    return Position(
        symbol="ETH",
        side=PositionSide.SHORT,
        size=-2.0,
        entry_price=3000.0,
        mark_price=2950.0,
        unrealized_pnl=100.0,
        leverage=2,
        margin_mode=MarginMode.CROSS,
        timestamp=datetime.now(timezone.utc),
    )


# =============================================================================
# Account State Normalization Tests
# =============================================================================


class TestAccountStateNormalization:
    """Tests for account state normalization in executor."""

    def test_usd_balance_normalized_identity(self, executor, usd_balance):
        """USD balance normalizes with identity conversion."""
        positions = []
        state = executor._to_hl_account_state(usd_balance, positions)

        # Values should be unchanged for USD
        assert float(state["marginSummary"]["accountValue"]) == 100000.0
        assert float(state["marginSummary"]["totalMarginUsed"]) == 20000.0
        assert float(state["marginSummary"]["totalNtlPos"]) == 0.0

        # Normalization metadata should show identity
        assert state["_normalization"]["original_currency"] == "USD"
        assert state["_normalization"]["conversion_rate"] == 1.0
        assert state["_normalization"]["conversion_source"] == "identity"

    def test_usdt_balance_normalized(self, executor, usdt_balance):
        """USDT balance treated as 1:1 with USD (no conversion)."""
        positions = []

        # USDT is treated as USD (1:1), no API calls needed
        state = executor._to_hl_account_state(usdt_balance, positions)

        # Values should be unchanged (1:1 rate)
        assert float(state["marginSummary"]["accountValue"]) == 50000.0
        assert float(state["marginSummary"]["totalMarginUsed"]) == 10000.0

        # Normalization metadata shows identity (USDT = USD)
        assert state["_normalization"]["original_currency"] == "USDT"
        assert state["_normalization"]["conversion_rate"] == 1.0
        assert state["_normalization"]["conversion_source"] == "identity"

    def test_positions_normalized(self, executor, usd_balance, btc_position, eth_position):
        """Position notional values are USD-normalized."""
        positions = [btc_position, eth_position]
        state = executor._to_hl_account_state(usd_balance, positions)

        # Should have two positions
        assert len(state["assetPositions"]) == 2

        # BTC position: 0.5 * 51000 = 25500 notional
        btc_pos = state["assetPositions"][0]["position"]
        assert btc_pos["coin"] == "BTC"
        assert float(btc_pos["szi"]) == 0.5
        assert float(btc_pos["entryPx"]) == 50000.0

        # ETH position: 2.0 * 2950 = 5900 notional
        eth_pos = state["assetPositions"][1]["position"]
        assert eth_pos["coin"] == "ETH"
        assert float(eth_pos["szi"]) == -2.0
        assert float(eth_pos["entryPx"]) == 3000.0

    def test_total_notional_calculated(self, executor, usd_balance, btc_position):
        """Total notional position calculated correctly."""
        positions = [btc_position]
        state = executor._to_hl_account_state(usd_balance, positions)

        # BTC position notional: 0.5 * 51000 = 25500
        total_ntl = float(state["marginSummary"]["totalNtlPos"])
        assert total_ntl == pytest.approx(25500.0, rel=0.01)

class TestMultiExchangeNormalization:
    """Tests for multi-exchange account aggregation."""

    def test_mixed_currency_positions(self, executor):
        """Test handling positions with different quote currencies (USDT=USD)."""
        # Bybit balance in USDT (treated as 1:1 with USD)
        balance = Balance(
            total_equity=30000.0,
            available_balance=25000.0,
            margin_used=5000.0,
            currency="USDT",
        )

        # BTC position on Bybit (USDT quote)
        position = Position(
            symbol="BTCUSDT",
            side=PositionSide.LONG,
            size=0.3,
            entry_price=60000.0,
            mark_price=61000.0,
            unrealized_pnl=300.0,
        )

        state = executor._to_hl_account_state(balance, [position])

        # Verify values unchanged (USDT = USD 1:1)
        assert float(state["marginSummary"]["accountValue"]) == 30000.0

        # Position: 0.3 * 61000 = 18300 (no conversion)
        assert float(state["marginSummary"]["totalNtlPos"]) == pytest.approx(18300.0, rel=0.01)

        # Normalization metadata shows identity
        assert state["_normalization"]["original_currency"] == "USDT"
        assert state["_normalization"]["conversion_rate"] == 1.0
        assert state["_normalization"]["conversion_source"] == "identity"


# =============================================================================
# Execution Result Tests
# =============================================================================


class TestExecutionResult:
    """Tests for ExecutionResult dataclass."""

    def test_execution_result_simulated(self):
        """Simulated execution result."""
        result = ExecutionResult(
            status="simulated",
            fill_price=50000.0,
            fill_size=0.01,
            exposure_before=10000.0,
            exposure_after=10500.0,
            position_pct=0.05,
        )

        assert result.status == "simulated"
        assert result.fill_price == 50000.0
        assert result.error_message is None

    def test_execution_result_rejected(self):
        """Rejected execution result."""
        result = ExecutionResult(
            status="rejected",
            error_message="Risk limit exceeded",
        )

        assert result.status == "rejected"
        assert result.error_message == "Risk limit exceeded"
        assert result.fill_price is None

    def test_execution_result_with_kelly(self):
        """Execution result with Kelly sizing info."""
        from app.kelly import KellyResult

        kelly_result = KellyResult(
            full_kelly=0.10,
            fractional_kelly=0.025,  # Quarter Kelly
            position_pct=0.025,
            position_size_usd=2500.0,
            position_size_coin=0.05,
            method="kelly",
            reasoning="Computed from 50 episodes with 55% win rate",
            capped=False,
        )

        result = ExecutionResult(
            status="filled",
            fill_price=50000.0,
            fill_size=0.05,
            kelly_result=kelly_result,
        )

        assert result.kelly_result is not None
        assert result.kelly_result.position_size_usd == 2500.0
        assert result.kelly_result.method == "kelly"


# =============================================================================
# HTTP Client Tests
# =============================================================================


class TestHTTPClient:
    """Tests for HTTP client management."""

    @pytest.mark.asyncio
    async def test_client_created_on_demand(self, executor):
        """HTTP client created lazily."""
        assert executor._http_client is None

        client = await executor._get_client()
        assert client is not None
        assert executor._http_client is client

    @pytest.mark.asyncio
    async def test_client_reused(self, executor):
        """HTTP client is reused across calls."""
        client1 = await executor._get_client()
        client2 = await executor._get_client()

        assert client1 is client2

    @pytest.mark.asyncio
    async def test_close_client(self, executor):
        """Can close HTTP client."""
        await executor._get_client()
        assert executor._http_client is not None

        await executor.close()
        # Note: close() doesn't set to None, just closes


# =============================================================================
# Safety Metrics Tests
# =============================================================================


class TestSafetyMetrics:
    """Tests for safety block metrics."""

    def test_increment_safety_block(self):
        """Safety block counter can be incremented."""
        from app.executor import increment_safety_block

        # Should not raise
        increment_safety_block("test_guard")

    def test_safety_block_guards(self):
        """All safety guard types can be incremented."""
        from app.executor import increment_safety_block

        guards = ["kill_switch", "account_state", "risk_governor", "circuit_breaker"]
        for guard in guards:
            increment_safety_block(guard)


# =============================================================================
# Integration Tests
# =============================================================================


class TestExecutorIntegration:
    """Integration-style tests for executor."""

    def test_normalization_metadata_audit_trail(self, executor, usdt_balance):
        """Normalization metadata provides complete audit trail."""
        state = executor._to_hl_account_state(usdt_balance, [])

        # Complete audit trail (USDT = USD 1:1)
        norm_meta = state["_normalization"]
        assert "original_currency" in norm_meta
        assert "conversion_rate" in norm_meta
        assert "conversion_source" in norm_meta

        # USDT treated as USD (1:1), source is identity
        assert norm_meta["original_currency"] == "USDT"
        assert norm_meta["conversion_rate"] == 1.0
        assert norm_meta["conversion_source"] == "identity"

    def test_risk_check_uses_normalized_values(self, executor, usdt_balance, btc_position):
        """Risk checks use USD-normalized account values (USDT=USD)."""
        state = executor._to_hl_account_state(usdt_balance, [btc_position])

        # Risk governor will use these USD-normalized values (USDT = USD 1:1)
        account_value = float(state["marginSummary"]["accountValue"])
        total_exposure = float(state["marginSummary"]["totalNtlPos"])

        # BTC position: 0.5 * 51000 = 25500 (no conversion)
        assert account_value == 50000.0  # USDT balance unchanged
        assert total_exposure == pytest.approx(25500.0, rel=0.01)

        # Verify position % calculation uses normalized values
        position_pct = total_exposure / account_value if account_value > 0 else 0
        assert position_pct == pytest.approx(25500.0 / 50000.0, rel=0.01)  # 51%


# =============================================================================
# Slippage Recalculation Tests (Phase 6.1 Gap Fix)
# =============================================================================


class TestSlippageRecalculation:
    """Tests for slippage recalculation with Kelly-sized positions."""

    def test_slippage_reference_size_config(self):
        """Reference size is configurable."""
        from app.consensus import SLIPPAGE_REFERENCE_SIZE_USD
        # Default is $10k
        assert SLIPPAGE_REFERENCE_SIZE_USD == 10000.0

    def test_consensus_uses_reference_size(self):
        """Consensus detection uses reference size, not vote notional."""
        from app.consensus import get_slippage_estimate_bps_sync, SLIPPAGE_REFERENCE_SIZE_USD

        # The slippage function accepts order_size_usd parameter
        # Consensus should pass SLIPPAGE_REFERENCE_SIZE_USD, not vote notional
        slippage = get_slippage_estimate_bps_sync(
            asset="BTC",
            exchange="hyperliquid",
            order_size_usd=SLIPPAGE_REFERENCE_SIZE_USD,
        )
        assert slippage > 0  # Should return valid slippage

    def test_slippage_varies_with_order_size(self):
        """Slippage estimates should vary with order size."""
        from app.consensus import get_slippage_estimate_bps_sync

        # Small order
        small_slip = get_slippage_estimate_bps_sync(
            asset="BTC",
            exchange="hyperliquid",
            order_size_usd=5000,
        )

        # Large order
        large_slip = get_slippage_estimate_bps_sync(
            asset="BTC",
            exchange="hyperliquid",
            order_size_usd=200000,
        )

        # Large orders should have more slippage
        assert large_slip >= small_slip

    def test_ev_calculation_with_slippage(self):
        """EV calculation correctly incorporates slippage."""
        from app.consensus import calculate_ev

        # Base EV (no costs)
        ev_no_cost = calculate_ev(
            p_win=0.55,
            entry_px=50000,
            stop_px=49000,  # 2% stop
            fees_bps=0,
            slip_bps=0,
            funding_bps=0,
        )

        # EV with slippage
        ev_with_slip = calculate_ev(
            p_win=0.55,
            entry_px=50000,
            stop_px=49000,
            fees_bps=0,
            slip_bps=20,  # 20 bps slippage
            funding_bps=0,
        )

        # Slippage reduces net EV
        assert ev_with_slip["ev_net_r"] < ev_no_cost["ev_net_r"]
        assert ev_with_slip["ev_cost_r"] > ev_no_cost["ev_cost_r"]

    def test_high_slippage_can_reject_signal(self):
        """High slippage can push EV below minimum threshold."""
        from app.consensus import calculate_ev, CONSENSUS_EV_MIN_R

        # Marginal signal with high slippage
        ev_result = calculate_ev(
            p_win=0.55,
            entry_px=50000,
            stop_px=49500,  # 1% stop
            fees_bps=10,
            slip_bps=50,  # Very high slippage
            funding_bps=10,
        )

        # With 70 bps total cost on 1% stop = 0.70R cost
        # This should significantly impact marginal signals
        assert ev_result["ev_cost_r"] > 0.5  # Cost should be substantial

    def test_slippage_by_exchange(self):
        """Different exchanges have different slippage profiles."""
        from app.consensus import get_slippage_estimate_bps_sync

        # CEX typically has lower slippage than DEX
        hl_slip = get_slippage_estimate_bps_sync(
            asset="BTC",
            exchange="hyperliquid",
            order_size_usd=50000,
        )

        bybit_slip = get_slippage_estimate_bps_sync(
            asset="BTC",
            exchange="bybit",
            order_size_usd=50000,
        )

        # Both should be valid (>0)
        assert hl_slip > 0
        assert bybit_slip > 0
        # Bybit (CEX) typically has tighter spreads
        assert bybit_slip <= hl_slip
