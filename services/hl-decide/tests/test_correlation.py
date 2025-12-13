"""
Tests for Trader Correlation Calculator.

These tests verify:
1. Bucket ID calculation from timestamps
2. Sign vector building
3. Phi correlation computation
4. Edge cases (insufficient data, perfect correlation)
5. Correlation provider functionality
"""
import pytest
from datetime import datetime, timezone, timedelta, date
from unittest.mock import AsyncMock, MagicMock
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.correlation import (
    bucket_id_from_timestamp,
    timestamp_from_bucket_id,
    compute_phi_correlation,
    TraderSignVector,
    CorrelationProvider,
    CORR_BUCKET_MINUTES,
    CORR_MIN_COMMON_BUCKETS,
    CORR_MAX_STALENESS_DAYS,
    CORR_DECAY_HALFLIFE_DAYS,
    DEFAULT_CORRELATION,
)


class TestBucketIdCalculation:
    """Test bucket ID calculation from timestamps."""

    def test_same_bucket_within_5_minutes(self):
        """Two timestamps within 5 minutes should have same bucket ID."""
        t1 = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        t2 = datetime(2024, 1, 1, 12, 4, 59, tzinfo=timezone.utc)

        assert bucket_id_from_timestamp(t1) == bucket_id_from_timestamp(t2)

    def test_different_bucket_after_5_minutes(self):
        """Two timestamps 5+ minutes apart should have different bucket IDs."""
        t1 = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        t2 = datetime(2024, 1, 1, 12, 5, 0, tzinfo=timezone.utc)

        assert bucket_id_from_timestamp(t1) != bucket_id_from_timestamp(t2)
        assert bucket_id_from_timestamp(t2) == bucket_id_from_timestamp(t1) + 1

    def test_bucket_id_increases_with_time(self):
        """Bucket IDs should increase monotonically with time."""
        t1 = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        t2 = datetime(2024, 1, 1, 12, 10, 0, tzinfo=timezone.utc)
        t3 = datetime(2024, 1, 1, 12, 20, 0, tzinfo=timezone.utc)

        b1 = bucket_id_from_timestamp(t1)
        b2 = bucket_id_from_timestamp(t2)
        b3 = bucket_id_from_timestamp(t3)

        assert b1 < b2 < b3

    def test_roundtrip_conversion(self):
        """Converting bucket ID back to timestamp should give bucket start."""
        original = datetime(2024, 1, 1, 12, 7, 30, tzinfo=timezone.utc)
        bucket_id = bucket_id_from_timestamp(original)
        recovered = timestamp_from_bucket_id(bucket_id)

        # Recovered should be at bucket start (12:05:00)
        assert recovered.minute == 5
        assert recovered.second == 0


class TestPhiCorrelation:
    """Test phi correlation calculation."""

    def test_perfect_correlation(self):
        """Two identical sign vectors should have correlation 1.0."""
        signs_a = {1: 1, 2: 1, 3: -1, 4: -1, 5: 1, 6: 1, 7: -1, 8: -1, 9: 1, 10: 1}
        signs_b = {1: 1, 2: 1, 3: -1, 4: -1, 5: 1, 6: 1, 7: -1, 8: -1, 9: 1, 10: 1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        assert rho == 1.0
        assert n_common == 10

    def test_perfect_anti_correlation_clips_to_zero(self):
        """Opposite sign vectors should clip to 0.0 (we don't use negative)."""
        signs_a = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1}
        signs_b = {1: -1, 2: -1, 3: -1, 4: -1, 5: -1, 6: -1, 7: -1, 8: -1, 9: -1, 10: -1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        assert rho == 0.0  # Clipped from -1.0
        assert n_common == 10

    def test_no_correlation(self):
        """Half matching, half opposite should give ~0.0."""
        signs_a = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: -1, 7: -1, 8: -1, 9: -1, 10: -1}
        signs_b = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        # 5 concordant, 5 discordant -> (5-5)/10 = 0
        assert rho == 0.0
        assert n_common == 10

    def test_insufficient_data_returns_zero(self):
        """Less than min common buckets should return 0.0."""
        signs_a = {1: 1, 2: 1}
        signs_b = {1: 1, 2: 1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        assert rho == 0.0  # Insufficient data
        assert n_common < CORR_MIN_COMMON_BUCKETS

    def test_non_overlapping_buckets_return_zero(self):
        """Non-overlapping bucket IDs should return 0.0."""
        signs_a = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1}
        signs_b = {10: 1, 11: 1, 12: 1, 13: 1, 14: 1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        assert rho == 0.0
        assert n_common == 0

    def test_zero_signs_ignored(self):
        """Buckets with sign=0 should be ignored in correlation."""
        # 10 common buckets, but some are 0
        signs_a = {1: 1, 2: 0, 3: 1, 4: 0, 5: 1, 6: 0, 7: 1, 8: 0, 9: 1, 10: 0,
                   11: 1, 12: 1, 13: 1, 14: 1, 15: 1}
        signs_b = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1,
                   11: 1, 12: 1, 13: 1, 14: 1, 15: 1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        # Non-zero common: 1, 3, 5, 7, 9, 11, 12, 13, 14, 15 = 10 buckets
        assert n_common == 10
        assert rho == 1.0  # All concordant

    def test_partial_correlation(self):
        """70% match should give rho ~0.4."""
        # 7 concordant, 3 discordant -> (7-3)/10 = 0.4
        signs_a = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: -1, 9: -1, 10: -1}
        signs_b = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1}

        rho, n_common = compute_phi_correlation(signs_a, signs_b)

        assert rho == pytest.approx(0.4, rel=0.01)
        assert n_common == 10


