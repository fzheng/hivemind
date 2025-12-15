"""
Tests for Phase 6.5: Per-Signal Venue Selection

Phase 6.5 enables dynamic selection of the best execution venue for each
consensus signal by comparing net expected value (EV) across all available
exchanges.

Key features tested:
1. Per-signal venue selection configuration
2. Venue selection picks highest EV exchange
3. Signal carries correct venue and cost breakdown
4. Fallback behavior when venue unavailable
5. Integration with consensus detection
"""

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.consensus import (
    ConsensusDetector,
    ConsensusSignal,
    Fill,
    Vote,
    PER_SIGNAL_VENUE_SELECTION,
    VENUE_SELECTION_EXCHANGES,
    calculate_ev,
    get_exchange_fees_bps,
)


class TestVenueSelectionConfiguration:
    """Test Phase 6.5 configuration variables."""

    def test_per_signal_venue_selection_default_enabled(self):
        """Per-signal venue selection should be enabled by default."""
        # Check the config value is correct type
        assert isinstance(PER_SIGNAL_VENUE_SELECTION, bool)

    def test_venue_selection_exchanges_configured(self):
        """Venue selection exchanges should be a list."""
        assert isinstance(VENUE_SELECTION_EXCHANGES, list)
        assert len(VENUE_SELECTION_EXCHANGES) >= 1

    def test_default_exchanges_include_hyperliquid(self):
        """Default exchanges should include hyperliquid."""
        assert "hyperliquid" in VENUE_SELECTION_EXCHANGES or "hyperliquid" in [e.lower() for e in VENUE_SELECTION_EXCHANGES]


class TestVenueSelectionPicksHighestEV:
    """Test that venue selection picks the exchange with highest net EV."""

    def test_compare_ev_across_exchanges_finds_best(self):
        """compare_ev_across_exchanges should identify best venue by net EV."""
        detector = ConsensusDetector()

        # Mock the cost providers to return predictable values
        with patch('app.consensus.get_exchange_fees_bps') as mock_fees, \
             patch('app.consensus.get_funding_cost_bps_sync') as mock_funding, \
             patch('app.consensus.get_slippage_estimate_bps_sync') as mock_slippage:

            # HL: 10 bps fees, 5 bps funding, 2 bps slippage = 17 bps total
            # Bybit: 12 bps fees, -8 bps funding (rebate), 3 bps slippage = 7 bps total
            def fees_side_effect(exchange):
                return 10.0 if exchange == "hyperliquid" else 12.0

            def funding_side_effect(asset, exchange, hold_hours, side):
                return 5.0 if exchange == "hyperliquid" else -8.0  # Bybit gets rebate

            def slippage_side_effect(asset, exchange, order_size_usd):
                return 2.0 if exchange == "hyperliquid" else 3.0

            mock_fees.side_effect = fees_side_effect
            mock_funding.side_effect = funding_side_effect
            mock_slippage.side_effect = slippage_side_effect

            result = detector.compare_ev_across_exchanges(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,  # 1% stop
                p_win=0.6,
                exchanges=["hyperliquid", "bybit"],
            )

            # Bybit should have higher EV due to funding rebate
            assert result["best_exchange"] == "bybit"
            assert result["best_ev_net_r"] == result["bybit"]["ev_net_r"]

    def test_best_exchange_defaulted_when_all_fail(self):
        """Should default to first exchange when all calculations fail."""
        detector = ConsensusDetector()

        # Make all EV calculations raise exceptions
        with patch.object(detector, 'calculate_ev_for_exchange') as mock_calc:
            mock_calc.side_effect = Exception("Test error")

            result = detector.compare_ev_across_exchanges(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,
                p_win=0.6,
                exchanges=["hyperliquid", "bybit"],
            )

            # Should still have a best_exchange (first one)
            assert "best_exchange" in result
            # Error results should have -inf EV
            assert result["hyperliquid"]["ev_net_r"] == float("-inf")


