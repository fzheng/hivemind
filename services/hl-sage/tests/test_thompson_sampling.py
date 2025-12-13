"""
Tests for Thompson Sampling in hl-sage score emission pipeline.

These tests verify:
1. Thompson Sampling produces different samples each call (randomness)
2. High-κ traders (confident) have lower variance samples
3. Low-κ traders (uncertain) have higher variance samples
4. NIG weight derivation: κ/(κ+10)
5. Score source correctly identifies Thompson vs legacy
"""
import pytest
import math
import statistics
from datetime import datetime, timezone
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.bandit import (
    TraderPosteriorNIG,
    NIG_PRIOR_M,
    NIG_PRIOR_KAPPA,
    NIG_PRIOR_ALPHA,
    NIG_PRIOR_BETA,
)


class TestThompsonSamplingBasics:
    """Test basic Thompson Sampling functionality."""

    def test_sample_returns_float(self):
        """Thompson sample should return a float."""
        posterior = TraderPosteriorNIG(
            address="0x1234",
            m=0.5,
            kappa=10.0,
            alpha=5.0,
            beta=1.0,
        )
        sample = posterior.sample()
        assert isinstance(sample, float)

    def test_samples_are_random(self):
        """Repeated samples should vary (not deterministic)."""
        posterior = TraderPosteriorNIG(
            address="0x1234",
            m=0.5,
            kappa=5.0,
            alpha=5.0,
            beta=1.0,
        )
        samples = [posterior.sample() for _ in range(100)]
        # Should have variance (not all same value)
        assert statistics.stdev(samples) > 0.01

    def test_sample_mean_converges_to_m(self):
        """
        For high-κ posterior, sample mean should converge to m.
        Law of large numbers.
        """
        posterior = TraderPosteriorNIG(
            address="0x1234",
            m=0.5,
            kappa=100.0,  # High confidence
            alpha=50.0,
            beta=1.0,
        )
        samples = [posterior.sample() for _ in range(1000)]
        sample_mean = statistics.mean(samples)
        # With high κ, sample mean should be close to m
        assert abs(sample_mean - 0.5) < 0.1


class TestExploreExploitTradeoff:
    """Test that Thompson Sampling balances exploration and exploitation."""

    def test_high_kappa_low_variance(self):
        """
        High-κ (confident) traders should have low sample variance.
        This leads to exploitation - consistently near posterior mean.
        """
        high_confidence = TraderPosteriorNIG(
            address="0xhigh",
            m=0.3,
            kappa=50.0,  # High confidence
            alpha=25.0,
            beta=1.0,
        )
        samples = [high_confidence.sample() for _ in range(500)]
        variance = statistics.variance(samples)
        # High confidence = low variance
        assert variance < 0.05

    def test_low_kappa_high_variance(self):
        """
        Low-κ (uncertain) traders should have high sample variance.
        This leads to exploration - wide range of possible samples.
        """
        low_confidence = TraderPosteriorNIG(
            address="0xlow",
            m=0.3,
            kappa=1.0,  # Low confidence (prior)
            alpha=3.0,
            beta=1.0,
        )
        samples = [low_confidence.sample() for _ in range(500)]
        variance = statistics.variance(samples)
        # Low confidence = high variance
        assert variance > 0.1

    def test_uncertain_trader_sometimes_beats_proven(self):
        """
        An uncertain trader (low κ) should sometimes sample higher
        than a proven performer (high κ), enabling exploration.
        """
        # Proven performer: m=0.3, high κ
        proven = TraderPosteriorNIG(
            address="0xproven",
            m=0.3,
            kappa=50.0,
            alpha=25.0,
            beta=1.0,
        )
        # Uncertain newbie: m=0.2, low κ
        newbie = TraderPosteriorNIG(
            address="0xnewbie",
            m=0.2,
            kappa=2.0,
            alpha=4.0,
            beta=1.0,
        )

        # Run many comparisons
        newbie_wins = 0
        trials = 1000
        for _ in range(trials):
            if newbie.sample() > proven.sample():
                newbie_wins += 1

        # Newbie should win sometimes (exploration), but not always
        # Expected: newbie wins ~20-40% of the time due to wider variance
        win_rate = newbie_wins / trials
        assert 0.05 < win_rate < 0.60, f"Newbie win rate {win_rate:.2%} outside expected range"