class TestTraderSignVector:
    """Test TraderSignVector dataclass."""

    def test_bucket_ids_property(self):
        """bucket_ids should return set of all bucket IDs."""
        vector = TraderSignVector(
            address="0x1234",
            asset="BTC",
            signs={100: 1, 200: -1, 300: 1},
        )

        assert vector.bucket_ids == {100, 200, 300}

    def test_empty_signs(self):
        """Empty signs should give empty bucket_ids."""
        vector = TraderSignVector(
            address="0x1234",
            asset="BTC",
            signs={},
        )

        assert vector.bucket_ids == set()


class TestCorrelationProvider:
    """Test CorrelationProvider functionality."""

    def test_get_returns_none_when_not_loaded(self):
        """get() should return None for unknown pairs."""
        provider = CorrelationProvider()

        assert provider.get("0x1111", "0x2222") is None

    def test_get_after_manual_set(self):
        """get() should return value after manual set."""
        provider = CorrelationProvider()
        provider.correlations[("0x1111", "0x2222")] = 0.5

        assert provider.get("0x1111", "0x2222") == 0.5
        # Should also work with reversed order
        assert provider.get("0x2222", "0x1111") == 0.5

    def test_get_normalizes_addresses(self):
        """get() should normalize addresses to lowercase."""
        provider = CorrelationProvider()
        provider.correlations[("0x1111", "0x2222")] = 0.5

        assert provider.get("0X1111", "0X2222") == 0.5


class TestEffKWithCorrelation:
    """Test effective-K calculation with real correlations."""

    def test_eff_k_independent_traders(self):
        """Independent traders (rho=0) should have effK = n."""
        from app.consensus import ConsensusDetector

        detector = ConsensusDetector()

        # Set correlations to 0 (independent)
        detector.update_correlation("0x1111", "0x2222", 0.0)
        detector.update_correlation("0x1111", "0x3333", 0.0)
        detector.update_correlation("0x2222", "0x3333", 0.0)

        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k = detector.eff_k_from_corr(weights)

        # With rho=0, effK = sum(w)² / sum(w²) = 9/3 = 3
        assert eff_k == pytest.approx(3.0, rel=0.01)

    def test_eff_k_perfectly_correlated_traders(self):
        """Perfectly correlated traders (rho=1) should have effK = 1."""
        from app.consensus import ConsensusDetector

        detector = ConsensusDetector()

        # Set correlations to 1 (perfect correlation)
        detector.update_correlation("0x1111", "0x2222", 1.0)
        detector.update_correlation("0x1111", "0x3333", 1.0)
        detector.update_correlation("0x2222", "0x3333", 1.0)

        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k = detector.eff_k_from_corr(weights)

        # With rho=1, effK = sum(w)² / sum(w_i * w_j) = 9/9 = 1
        assert eff_k == pytest.approx(1.0, rel=0.01)

    def test_eff_k_partial_correlation(self):
        """Partial correlation (rho=0.5) should give 1 < effK < n."""
        from app.consensus import ConsensusDetector

        detector = ConsensusDetector()

        # Set correlations to 0.5
        detector.update_correlation("0x1111", "0x2222", 0.5)
        detector.update_correlation("0x1111", "0x3333", 0.5)
        detector.update_correlation("0x2222", "0x3333", 0.5)

        weights = {
            "0x1111": 1.0,
            "0x2222": 1.0,
            "0x3333": 1.0,
        }

        eff_k = detector.eff_k_from_corr(weights)

        # With rho=0.5, effK should be between 1 and 3
        # Exact: 9 / (3 + 6*0.5) = 9/6 = 1.5
        assert 1.0 < eff_k < 3.0
        assert eff_k == pytest.approx(1.5, rel=0.01)


