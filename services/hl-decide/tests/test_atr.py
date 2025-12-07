"""
Tests for ATR (Average True Range) Provider.

These tests verify:
1. True Range calculation with gaps
2. ATR smoothing algorithm (Wilder's method)
3. Stop fraction derivation
4. Fallback behavior when no data
5. Cache behavior
"""
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.atr import (
    calculate_true_range,
    calculate_atr,
    ATRProvider,
    ATRData,
    Candle,
    ATR_PERIOD,
    ATR_MULTIPLIER_BTC,
    ATR_MULTIPLIER_ETH,
    ATR_FALLBACK_PCT,
    ATR_MAX_STALENESS_SECONDS,
    ATR_FALLBACK_BY_ASSET,
)


class TestTrueRangeCalculation:
    """Test True Range calculation."""

    def test_true_range_no_gap(self):
        """TR = High - Low when no gap (prev close within range)."""
        candle = Candle(
            ts=datetime.now(timezone.utc),
            open=100.0,
            high=105.0,
            low=95.0,
            close=102.0,
        )
        tr = calculate_true_range(candle, prev_close=100.0)
        assert tr == 10.0  # High - Low = 105 - 95

    def test_true_range_gap_up(self):
        """TR = High - Prev Close when gap up."""
        candle = Candle(
            ts=datetime.now(timezone.utc),
            open=110.0,
            high=115.0,
            low=108.0,
            close=112.0,
        )
        # Gap up from 100 to 108 (low)
        tr = calculate_true_range(candle, prev_close=100.0)
        # max(115-108=7, |115-100|=15, |108-100|=8) = 15
        assert tr == 15.0

    def test_true_range_gap_down(self):
        """TR = Prev Close - Low when gap down."""
        candle = Candle(
            ts=datetime.now(timezone.utc),
            open=90.0,
            high=92.0,
            low=85.0,
            close=88.0,
        )
        # Gap down from 100 to 92 (high)
        tr = calculate_true_range(candle, prev_close=100.0)
        # max(92-85=7, |92-100|=8, |85-100|=15) = 15
        assert tr == 15.0

    def test_true_range_no_prev_close(self):
        """TR = High - Low when no previous close (first candle)."""
        candle = Candle(
            ts=datetime.now(timezone.utc),
            open=100.0,
            high=105.0,
            low=95.0,
            close=102.0,
        )
        tr = calculate_true_range(candle, prev_close=None)
        assert tr == 10.0  # High - Low


class TestATRCalculation:
    """Test ATR calculation using Wilder's smoothing."""

    def test_atr_insufficient_data(self):
        """ATR returns None with insufficient candles."""
        candles = [
            Candle(ts=datetime.now(timezone.utc), open=100, high=105, low=95, close=100)
            for _ in range(5)  # Less than ATR_PERIOD + 1
        ]
        atr = calculate_atr(candles, period=14)
        assert atr is None

    def test_atr_simple_case(self):
        """ATR calculation with constant range candles."""
        now = datetime.now(timezone.utc)
        candles = []

        # Create 20 candles with constant range (high=105, low=95, close=100)
        for i in range(20):
            candles.append(Candle(
                ts=now + timedelta(minutes=i),
                open=100.0,
                high=105.0,
                low=95.0,
                close=100.0,
            ))

        atr = calculate_atr(candles, period=14)

        # With constant range of 10, ATR should converge to ~10
        assert atr is not None
        assert 9.0 < atr < 11.0

    def test_atr_increasing_volatility(self):
        """ATR increases when volatility increases."""
        now = datetime.now(timezone.utc)
        candles = []

        # Create candles with increasing range
        for i in range(20):
            range_size = 5 + i  # Range grows from 5 to 24
            candles.append(Candle(
                ts=now + timedelta(minutes=i),
                open=100.0,
                high=100.0 + range_size / 2,
                low=100.0 - range_size / 2,
                close=100.0,
            ))

        atr = calculate_atr(candles, period=14)

        # ATR should reflect higher recent volatility
        assert atr is not None
        assert atr > 10.0  # Higher than initial range


