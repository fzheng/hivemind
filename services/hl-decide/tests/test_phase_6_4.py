"""
Tests for Phase 6.4: Per-Venue Data-Quality Fallbacks

Phase 6.4 addresses the gap that correlation and hold-time data is derived
exclusively from Hyperliquid. When executing on non-HL venues, we use more
conservative defaults to account for the uncertainty.

Key features tested:
1. Per-exchange correlation fallback (NON_HL_DEFAULT_CORRELATION = 0.5 vs 0.3)
2. Hold-time venue adjustment (15% shorter for non-HL venues)
3. Per-venue rate limiting in health checks
"""

import pytest
from datetime import datetime, timezone, timedelta, date
from unittest.mock import AsyncMock, MagicMock, patch
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.consensus import (
    ConsensusDetector,
    DEFAULT_CORRELATION,
    NON_HL_DEFAULT_CORRELATION,
)
from app.correlation import (
    CorrelationProvider,
    DEFAULT_CORRELATION as CORR_DEFAULT,
    NON_HL_DEFAULT_CORRELATION as CORR_NON_HL_DEFAULT,
)
from app.hold_time_estimator import (
    HoldTimeEstimator,
    HoldTimeEstimate,
    EstimateSource,
    VENUE_HOLD_TIME_MULTIPLIERS,
    DEFAULT_HOLD_HOURS,
)


class TestCorrelationExchangeAwareFallback:
    """Test per-exchange correlation fallback (Phase 6.4)."""

    def test_default_correlation_for_hyperliquid(self):
        """Hyperliquid should use the standard default (0.3)."""
        assert DEFAULT_CORRELATION == 0.3

    def test_conservative_correlation_for_non_hl(self):
        """Non-HL venues should use conservative default (0.5)."""
        assert NON_HL_DEFAULT_CORRELATION == 0.5

    def test_eff_k_uses_hl_default_for_hyperliquid(self):
        """eff_k_from_corr should use 0.3 default for HL target exchange."""
        detector = ConsensusDetector(target_exchange="hyperliquid")

        # No correlation data set - will use defaults
        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k = detector.eff_k_from_corr(weights, target_exchange="hyperliquid")

        # With rho=0.3: effK = 9 / (3 + 6*0.3) = 9/4.8 = 1.875
        expected_eff_k = 9 / (3 + 6 * 0.3)
        assert eff_k == pytest.approx(expected_eff_k, rel=0.01)

    def test_eff_k_uses_conservative_default_for_bybit(self):
        """eff_k_from_corr should use 0.5 default for Bybit target exchange."""
        detector = ConsensusDetector(target_exchange="bybit")

        # No correlation data set - will use defaults
        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k = detector.eff_k_from_corr(weights, target_exchange="bybit")

        # With rho=0.5: effK = 9 / (3 + 6*0.5) = 9/6 = 1.5
        expected_eff_k = 9 / (3 + 6 * 0.5)
        assert eff_k == pytest.approx(expected_eff_k, rel=0.01)

    def test_eff_k_conservative_default_gives_lower_eff_k(self):
        """Higher default correlation should result in lower eff-K (more conservative)."""
        detector = ConsensusDetector()

        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k_hl = detector.eff_k_from_corr(weights, target_exchange="hyperliquid")
        eff_k_bybit = detector.eff_k_from_corr(weights, target_exchange="bybit")

        # Higher correlation = more correlation = fewer independent traders = lower eff-K
        assert eff_k_hl > eff_k_bybit

    def test_eff_k_with_stored_correlation_ignores_default(self):
        """When correlation is stored, default doesn't matter."""
        detector = ConsensusDetector()

        # Set explicit correlations
        detector.update_correlation("0x1111", "0x2222", 0.2)
        detector.update_correlation("0x1111", "0x3333", 0.2)
        detector.update_correlation("0x2222", "0x3333", 0.2)

        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k_hl = detector.eff_k_from_corr(weights, target_exchange="hyperliquid")
        eff_k_bybit = detector.eff_k_from_corr(weights, target_exchange="bybit")

        # With stored correlations, both should be equal
        assert eff_k_hl == pytest.approx(eff_k_bybit, rel=0.01)