class TestQuantAcceptance:
    """Quant acceptance tests for correlation calculation."""

    def test_correlation_symmetry(self):
        """rho(A,B) should equal rho(B,A)."""
        signs_a = {i: 1 if i % 2 == 0 else -1 for i in range(20)}
        signs_b = {i: 1 if i % 3 == 0 else -1 for i in range(20)}

        rho_ab, n_ab = compute_phi_correlation(signs_a, signs_b)
        rho_ba, n_ba = compute_phi_correlation(signs_b, signs_a)

        assert rho_ab == rho_ba
        assert n_ab == n_ba

    def test_correlation_bounds(self):
        """Correlation should always be in [0, 1] (we clip negative)."""
        import random
        random.seed(42)

        for _ in range(100):
            # Generate random sign vectors
            signs_a = {i: random.choice([-1, 1]) for i in range(30)}
            signs_b = {i: random.choice([-1, 1]) for i in range(30)}

            rho, n_common = compute_phi_correlation(signs_a, signs_b)

            assert 0.0 <= rho <= 1.0, f"rho={rho} out of bounds"

    def test_eff_k_with_weighted_traders(self):
        """EffK should handle different weights correctly."""
        from app.consensus import ConsensusDetector

        detector = ConsensusDetector()

        # Two independent traders with different weights
        detector.update_correlation("0x1111", "0x2222", 0.0)

        weights = {
            "0x1111": 0.8,  # Higher weight
            "0x2222": 0.2,  # Lower weight
        }

        eff_k = detector.eff_k_from_corr(weights)

        # sum(w) = 1.0, sum(w²) = 0.64 + 0.04 = 0.68
        # With rho=0: effK = 1² / 0.68 ≈ 1.47
        assert eff_k == pytest.approx(1.47, rel=0.05)

    def test_correlation_clipping_preserves_independence(self):
        """Negative correlation should be treated as independent (rho=0)."""
        # Perfect anti-correlation
        signs_a = {i: 1 for i in range(15)}
        signs_b = {i: -1 for i in range(15)}

        rho, _ = compute_phi_correlation(signs_a, signs_b)

        # Should be clipped to 0, not -1
        assert rho == 0.0

        # This means anti-correlated traders count as independent
        # for effective-K calculation, which is the desired behavior


class TestCorrelationStaleness:
    """Test correlation data staleness and decay."""

    def test_no_data_is_stale(self):
        """Provider with no data should be considered stale."""
        provider = CorrelationProvider()

        assert provider.is_stale is True
        assert provider._loaded_date is None

    def test_fresh_data_is_not_stale(self):
        """Recently loaded data should not be stale."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()
        provider.correlations = {("0x1111", "0x2222"): 0.5}

        assert provider.is_stale is False
        assert provider.age_days == 0

    def test_old_data_is_stale(self):
        """Data older than max staleness should be stale."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=CORR_MAX_STALENESS_DAYS + 1)
        provider.correlations = {("0x1111", "0x2222"): 0.5}

        assert provider.is_stale is True
        assert provider.age_days > CORR_MAX_STALENESS_DAYS