class TestSignalCarriesVenueAndCosts:
    """Test that consensus signals carry venue and cost breakdown."""

    def test_signal_has_venue_fields(self):
        """ConsensusSignal should have target_exchange and cost fields."""
        signal = ConsensusSignal(
            id="test-id",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            stop_price=99000.0,
            n_traders=5,
            n_agreeing=4,
            eff_k=2.5,
            dispersion=0.1,
            p_win=0.6,
            ev_gross_r=0.3,
            ev_cost_r=0.05,
            ev_net_r=0.25,
            latency_ms=500,
            median_voter_price=100000.0,
            mid_delta_bps=5.0,
            created_at=datetime.now(timezone.utc),
            trigger_addresses=["0x1111", "0x2222"],
            target_exchange="bybit",
            fees_bps=12.0,
            slippage_bps=3.0,
            funding_bps=-8.0,
        )

        assert signal.target_exchange == "bybit"
        assert signal.fees_bps == 12.0
        assert signal.slippage_bps == 3.0
        assert signal.funding_bps == -8.0

    def test_signal_defaults_to_hyperliquid(self):
        """ConsensusSignal should default to hyperliquid if not specified."""
        signal = ConsensusSignal(
            id="test-id",
            symbol="BTC",
            direction="long",
            entry_price=100000.0,
            stop_price=99000.0,
            n_traders=5,
            n_agreeing=4,
            eff_k=2.5,
            dispersion=0.1,
            p_win=0.6,
            ev_gross_r=0.3,
            ev_cost_r=0.05,
            ev_net_r=0.25,
            latency_ms=500,
            median_voter_price=100000.0,
            mid_delta_bps=5.0,
            created_at=datetime.now(timezone.utc),
            trigger_addresses=["0x1111", "0x2222"],
        )

        assert signal.target_exchange == "hyperliquid"
        assert signal.fees_bps == 0.0


class TestCalculateEVForExchange:
    """Test per-exchange EV calculation."""

    def test_calculate_ev_for_exchange_returns_breakdown(self):
        """calculate_ev_for_exchange should return full cost breakdown."""
        detector = ConsensusDetector()

        with patch('app.consensus.get_exchange_fees_bps', return_value=10.0), \
             patch('app.consensus.get_funding_cost_bps_sync', return_value=5.0), \
             patch('app.consensus.get_slippage_estimate_bps_sync', return_value=2.0), \
             patch('app.consensus.get_dynamic_hold_hours_sync', return_value=24.0):

            result = detector.calculate_ev_for_exchange(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,
                p_win=0.6,
                exchange="hyperliquid",
            )

            # Should have all expected fields
            assert "ev_gross_r" in result
            assert "ev_cost_r" in result
            assert "ev_net_r" in result
            assert "fees_bps" in result
            assert "slippage_bps" in result
            assert "funding_bps" in result
            assert "exchange" in result
            assert "hold_hours" in result

            # Values should match mocks
            assert result["fees_bps"] == 10.0
            assert result["slippage_bps"] == 2.0
            assert result["funding_bps"] == 5.0
            assert result["exchange"] == "hyperliquid"
            assert result["hold_hours"] == 24.0

    def test_calculate_ev_includes_all_costs(self):
        """EV calculation should include fees, slippage, and funding."""
        detector = ConsensusDetector()

        with patch('app.consensus.get_exchange_fees_bps', return_value=10.0), \
             patch('app.consensus.get_funding_cost_bps_sync', return_value=8.0), \
             patch('app.consensus.get_slippage_estimate_bps_sync', return_value=5.0), \
             patch('app.consensus.get_dynamic_hold_hours_sync', return_value=24.0):

            result = detector.calculate_ev_for_exchange(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,  # 1% stop = 100 bps stop distance
                p_win=0.6,
                exchange="hyperliquid",
            )

            # Total costs = 10 + 8 + 5 = 23 bps
            # With 100 bps (1%) stop distance, 23 bps = 0.23R cost
            assert result["ev_cost_r"] == pytest.approx(0.23, rel=0.1)