class TestCorrelationProviderExchangeAware:
    """Test CorrelationProvider with exchange-aware defaults."""

    def test_get_with_decay_uses_hl_default(self):
        """get_with_decay should use HL default for hyperliquid."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()
        provider.correlations = {}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False, target_exchange="hyperliquid")

        assert rho == CORR_DEFAULT  # 0.3

    def test_get_with_decay_uses_conservative_default_for_bybit(self):
        """get_with_decay should use conservative default for bybit."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()
        provider.correlations = {}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False, target_exchange="bybit")

        assert rho == CORR_NON_HL_DEFAULT  # 0.5

    def test_get_with_decay_blends_to_exchange_specific_default(self):
        """Decay should blend toward exchange-specific default."""
        from app.correlation import CORR_DECAY_HALFLIFE_DAYS

        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=CORR_DECAY_HALFLIFE_DAYS)
        provider.correlations = {("0x1111", "0x2222"): 0.9}

        rho_hl = provider.get_with_decay("0x1111", "0x2222", log_default=False, target_exchange="hyperliquid")
        rho_bybit = provider.get_with_decay("0x1111", "0x2222", log_default=False, target_exchange="bybit")

        # At half-life:
        # HL: 0.9 * 0.5 + 0.3 * 0.5 = 0.6
        # Bybit: 0.9 * 0.5 + 0.5 * 0.5 = 0.7
        expected_hl = 0.9 * 0.5 + CORR_DEFAULT * 0.5
        expected_bybit = 0.9 * 0.5 + CORR_NON_HL_DEFAULT * 0.5

        assert rho_hl == pytest.approx(expected_hl, rel=0.05)
        assert rho_bybit == pytest.approx(expected_bybit, rel=0.05)
        assert rho_bybit > rho_hl


class TestHoldTimeVenueAdjustment:
    """Test hold-time venue adjustment (Phase 6.4)."""

    def test_venue_multipliers_configured(self):
        """Venue multipliers should be configured."""
        assert VENUE_HOLD_TIME_MULTIPLIERS["hyperliquid"] == 1.0
        assert VENUE_HOLD_TIME_MULTIPLIERS["bybit"] == 0.85
        assert VENUE_HOLD_TIME_MULTIPLIERS["aster"] == 0.85

    def test_get_hold_time_sync_applies_venue_multiplier(self):
        """get_hold_time_sync should apply venue multiplier."""
        estimator = HoldTimeEstimator()

        # No cache, should return fallback with venue adjustment
        estimate_hl = estimator.get_hold_time_sync("BTC", target_exchange="hyperliquid")
        estimate_bybit = estimator.get_hold_time_sync("BTC", target_exchange="bybit")

        # HL: DEFAULT_HOLD_HOURS * 1.0 = 24
        # Bybit: DEFAULT_HOLD_HOURS * 0.85 = 20.4
        assert estimate_hl.hours == pytest.approx(DEFAULT_HOLD_HOURS * 1.0, rel=0.01)
        assert estimate_bybit.hours == pytest.approx(DEFAULT_HOLD_HOURS * 0.85, rel=0.01)

    def test_bybit_hold_time_shorter_than_hl(self):
        """Bybit hold time should be shorter than HL (conservative)."""
        estimator = HoldTimeEstimator()

        estimate_hl = estimator.get_hold_time_sync("BTC", target_exchange="hyperliquid")
        estimate_bybit = estimator.get_hold_time_sync("BTC", target_exchange="bybit")

        assert estimate_bybit.hours < estimate_hl.hours

    def test_hold_time_estimate_includes_target_exchange(self):
        """HoldTimeEstimate should include target_exchange field."""
        estimator = HoldTimeEstimator()

        estimate = estimator.get_hold_time_sync("BTC", target_exchange="bybit")

        assert estimate.target_exchange == "bybit"

    def test_unknown_venue_uses_conservative_default(self):
        """Unknown venues should use conservative multiplier (0.85)."""
        estimator = HoldTimeEstimator()

        estimate = estimator.get_hold_time_sync("BTC", target_exchange="unknown_exchange")

        # Should use 0.85 multiplier
        expected_hours = DEFAULT_HOLD_HOURS * 0.85
        assert estimate.hours == pytest.approx(expected_hours, rel=0.01)


class TestHoldTimeWithRegimeAndVenue:
    """Test hold-time with both regime and venue adjustments."""

    def test_regime_and_venue_adjustments_stack(self):
        """Regime and venue adjustments should stack multiplicatively."""
        from app.hold_time_estimator import REGIME_HOLD_TIME_MULTIPLIERS, CachedHoldTime

        estimator = HoldTimeEstimator()

        # Pre-populate cache with a base estimate
        base_estimate = HoldTimeEstimate(
            hours=24.0,
            source=EstimateSource.HISTORICAL,
            episode_count=100,
            median_hours=24.0,
            std_hours=6.0,
            asset="BTC",
        )
        estimator._cache["BTC:none"] = CachedHoldTime(
            estimate=base_estimate,
            fetched_at=datetime.now(timezone.utc),
        )

        # Get with regime and venue
        estimate = estimator.get_hold_time_sync(
            "BTC",
            regime="VOLATILE",
            target_exchange="bybit",
        )

        # Expected: 24 * 0.75 (volatile) * 0.85 (bybit) = 15.3
        expected = 24.0 * REGIME_HOLD_TIME_MULTIPLIERS["VOLATILE"] * VENUE_HOLD_TIME_MULTIPLIERS["bybit"]
        assert estimate.hours == pytest.approx(expected, rel=0.01)