class TestCorrelationDecay:
    """Test time-based correlation decay."""

    def test_no_decay_for_fresh_data(self):
        """Fresh data should have decay factor of 1.0."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()

        decay = provider._decay_factor()
        assert decay == pytest.approx(1.0, rel=1e-5)

    def test_half_decay_at_halflife(self):
        """Decay should be 0.5 at half-life."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=CORR_DECAY_HALFLIFE_DAYS)

        decay = provider._decay_factor()
        assert decay == pytest.approx(0.5, rel=0.05)

    def test_quarter_decay_at_two_halflives(self):
        """Decay should be 0.25 at 2x half-life."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=2 * CORR_DECAY_HALFLIFE_DAYS)

        decay = provider._decay_factor()
        assert decay == pytest.approx(0.25, rel=0.05)

    def test_zero_decay_with_no_data(self):
        """No loaded data should have decay factor of 0."""
        provider = CorrelationProvider()
        provider._loaded_date = None

        decay = provider._decay_factor()
        assert decay == 0.0


class TestGetWithDecay:
    """Test get_with_decay method."""

    def test_returns_raw_for_fresh_data(self):
        """Fresh data should return raw correlation."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()
        provider.correlations = {("0x1111", "0x2222"): 0.8}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False)
        assert rho == pytest.approx(0.8, rel=1e-5)

    def test_returns_default_for_missing_pair(self):
        """Missing pair should return default correlation."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()
        provider.correlations = {}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False)
        assert rho == DEFAULT_CORRELATION

    def test_blends_toward_default_with_age(self):
        """Old data should blend toward default."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=CORR_DECAY_HALFLIFE_DAYS)
        provider.correlations = {("0x1111", "0x2222"): 0.9}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False)

        # At half-life: decayed = 0.9 * 0.5 + 0.3 * 0.5 = 0.6
        expected = 0.9 * 0.5 + DEFAULT_CORRELATION * 0.5
        assert rho == pytest.approx(expected, rel=0.05)

    def test_converges_to_default_with_very_old_data(self):
        """Very old data should converge to default."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=30)  # Very old
        provider.correlations = {("0x1111", "0x2222"): 0.9}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False)

        # Should be close to default
        assert abs(rho - DEFAULT_CORRELATION) < 0.1


class TestCheckFreshness:
    """Test check_freshness method."""

    def test_no_data_returns_not_fresh(self):
        """No loaded data should not be fresh."""
        provider = CorrelationProvider()

        is_fresh, message = provider.check_freshness()
        assert is_fresh is False
        assert "no" in message.lower()

    def test_fresh_data_returns_fresh(self):
        """Fresh data should be fresh."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()

        is_fresh, message = provider.check_freshness()
        assert is_fresh is True
        assert "fresh" in message.lower()

    def test_stale_data_returns_not_fresh(self):
        """Stale data should not be fresh."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=CORR_MAX_STALENESS_DAYS + 1)

        is_fresh, message = provider.check_freshness()
        assert is_fresh is False
        assert "stale" in message.lower()


class TestDecayQuantAcceptance:
    """Quant acceptance tests for correlation decay."""

    def test_decay_preserves_order(self):
        """Higher correlations should stay higher after decay."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=2)
        provider.correlations = {
            ("0x1111", "0x2222"): 0.8,
            ("0x1111", "0x3333"): 0.4,
        }

        rho_high = provider.get_with_decay("0x1111", "0x2222", log_default=False)
        rho_low = provider.get_with_decay("0x1111", "0x3333", log_default=False)

        assert rho_high > rho_low

    def test_decay_bounds(self):
        """Decayed correlation should stay in [0, 1]."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today() - timedelta(days=5)
        provider.correlations = {("0x1111", "0x2222"): 1.0}

        rho = provider.get_with_decay("0x1111", "0x2222", log_default=False)

        assert 0 <= rho <= 1

    def test_default_used_count_tracked(self):
        """Provider should track how many times default was used."""
        provider = CorrelationProvider()
        provider._loaded_date = date.today()
        provider.correlations = {}
        provider._default_used_count = 0

        # Get multiple missing pairs
        provider.get_with_decay("0x1111", "0x2222", log_default=False)
        provider.get_with_decay("0x3333", "0x4444", log_default=False)

        assert provider._default_used_count == 2