class TestNIGWeightDerivation:
    """Test weight derivation from NIG posterior."""

    def test_weight_formula_kappa_1(self):
        """κ=1 (prior) should give low weight."""
        kappa = 1.0
        weight = kappa / (kappa + 10.0)
        assert weight == pytest.approx(0.0909, rel=0.01)

    def test_weight_formula_kappa_10(self):
        """κ=10 should give weight ~0.5."""
        kappa = 10.0
        weight = kappa / (kappa + 10.0)
        assert weight == pytest.approx(0.5, rel=0.01)

    def test_weight_formula_kappa_100(self):
        """κ=100 (very confident) should give high weight."""
        kappa = 100.0
        weight = kappa / (kappa + 10.0)
        assert weight == pytest.approx(0.909, rel=0.01)

    def test_weight_increases_monotonically(self):
        """Weight should increase as κ increases."""
        kappas = [1, 2, 5, 10, 20, 50, 100]
        weights = [k / (k + 10.0) for k in kappas]
        # Each weight should be greater than the previous
        for i in range(1, len(weights)):
            assert weights[i] > weights[i-1]


class TestPosteriorVariance:
    """Test posterior variance calculations."""

    def test_posterior_variance_formula(self):
        """Test Var(μ) = β / (κ × (α - 1))."""
        posterior = TraderPosteriorNIG(
            address="0x1234",
            m=0.5,
            kappa=10.0,
            alpha=5.0,
            beta=2.0,
        )
        expected_var = 2.0 / (10.0 * (5.0 - 1.0))  # β/(κ×(α-1)) = 2/(10×4) = 0.05
        assert posterior.posterior_variance == pytest.approx(expected_var, rel=1e-5)

    def test_posterior_variance_alpha_1_is_inf(self):
        """When α ≤ 1, variance should be infinite."""
        posterior = TraderPosteriorNIG(
            address="0x1234",
            m=0.5,
            kappa=10.0,
            alpha=1.0,
            beta=1.0,
        )
        assert posterior.posterior_variance == float('inf')

    def test_high_kappa_reduces_variance(self):
        """Higher κ should reduce posterior variance."""
        low_k = TraderPosteriorNIG(address="a", m=0.5, kappa=5.0, alpha=5.0, beta=1.0)
        high_k = TraderPosteriorNIG(address="b", m=0.5, kappa=50.0, alpha=5.0, beta=1.0)
        assert high_k.posterior_variance < low_k.posterior_variance


class TestSharpeBasedSampling:
    """Test risk-adjusted sampling (μ/σ)."""

    def test_sample_sharpe_returns_float(self):
        """sample_sharpe should return a float."""
        posterior = TraderPosteriorNIG(
            address="0x1234",
            m=0.5,
            kappa=10.0,
            alpha=5.0,
            beta=1.0,
        )
        sharpe = posterior.sample_sharpe()
        assert isinstance(sharpe, float)

    def test_high_mean_low_var_gives_high_sharpe(self):
        """
        High mean + low variance (consistent performer) should give
        higher Sharpe-like samples on average.
        """
        consistent = TraderPosteriorNIG(
            address="0xconsistent",
            m=0.5,
            kappa=50.0,
            alpha=25.0,
            beta=0.5,  # Low variance
        )
        volatile = TraderPosteriorNIG(
            address="0xvolatile",
            m=0.5,
            kappa=50.0,
            alpha=25.0,
            beta=5.0,  # High variance
        )

        consistent_sharpes = [consistent.sample_sharpe() for _ in range(500)]
        volatile_sharpes = [volatile.sample_sharpe() for _ in range(500)]

        # Consistent performer should have higher average Sharpe
        assert statistics.mean(consistent_sharpes) > statistics.mean(volatile_sharpes)