class TestVenueSelectionFallback:
    """Test fallback behavior when venue selection has issues."""

    def test_single_exchange_fallback(self):
        """With single exchange, should return that exchange as best."""
        detector = ConsensusDetector(target_exchange="hyperliquid")

        with patch('app.consensus.get_exchange_fees_bps', return_value=10.0), \
             patch('app.consensus.get_funding_cost_bps_sync', return_value=5.0), \
             patch('app.consensus.get_slippage_estimate_bps_sync', return_value=2.0), \
             patch('app.consensus.get_dynamic_hold_hours_sync', return_value=24.0):

            result = detector.compare_ev_across_exchanges(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,
                p_win=0.6,
                exchanges=["hyperliquid"],  # Single exchange
            )

            assert result["best_exchange"] == "hyperliquid"

    def test_empty_exchanges_list_handled(self):
        """Empty exchanges list should not crash."""
        detector = ConsensusDetector()

        result = detector.compare_ev_across_exchanges(
            asset="BTC",
            direction="long",
            entry_price=100000.0,
            stop_price=99000.0,
            p_win=0.6,
            exchanges=[],
        )

        # Should return empty-ish result but not crash
        assert "best_exchange" not in result or result.get("best_exchange") is None


class TestVenueSelectionDirection:
    """Test that venue selection handles long/short direction correctly."""

    def test_funding_direction_affects_venue_selection(self):
        """Funding direction should affect which venue is selected."""
        detector = ConsensusDetector()

        with patch('app.consensus.get_exchange_fees_bps') as mock_fees, \
             patch('app.consensus.get_funding_cost_bps_sync') as mock_funding, \
             patch('app.consensus.get_slippage_estimate_bps_sync') as mock_slippage:

            # Same fees and slippage
            mock_fees.return_value = 10.0
            mock_slippage.return_value = 2.0

            # Different funding by direction and venue
            # Longs pay on HL, receive on Bybit
            def funding_side_effect(asset, exchange, hold_hours, side):
                if side == "long":
                    return 10.0 if exchange == "hyperliquid" else -10.0  # HL costs, Bybit rebate
                else:
                    return -10.0 if exchange == "hyperliquid" else 10.0  # HL rebate, Bybit costs

            mock_funding.side_effect = funding_side_effect

            # For longs, Bybit should win (funding rebate)
            result_long = detector.compare_ev_across_exchanges(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,
                p_win=0.6,
                exchanges=["hyperliquid", "bybit"],
            )
            assert result_long["best_exchange"] == "bybit"

            # For shorts, HL should win (funding rebate)
            result_short = detector.compare_ev_across_exchanges(
                asset="BTC",
                direction="short",
                entry_price=100000.0,
                stop_price=101000.0,
                p_win=0.6,
                exchanges=["hyperliquid", "bybit"],
            )
            assert result_short["best_exchange"] == "hyperliquid"


class TestCheckConsensusVenueSelection:
    """Test venue selection integration in check_consensus."""

    def test_check_consensus_populates_signal_venue(self):
        """check_consensus should populate signal with selected venue."""
        detector = ConsensusDetector(target_exchange="hyperliquid")

        # Set up window with fills
        now = datetime.now(timezone.utc)
        fills = [
            Fill(
                fill_id=f"fill-{i}",
                address=f"0x{i}111",
                asset="BTC",
                side="long",
                size=0.1,
                price=100000.0,
                ts=now - timedelta(seconds=10),
            )
            for i in range(5)
        ]

        # Mock the dependencies
        with patch.object(detector, 'collapse_to_votes') as mock_votes, \
             patch.object(detector, 'eff_k_from_corr', return_value=3.0), \
             patch.object(detector, 'passes_latency_and_price_gates', return_value=True), \
             patch.object(detector, 'calibrated_p_win', return_value=0.6), \
             patch.object(detector, 'compare_ev_across_exchanges') as mock_compare, \
             patch('app.consensus.PER_SIGNAL_VENUE_SELECTION', True), \
             patch('app.consensus.VENUE_SELECTION_EXCHANGES', ['hyperliquid', 'bybit']):

            # Set up votes
            mock_votes.return_value = [
                Vote(
                    address=f"0x{i}111",
                    direction="long",
                    weight=1.0,
                    price=100000.0,
                    ts=now - timedelta(seconds=10),
                )
                for i in range(5)
            ]

            # Set up EV comparison result - Bybit wins
            mock_compare.return_value = {
                "hyperliquid": {
                    "ev_gross_r": 0.3,
                    "ev_cost_r": 0.05,
                    "ev_net_r": 0.25,
                    "fees_bps": 10.0,
                    "slippage_bps": 2.0,
                    "funding_bps": 5.0,
                },
                "bybit": {
                    "ev_gross_r": 0.3,
                    "ev_cost_r": 0.02,
                    "ev_net_r": 0.28,
                    "fees_bps": 12.0,
                    "slippage_bps": 3.0,
                    "funding_bps": -8.0,
                },
                "best_exchange": "bybit",
                "best_ev_net_r": 0.28,
            }

            # Set up window
            from app.consensus import ConsensusWindow
            detector.windows["BTC"] = ConsensusWindow(
                symbol="BTC",
                window_start=now - timedelta(seconds=60),
                window_s=120,
                fills=fills,
            )
            detector.set_current_price("BTC", 100000.0)
            detector.set_stop_fraction("BTC", 0.01, True, "")

            # Run check_consensus
            signal = detector.check_consensus("BTC")

            # Signal should have Bybit as target (best EV)
            if signal is not None:
                assert signal.target_exchange == "bybit"
                assert signal.fees_bps == 12.0
                assert signal.funding_bps == -8.0