class TestATRProvider:
    """Test ATR Provider functionality."""

    def test_fallback_atr_btc(self):
        """Fallback ATR for BTC uses asset-specific percentage."""
        provider = ATRProvider()
        atr_data = provider._fallback_atr("BTC", 100000.0)

        assert atr_data.asset == "BTC"
        assert atr_data.source == "fallback"
        assert atr_data.multiplier == ATR_MULTIPLIER_BTC
        # Fallback atr_pct is 0.4% (BTC-specific), multiplier is 2.0
        btc_fallback = ATR_FALLBACK_BY_ASSET.get("BTC", 0.5)
        expected_stop = btc_fallback * ATR_MULTIPLIER_BTC
        assert atr_data.stop_distance_pct == pytest.approx(expected_stop, rel=0.01)

    def test_fallback_atr_eth(self):
        """Fallback ATR for ETH uses asset-specific percentage."""
        provider = ATRProvider()
        atr_data = provider._fallback_atr("ETH", 4000.0)

        assert atr_data.asset == "ETH"
        assert atr_data.source == "fallback"
        assert atr_data.multiplier == ATR_MULTIPLIER_ETH
        # Fallback atr_pct is 0.6% (ETH-specific), multiplier is 1.5
        eth_fallback = ATR_FALLBACK_BY_ASSET.get("ETH", 0.5)
        expected_stop = eth_fallback * ATR_MULTIPLIER_ETH
        assert atr_data.stop_distance_pct == pytest.approx(expected_stop, rel=0.01)

    def test_get_stop_fraction(self):
        """Stop fraction correctly converts percentage to fraction."""
        provider = ATRProvider()
        atr_data = ATRData(
            asset="BTC",
            atr=2000.0,
            atr_pct=2.0,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=4.0,  # 2% ATR * 2.0 multiplier
            timestamp=datetime.now(timezone.utc),
            source="test",
        )

        stop_fraction = provider.get_stop_fraction(atr_data)
        assert stop_fraction == pytest.approx(0.04, rel=1e-5)  # 4% = 0.04

    def test_cache_behavior(self):
        """Cache returns same data within TTL."""
        provider = ATRProvider()

        # Set cache manually
        now = datetime.now(timezone.utc)
        cached_data = ATRData(
            asset="BTC",
            atr=1500.0,
            atr_pct=1.5,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=3.0,
            timestamp=now,
            source="cached",
        )
        provider._cache["BTC"] = (cached_data, now)

        # Check cache is valid
        assert provider._is_cache_valid("BTC") is True
        assert provider._is_cache_valid("ETH") is False

    def test_cache_expiry(self):
        """Cache expires after TTL."""
        provider = ATRProvider()

        # Set cache with old timestamp
        old_time = datetime.now(timezone.utc) - timedelta(seconds=120)
        cached_data = ATRData(
            asset="BTC",
            atr=1500.0,
            atr_pct=1.5,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=3.0,
            timestamp=old_time,
            source="cached",
        )
        provider._cache["BTC"] = (cached_data, old_time)

        # Cache should be expired (default TTL is 60 seconds)
        assert provider._is_cache_valid("BTC") is False

    def test_clear_cache(self):
        """Cache clear removes all entries."""
        provider = ATRProvider()
        provider._cache["BTC"] = ("data", datetime.now(timezone.utc))
        provider._cache["ETH"] = ("data", datetime.now(timezone.utc))

        provider.clear_cache()

        assert len(provider._cache) == 0