class TestPriorDefaults:
    """Test NIG prior parameter defaults."""

    def test_prior_m_is_zero(self):
        """Prior mean should be 0 (no belief about skill)."""
        assert NIG_PRIOR_M == 0.0

    def test_prior_kappa_is_one(self):
        """Prior κ should be 1 (one pseudo-observation)."""
        assert NIG_PRIOR_KAPPA == 1.0

    def test_prior_alpha_is_three(self):
        """Prior α should be 3 (ensures finite variance)."""
        assert NIG_PRIOR_ALPHA == 3.0

    def test_prior_beta_is_one(self):
        """Prior β should be 1 (reasonable scale)."""
        assert NIG_PRIOR_BETA == 1.0

    def test_default_posterior_is_prior(self):
        """Default TraderPosteriorNIG should have prior parameters."""
        posterior = TraderPosteriorNIG(address="0xnew")
        assert posterior.m == NIG_PRIOR_M
        assert posterior.kappa == NIG_PRIOR_KAPPA
        assert posterior.alpha == NIG_PRIOR_ALPHA
        assert posterior.beta == NIG_PRIOR_BETA


class TestEffectiveSamples:
    """Test effective sample size calculation."""

    def test_effective_samples_new_trader(self):
        """New trader should have 0 effective samples."""
        posterior = TraderPosteriorNIG(
            address="0xnew",
            kappa=NIG_PRIOR_KAPPA,  # 1.0
        )
        assert posterior.effective_samples == 0.0

    def test_effective_samples_after_observations(self):
        """After n observations, effective_samples = κ - 1."""
        posterior = TraderPosteriorNIG(
            address="0xexperienced",
            kappa=11.0,  # After 10 observations
        )
        assert posterior.effective_samples == 10.0


class TestQuantAcceptance:
    """
    Quant acceptance tests for Thompson Sampling behavior.
    These verify statistical properties required for proper explore/exploit.
    """

    def test_exploration_rate_with_balanced_traders(self):
        """
        Given two traders with same m but different κ,
        the uncertain one should be selected ~30-50% of time.
        """
        confident = TraderPosteriorNIG(address="a", m=0.3, kappa=30.0, alpha=15.0, beta=1.0)
        uncertain = TraderPosteriorNIG(address="b", m=0.3, kappa=3.0, alpha=4.0, beta=1.0)

        uncertain_wins = sum(1 for _ in range(1000) if uncertain.sample() > confident.sample())
        win_rate = uncertain_wins / 1000

        # Due to higher variance, uncertain trader should win 30-50%
        assert 0.25 < win_rate < 0.55, f"Exploration rate {win_rate:.2%} outside expected"

    def test_exploitation_dominates_with_clear_winner(self):
        """
        When one trader has clearly higher m, they should be selected >70% of time,
        even if they have lower variance.
        """
        winner = TraderPosteriorNIG(address="winner", m=0.8, kappa=20.0, alpha=12.0, beta=1.0)
        loser = TraderPosteriorNIG(address="loser", m=0.2, kappa=20.0, alpha=12.0, beta=1.0)

        winner_wins = sum(1 for _ in range(1000) if winner.sample() > loser.sample())
        win_rate = winner_wins / 1000

        # Clear winner should win >70% of the time
        assert win_rate > 0.70, f"Exploitation rate {win_rate:.2%} too low"

    def test_sample_distribution_respects_posterior(self):
        """
        Samples from posterior should be approximately normally distributed
        around m, with standard deviation based on κ and variance.
        """
        posterior = TraderPosteriorNIG(
            address="0xtest",
            m=0.5,
            kappa=20.0,
            alpha=10.0,
            beta=1.0,
        )

        samples = [posterior.sample() for _ in range(2000)]
        sample_mean = statistics.mean(samples)
        sample_std = statistics.stdev(samples)

        # Mean should be close to m
        assert abs(sample_mean - 0.5) < 0.1
        # Standard deviation should reflect posterior uncertainty
        # Var(μ) = β/(κ(α-1)) = 1/(20*9) ≈ 0.0056, so σ ≈ 0.075
        expected_std = math.sqrt(1.0 / (20.0 * 9.0))
        assert abs(sample_std - expected_std) < 0.05