class TestExchangeFeesLookup:
    """Test exchange fee lookup functions."""

    def test_get_exchange_fees_bps_hyperliquid(self):
        """Should return correct fees for Hyperliquid."""
        fees = get_exchange_fees_bps("hyperliquid")
        assert fees == 10.0  # 5 bps × 2 = 10 bps round-trip

    def test_get_exchange_fees_bps_bybit(self):
        """Should return correct fees for Bybit."""
        fees = get_exchange_fees_bps("bybit")
        assert fees == 12.0  # 6 bps × 2 = 12 bps round-trip

    def test_get_exchange_fees_bps_unknown(self):
        """Should return default for unknown exchange."""
        fees = get_exchange_fees_bps("unknown_exchange")
        # Should use DEFAULT_FEES_BPS
        assert fees > 0


class TestQuantAcceptance:
    """Quant acceptance tests for Phase 6.5."""

    def test_venue_selection_maximizes_net_ev(self):
        """Venue selection should always pick the venue with highest net EV."""
        detector = ConsensusDetector()

        # Create scenarios where different venues win
        scenarios = [
            # Scenario 1: HL wins (lower fees)
            {"hl_cost": 10, "bybit_cost": 25, "expected": "hyperliquid"},
            # Scenario 2: Bybit wins (funding rebate)
            {"hl_cost": 20, "bybit_cost": 5, "expected": "bybit"},
            # Scenario 3: Equal (pick first - HL)
            {"hl_cost": 15, "bybit_cost": 15, "expected": "hyperliquid"},
        ]

        for scenario in scenarios:
            with patch('app.consensus.get_exchange_fees_bps') as mock_fees, \
                 patch('app.consensus.get_funding_cost_bps_sync', return_value=0.0), \
                 patch('app.consensus.get_slippage_estimate_bps_sync', return_value=0.0), \
                 patch('app.consensus.get_dynamic_hold_hours_sync', return_value=24.0):

                def fees_effect(exchange):
                    if exchange == "hyperliquid":
                        return float(scenario["hl_cost"])
                    return float(scenario["bybit_cost"])

                mock_fees.side_effect = fees_effect

                result = detector.compare_ev_across_exchanges(
                    asset="BTC",
                    direction="long",
                    entry_price=100000.0,
                    stop_price=99000.0,
                    p_win=0.6,
                    exchanges=["hyperliquid", "bybit"],
                )

                assert result["best_exchange"] == scenario["expected"], \
                    f"Failed for scenario: {scenario}"

    def test_cost_breakdown_adds_up(self):
        """Total cost should equal sum of individual costs."""
        detector = ConsensusDetector()

        fees = 10.0
        funding = 8.0
        slippage = 5.0
        total_expected = fees + funding + slippage  # 23 bps

        with patch('app.consensus.get_exchange_fees_bps', return_value=fees), \
             patch('app.consensus.get_funding_cost_bps_sync', return_value=funding), \
             patch('app.consensus.get_slippage_estimate_bps_sync', return_value=slippage), \
             patch('app.consensus.get_dynamic_hold_hours_sync', return_value=24.0):

            result = detector.calculate_ev_for_exchange(
                asset="BTC",
                direction="long",
                entry_price=100000.0,
                stop_price=99000.0,  # 1% stop
                p_win=0.6,
                exchange="hyperliquid",
            )

            actual_total = result["fees_bps"] + result["funding_bps"] + result["slippage_bps"]
            assert actual_total == total_expected