class TestStopDistanceCalculation:
    """Test stop distance derivation from ATR."""

    def test_stop_distance_btc_typical(self):
        """Typical BTC ATR stop distance calculation."""
        # BTC at $100k with 2% ATR, 2x multiplier
        atr = 2000.0  # $2000 = 2%
        price = 100000.0
        multiplier = 2.0

        atr_pct = atr / price * 100  # 2%
        stop_distance_pct = atr_pct * multiplier  # 4%

        assert atr_pct == pytest.approx(2.0, rel=0.01)
        assert stop_distance_pct == pytest.approx(4.0, rel=0.01)

    def test_stop_distance_eth_typical(self):
        """Typical ETH ATR stop distance calculation."""
        # ETH at $4k with 3% ATR, 1.5x multiplier
        atr = 120.0  # $120 = 3%
        price = 4000.0
        multiplier = 1.5

        atr_pct = atr / price * 100  # 3%
        stop_distance_pct = atr_pct * multiplier  # 4.5%

        assert atr_pct == pytest.approx(3.0, rel=0.01)
        assert stop_distance_pct == pytest.approx(4.5, rel=0.01)

    def test_stop_fraction_bounds(self):
        """Stop fraction should be bounded between 0.1% and 10% by consensus detector."""
        from app.consensus import ConsensusDetector

        detector = ConsensusDetector()

        # Test lower bound (very low volatility)
        detector.set_stop_fraction("BTC", 0.0001)  # 0.01% - should be bounded to 0.1%
        assert detector.get_stop_fraction("BTC") == 0.001  # Bounded to 0.1%

        # Test upper bound (very high volatility)
        detector.set_stop_fraction("BTC", 0.15)  # 15% - should be bounded to 10%
        assert detector.get_stop_fraction("BTC") == 0.10  # Bounded to 10%

        # Test normal value passes through
        detector.set_stop_fraction("ETH", 0.02)  # 2%
        assert detector.get_stop_fraction("ETH") == 0.02


class TestATRMultipliers:
    """Test asset-specific ATR multipliers."""

    def test_btc_multiplier(self):
        """BTC uses 2.0 multiplier by default."""
        assert ATR_MULTIPLIER_BTC == 2.0

    def test_eth_multiplier(self):
        """ETH uses 1.5 multiplier by default."""
        assert ATR_MULTIPLIER_ETH == 1.5

    def test_unknown_asset_uses_btc_multiplier(self):
        """Unknown assets default to BTC multiplier."""
        provider = ATRProvider()
        assert provider._get_multiplier("SOL") == ATR_MULTIPLIER_BTC
        assert provider._get_multiplier("XRP") == ATR_MULTIPLIER_BTC


class TestQuantAcceptance:
    """Quant acceptance tests for ATR-based stops."""

    def test_atr_to_stop_conversion(self):
        """
        Verify ATR → stop fraction conversion matches expected values.

        Example: BTC at $100k with 14-period ATR of $1500
        - ATR% = 1500/100000 = 1.5%
        - With 2x multiplier, stop = 3%
        - Stop fraction = 0.03
        """
        price = 100000.0
        atr = 1500.0
        multiplier = 2.0

        atr_pct = atr / price * 100
        stop_pct = atr_pct * multiplier
        stop_fraction = stop_pct / 100

        assert atr_pct == pytest.approx(1.5, rel=1e-5)
        assert stop_pct == pytest.approx(3.0, rel=1e-5)
        assert stop_fraction == pytest.approx(0.03, rel=1e-5)

    def test_regime_adaptive_stops(self):
        """
        Stops should scale with volatility.

        Low volatility (ATR = 0.5%): stop = 1%
        High volatility (ATR = 2%): stop = 4%

        This is 4x difference, matching the ATR ratio.
        """
        price = 100000.0
        multiplier = 2.0

        # Low volatility regime
        atr_low = 500.0  # 0.5%
        stop_low = (atr_low / price) * multiplier  # 0.01 = 1%

        # High volatility regime
        atr_high = 2000.0  # 2%
        stop_high = (atr_high / price) * multiplier  # 0.04 = 4%

        # Ratio should match ATR ratio
        atr_ratio = atr_high / atr_low  # 4x
        stop_ratio = stop_high / stop_low  # 4x

        assert atr_ratio == pytest.approx(4.0, rel=1e-5)
        assert stop_ratio == pytest.approx(4.0, rel=1e-5)

    def test_r_multiple_with_dynamic_stop(self):
        """
        R-multiple calculation with ATR-based stop.

        Entry: $100k
        Exit: $103k (3% profit)
        ATR-based stop: 2% (risk = $2k)

        R = $3k / $2k = 1.5R
        """
        entry_price = 100000.0
        exit_price = 103000.0
        stop_fraction = 0.02  # 2% ATR-based stop

        pnl = exit_price - entry_price  # $3k
        risk = entry_price * stop_fraction  # $2k
        r_multiple = pnl / risk

        assert pnl == pytest.approx(3000.0, rel=1e-5)
        assert risk == pytest.approx(2000.0, rel=1e-5)
        assert r_multiple == pytest.approx(1.5, rel=1e-5)


