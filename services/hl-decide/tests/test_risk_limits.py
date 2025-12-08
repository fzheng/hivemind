"""
Tests for conservative risk defaults and fail-safes.

These tests verify the risk limit checks that serve as the final gate
before any signal is generated.
"""

import pytest
from datetime import datetime, timezone

from app.consensus import (
    check_risk_limits,
    ConsensusSignal,
    MIN_SIGNAL_CONFIDENCE,
    MIN_SIGNAL_EV_R,
    MAX_POSITION_SIZE_PCT,
    MAX_TOTAL_EXPOSURE_PCT,
    MAX_DAILY_LOSS_PCT,
    MAX_LEVERAGE,
    SIGNAL_COOLDOWN_SECONDS,
)


def make_signal(
    p_win: float = 0.60,
    ev_net_r: float = 0.30,
    symbol: str = "BTC",
    direction: str = "long",
) -> ConsensusSignal:
    """Create a test signal with configurable parameters."""
    return ConsensusSignal(
        id="test-123",
        symbol=symbol,
        direction=direction,
        entry_price=100000.0,
        stop_price=99000.0,
        n_traders=5,
        n_agreeing=4,
        eff_k=3.5,
        dispersion=0.15,
        p_win=p_win,
        ev_gross_r=0.35,
        ev_cost_r=0.05,
        ev_net_r=ev_net_r,
        latency_ms=500,
        median_voter_price=100000.0,
        mid_delta_bps=2.0,
        created_at=datetime.now(timezone.utc),
        trigger_addresses=["0xabc", "0xdef", "0x123", "0x456"],
    )


class TestRiskLimits:
    """Test check_risk_limits function."""

    def test_passes_with_good_signal(self):
        """Signal with good confidence and EV should pass."""
        signal = make_signal(p_win=0.65, ev_net_r=0.35)
        passes, reason = check_risk_limits(signal)
        assert passes is True
        assert reason == ""

    def test_rejects_low_confidence(self):
        """Signal with low confidence should be rejected."""
        signal = make_signal(p_win=0.45, ev_net_r=0.35)
        passes, reason = check_risk_limits(signal)
        assert passes is False
        assert "Confidence" in reason
        assert "minimum" in reason

    def test_rejects_low_ev(self):
        """Signal with low EV should be rejected."""
        signal = make_signal(p_win=0.65, ev_net_r=0.05)
        passes, reason = check_risk_limits(signal)
        assert passes is False
        assert "EV" in reason
        assert "minimum" in reason

    def test_boundary_confidence(self):
        """Signal at exactly minimum confidence should pass."""
        signal = make_signal(p_win=MIN_SIGNAL_CONFIDENCE, ev_net_r=0.35)
        passes, reason = check_risk_limits(signal)
        assert passes is True

    def test_boundary_ev(self):
        """Signal at exactly minimum EV should pass."""
        signal = make_signal(p_win=0.65, ev_net_r=MIN_SIGNAL_EV_R)
        passes, reason = check_risk_limits(signal)
        assert passes is True

    def test_both_low(self):
        """Signal with both low confidence and EV should be rejected."""
        signal = make_signal(p_win=0.45, ev_net_r=0.05)
        passes, reason = check_risk_limits(signal)
        assert passes is False
        # First failing check should be confidence
        assert "Confidence" in reason


class TestRiskDefaults:
    """Test that risk defaults are conservative."""

    def test_min_confidence_is_positive_edge(self):
        """Minimum confidence should require positive edge (>50%)."""
        assert MIN_SIGNAL_CONFIDENCE > 0.50

    def test_min_ev_is_positive(self):
        """Minimum EV should be positive (profitable after costs)."""
        assert MIN_SIGNAL_EV_R > 0

    def test_max_position_is_conservative(self):
        """Max position size should be conservative (<10%)."""
        assert MAX_POSITION_SIZE_PCT <= 10.0

    def test_max_exposure_is_bounded(self):
        """Max total exposure should be bounded (<50%)."""
        assert MAX_TOTAL_EXPOSURE_PCT <= 50.0

    def test_max_daily_loss_is_bounded(self):
        """Max daily loss should be bounded (<10%)."""
        assert MAX_DAILY_LOSS_PCT <= 10.0

    def test_max_leverage_is_conservative(self):
        """Max leverage should be conservative (<=2x until Kelly implemented)."""
        assert MAX_LEVERAGE <= 2.0

    def test_cooldown_is_reasonable(self):
        """Cooldown should be at least 1 minute."""
        assert SIGNAL_COOLDOWN_SECONDS >= 60