class TestConsensusGetDynamicHoldHoursSync:
    """Test get_dynamic_hold_hours_sync with exchange parameter."""

    def test_get_dynamic_hold_hours_sync_passes_exchange(self):
        """get_dynamic_hold_hours_sync should accept and use target_exchange."""
        from app.consensus import get_dynamic_hold_hours_sync, USE_DYNAMIC_HOLD_TIME

        if not USE_DYNAMIC_HOLD_TIME:
            pytest.skip("Dynamic hold time disabled")

        hours_hl = get_dynamic_hold_hours_sync("BTC", target_exchange="hyperliquid")
        hours_bybit = get_dynamic_hold_hours_sync("BTC", target_exchange="bybit")

        # Bybit should be shorter (conservative)
        assert hours_bybit <= hours_hl


class TestPerVenueRateLimiting:
    """Test per-venue rate limiting in health checks."""

    def test_rate_limit_delays_configured(self):
        """Per-exchange rate limit delays should be configured."""
        from app.exchanges.manager import EXCHANGE_RATE_LIMIT_DELAYS_MS, DEFAULT_RATE_LIMIT_DELAY_MS

        assert EXCHANGE_RATE_LIMIT_DELAYS_MS["hyperliquid"] == 300
        assert EXCHANGE_RATE_LIMIT_DELAYS_MS["bybit"] == 750
        assert DEFAULT_RATE_LIMIT_DELAY_MS == 500

    def test_bybit_has_higher_delay_than_hl(self):
        """Bybit should have higher delay than Hyperliquid (stricter limits)."""
        from app.exchanges.manager import EXCHANGE_RATE_LIMIT_DELAYS_MS

        assert EXCHANGE_RATE_LIMIT_DELAYS_MS["bybit"] > EXCHANGE_RATE_LIMIT_DELAYS_MS["hyperliquid"]


class TestQuantAcceptance:
    """Quant acceptance tests for Phase 6.4."""

    def test_conservative_defaults_reduce_position_sizing(self):
        """Conservative defaults should lead to smaller position sizing.

        Higher correlation -> lower eff-K -> lower confidence -> smaller Kelly size.
        This tests the chain of conservatism.
        """
        detector = ConsensusDetector()

        weights = {"0x1111": 1.0, "0x2222": 1.0, "0x3333": 1.0, "0x4444": 1.0}

        eff_k_hl = detector.eff_k_from_corr(weights, target_exchange="hyperliquid")
        eff_k_bybit = detector.eff_k_from_corr(weights, target_exchange="bybit")

        # HL has lower default correlation -> higher eff-K -> more confidence
        # Bybit has higher default correlation -> lower eff-K -> less confidence
        assert eff_k_hl > eff_k_bybit

        # The ratio should reflect the correlation difference
        # With 4 traders, 6 pairs, and uniform weights:
        # HL: 16 / (4 + 12*0.3) = 16/7.6 = 2.1
        # Bybit: 16 / (4 + 12*0.5) = 16/10 = 1.6
        assert eff_k_hl == pytest.approx(16 / 7.6, rel=0.05)
        assert eff_k_bybit == pytest.approx(16 / 10, rel=0.05)

    def test_funding_cost_higher_with_shorter_hold_time(self):
        """Shorter hold time should NOT necessarily mean higher funding.

        This validates the funding cost calculation with venue-adjusted hold time.
        Shorter hold time = fewer funding periods = lower total funding cost.
        """
        from app.consensus import get_funding_cost_bps_sync

        # Get funding costs for same asset/direction but different hold times
        funding_hl = get_funding_cost_bps_sync(
            asset="BTC",
            exchange="hyperliquid",
            hold_hours=24.0,  # HL baseline
            side="long",
        )
        funding_bybit = get_funding_cost_bps_sync(
            asset="bybit",
            exchange="bybit",
            hold_hours=20.4,  # Bybit adjusted (24 * 0.85)
            side="long",
        )

        # Shorter hold time should have lower absolute funding cost
        # (fewer 8-hour funding periods)
        # Note: This assumes same funding rate per period
        assert abs(funding_bybit) <= abs(funding_hl)

    def test_all_venue_adjustments_are_conservative(self):
        """All venue adjustments should be in the conservative direction.

        - Higher correlation default = more conservative (lower eff-K)
        - Shorter hold time = more conservative (less funding exposure assumed)
        - Higher rate limit delay = more conservative (avoids rate limit errors)
        """
        from app.exchanges.manager import EXCHANGE_RATE_LIMIT_DELAYS_MS

        # Correlation: non-HL should be >= HL
        assert NON_HL_DEFAULT_CORRELATION >= DEFAULT_CORRELATION

        # Hold time: non-HL multipliers should be <= 1.0
        for venue, mult in VENUE_HOLD_TIME_MULTIPLIERS.items():
            if venue != "hyperliquid":
                assert mult <= 1.0, f"{venue} multiplier should be <= 1.0"

        # Rate limits: non-HL should be >= HL
        hl_delay = EXCHANGE_RATE_LIMIT_DELAYS_MS.get("hyperliquid", 0)
        for venue, delay in EXCHANGE_RATE_LIMIT_DELAYS_MS.items():
            if venue != "hyperliquid":
                assert delay >= hl_delay, f"{venue} delay should be >= HL delay"