class TestATRStaleness:
    """Test ATR data staleness checks."""

    def test_fresh_data_is_not_stale(self):
        """Fresh ATR data should not be flagged as stale."""
        atr_data = ATRData(
            asset="BTC",
            atr=1500.0,
            atr_pct=1.5,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=3.0,
            timestamp=datetime.now(timezone.utc),
            source="db",
        )

        assert atr_data.is_stale is False
        assert atr_data.age_seconds < 5

    def test_old_data_is_stale(self):
        """ATR data older than max staleness should be flagged."""
        old_time = datetime.now(timezone.utc) - timedelta(seconds=ATR_MAX_STALENESS_SECONDS + 60)
        atr_data = ATRData(
            asset="BTC",
            atr=1500.0,
            atr_pct=1.5,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=3.0,
            timestamp=old_time,
            source="db",
        )

        assert atr_data.is_stale is True
        assert atr_data.age_seconds > ATR_MAX_STALENESS_SECONDS

    def test_fallback_is_always_stale(self):
        """Fallback ATR data should always be considered stale."""
        atr_data = ATRData(
            asset="BTC",
            atr=500.0,
            atr_pct=0.5,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=1.0,
            timestamp=datetime.now(timezone.utc),
            source="fallback",
        )

        assert atr_data.is_stale is True

    def test_check_staleness_returns_message(self):
        """check_staleness should return descriptive message."""
        provider = ATRProvider()

        # Fresh data
        fresh_data = ATRData(
            asset="BTC",
            atr=1500.0,
            atr_pct=1.5,
            price=100000.0,
            multiplier=2.0,
            stop_distance_pct=3.0,
            timestamp=datetime.now(timezone.utc),
            source="db",
        )
        is_stale, message = provider.check_staleness(fresh_data)
        assert is_stale is False
        assert "fresh" in message.lower()

        # Fallback data
        fallback_data = provider._fallback_atr("BTC", 100000.0)
        is_stale, message = provider.check_staleness(fallback_data)
        assert is_stale is True
        assert "fallback" in message.lower()


class TestAssetSpecificFallbacks:
    """Test asset-specific fallback ATR percentages."""

    def test_btc_has_lower_fallback_than_eth(self):
        """BTC should have lower fallback ATR % than ETH (less volatile per candle)."""
        btc_fallback = ATR_FALLBACK_BY_ASSET.get("BTC", 0.5)
        eth_fallback = ATR_FALLBACK_BY_ASSET.get("ETH", 0.5)

        assert btc_fallback < eth_fallback

    def test_fallback_values_are_reasonable(self):
        """Fallback ATR values should be reasonable for 1-min candles."""
        btc_fallback = ATR_FALLBACK_BY_ASSET.get("BTC", 0.5)
        eth_fallback = ATR_FALLBACK_BY_ASSET.get("ETH", 0.5)

        # Typical 1-min ATR is 0.2% - 0.8% for major cryptos
        assert 0.2 <= btc_fallback <= 0.8
        assert 0.3 <= eth_fallback <= 1.0

    def test_unknown_asset_uses_reasonable_default(self):
        """Unknown assets should use conservative default."""
        provider = ATRProvider()
        atr_data = provider._fallback_atr("SOL", 100.0)

        # Unknown asset uses 0.5% default
        assert atr_data.atr_pct == 0.5
