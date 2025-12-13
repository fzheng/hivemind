"""
Tests for the Python episode builder module.

Tests cover:
- VWAP calculation
- Episode lifecycle (open, add, close)
- Direction flip handling
- R-multiple calculation with winsorization
- Stop price calculation
"""
import pytest
from datetime import datetime, timezone, timedelta
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.episode import (
    EpisodeFill,
    Episode,
    EpisodeTracker,
    EpisodeBuilderConfig,
    EpisodeVoteGenerator,
    calculate_vwap,
    calculate_stop_price,
    calculate_stop_bps,
    calculate_r,
)


class TestVwapCalculation:
    """Test VWAP calculation."""

    def test_single_fill_vwap(self):
        """Single fill VWAP equals fill price."""
        fills = [
            EpisodeFill(
                fill_id="f1",
                address="0x123",
                asset="BTC",
                side="buy",
                size=1.0,
                price=50000.0,
                ts=datetime.now(timezone.utc),
            )
        ]
        assert calculate_vwap(fills) == 50000.0

    def test_equal_size_vwap(self):
        """Equal size fills → simple average."""
        fills = [
            EpisodeFill(
                fill_id="f1",
                address="0x123",
                asset="BTC",
                side="buy",
                size=1.0,
                price=50000.0,
                ts=datetime.now(timezone.utc),
            ),
            EpisodeFill(
                fill_id="f2",
                address="0x123",
                asset="BTC",
                side="buy",
                size=1.0,
                price=52000.0,
                ts=datetime.now(timezone.utc),
            ),
        ]
        # (50000 + 52000) / 2 = 51000
        assert calculate_vwap(fills) == 51000.0

    def test_weighted_vwap(self):
        """Different size fills → weighted average."""
        fills = [
            EpisodeFill(
                fill_id="f1",
                address="0x123",
                asset="BTC",
                side="buy",
                size=2.0,
                price=50000.0,
                ts=datetime.now(timezone.utc),
            ),
            EpisodeFill(
                fill_id="f2",
                address="0x123",
                asset="BTC",
                side="buy",
                size=1.0,
                price=53000.0,
                ts=datetime.now(timezone.utc),
            ),
        ]
        # (2*50000 + 1*53000) / 3 = 153000 / 3 = 51000
        assert calculate_vwap(fills) == 51000.0

    def test_empty_fills_vwap(self):
        """Empty fills returns 0."""
        assert calculate_vwap([]) == 0.0


class TestStopCalculation:
    """Test stop price calculation."""

    def test_long_stop_price(self):
        """Long stop is below entry."""
        stop = calculate_stop_price(50000.0, 'long', 0.01)
        # 50000 * (1 - 0.01) = 49500
        assert stop == 49500.0

    def test_short_stop_price(self):
        """Short stop is above entry."""
        stop = calculate_stop_price(50000.0, 'short', 0.01)
        # 50000 * (1 + 0.01) = 50500
        assert stop == 50500.0

    def test_stop_bps_calculation(self):
        """Stop distance in basis points."""
        # 1% stop = 100 bps
        bps = calculate_stop_bps(50000.0, 49500.0)
        assert bps == pytest.approx(100.0, rel=1e-5)


class TestRMultipleCalculation:
    """Test R-multiple calculation with winsorization."""

    def test_positive_r(self):
        """Positive P&L gives positive R."""
        # $500 profit on $500 risk = +1R
        clamped, unclamped = calculate_r(500.0, 500.0)
        assert clamped == 1.0
        assert unclamped == 1.0

    def test_negative_r(self):
        """Negative P&L gives negative R."""
        # -$250 on $500 risk = -0.5R
        clamped, unclamped = calculate_r(-250.0, 500.0)
        assert clamped == -0.5
        assert unclamped == -0.5

    def test_r_winsorization_upper(self):
        """R clamped to +2.0 max."""
        # $2000 profit on $500 risk = +4R → clamped to +2R
        clamped, unclamped = calculate_r(2000.0, 500.0)
        assert clamped == 2.0
        assert unclamped == 4.0

    def test_r_winsorization_lower(self):
        """R clamped to -2.0 min."""
        # -$1500 on $500 risk = -3R → clamped to -2R
        clamped, unclamped = calculate_r(-1500.0, 500.0)
        assert clamped == -2.0
        assert unclamped == -3.0

    def test_zero_risk_returns_zero(self):
        """Zero risk amount returns 0."""
        clamped, unclamped = calculate_r(1000.0, 0.0)
        assert clamped == 0.0
        assert unclamped == 0.0


class TestEpisodeTracker:
    """Test the episode tracker state machine."""

    def create_fill(self, fill_id, side, size, price, ts=None, address="0x123", asset="BTC"):
        """Helper to create test fills."""
        return EpisodeFill(
            fill_id=fill_id,
            address=address,
            asset=asset,
            side=side,
            size=size,
            price=price,
            ts=ts or datetime.now(timezone.utc),
        )

    def test_open_long_position(self):
        """Buy fill opens long episode."""
        tracker = EpisodeTracker()
        fill = self.create_fill("f1", "buy", 1.0, 50000.0)

        result = tracker.process_fill(fill)

        assert result is None  # No closed episode
        assert tracker.has_open_position("0x123", "BTC")

        episode = tracker.get_open_episode("0x123", "BTC")
        assert episode.direction == "long"
        assert episode.entry_size == 1.0
        assert episode.entry_vwap == 50000.0
        assert episode.status == "open"

    def test_open_short_position(self):
        """Sell fill opens short episode."""
        tracker = EpisodeTracker()
        fill = self.create_fill("f1", "sell", 1.0, 50000.0)

        result = tracker.process_fill(fill)

        assert result is None
        episode = tracker.get_open_episode("0x123", "BTC")
        assert episode.direction == "short"
        assert episode.entry_size == 1.0

    def test_add_to_long_position(self):
        """Buying more increases position and updates VWAP."""
        tracker = EpisodeTracker()
        ts = datetime.now(timezone.utc)

        # Open with 1 BTC @ 50000
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0, ts))

        # Add 1 BTC @ 52000
        tracker.process_fill(self.create_fill("f2", "buy", 1.0, 52000.0, ts + timedelta(seconds=1)))

        episode = tracker.get_open_episode("0x123", "BTC")
        assert episode.entry_size == 2.0
        assert episode.entry_vwap == 51000.0  # VWAP of two equal fills
        assert len(episode.entry_fills) == 2

    def test_close_long_position(self):
        """Selling all closes long episode and calculates R."""
        config = EpisodeBuilderConfig(default_stop_fraction=0.01)
        tracker = EpisodeTracker(config)
        ts = datetime.now(timezone.utc)

        # Open long: 1 BTC @ 50000
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0, ts))

        # Close long: sell 1 BTC @ 51000 (+$1000 profit)
        exit_fill = self.create_fill("f2", "sell", 1.0, 51000.0, ts + timedelta(hours=1))
        exit_fill.realized_pnl = 1000.0  # From Hyperliquid

        closed = tracker.process_fill(exit_fill)

        assert closed is not None
        assert closed.status == "closed"
        assert closed.closed_reason == "full_close"
        assert closed.direction == "long"
        assert closed.realized_pnl == 1000.0

        # R = $1000 / ($50000 * 0.01) = $1000 / $500 = 2.0
        assert closed.result_r == 2.0
        assert not tracker.has_open_position("0x123", "BTC")

    def test_close_short_position(self):
        """Buying back closes short episode."""
        config = EpisodeBuilderConfig(default_stop_fraction=0.01)
        tracker = EpisodeTracker(config)
        ts = datetime.now(timezone.utc)

        # Open short: sell 1 BTC @ 50000
        tracker.process_fill(self.create_fill("f1", "sell", 1.0, 50000.0, ts))

        # Close short: buy 1 BTC @ 49000 (+$1000 profit)
        exit_fill = self.create_fill("f2", "buy", 1.0, 49000.0, ts + timedelta(hours=1))
        exit_fill.realized_pnl = 1000.0

        closed = tracker.process_fill(exit_fill)

        assert closed is not None
        assert closed.direction == "short"
        assert closed.result_r == 2.0

    def test_partial_close(self):
        """Partial close adds to exit fills but doesn't close episode."""
        tracker = EpisodeTracker()
        ts = datetime.now(timezone.utc)

        # Open: buy 2 BTC
        tracker.process_fill(self.create_fill("f1", "buy", 2.0, 50000.0, ts))

        # Partial close: sell 1 BTC
        tracker.process_fill(self.create_fill("f2", "sell", 1.0, 51000.0, ts + timedelta(minutes=30)))

        assert tracker.has_open_position("0x123", "BTC")
        episode = tracker.get_open_episode("0x123", "BTC")
        assert len(episode.exit_fills) == 1

    def test_direction_flip(self):
        """Selling more than position flips direction."""
        tracker = EpisodeTracker()
        ts = datetime.now(timezone.utc)

        # Open long: buy 1 BTC
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0, ts))

        # Flip to short: sell 2 BTC (close 1 + open 1 short)
        flip_fill = self.create_fill("f2", "sell", 2.0, 51000.0, ts + timedelta(hours=1))
        flip_fill.realized_pnl = 1000.0

        closed = tracker.process_fill(flip_fill)

        # Original long should be closed
        assert closed is not None
        assert closed.direction == "long"
        assert closed.closed_reason == "direction_flip"

        # New short should be open
        assert tracker.has_open_position("0x123", "BTC")
        new_episode = tracker.get_open_episode("0x123", "BTC")
        assert new_episode.direction == "short"
        assert new_episode.entry_size == 1.0

    def test_multiple_traders(self):
        """Track positions independently per trader."""
        tracker = EpisodeTracker()
        ts = datetime.now(timezone.utc)

        # Trader A opens long
        fill_a = self.create_fill("f1", "buy", 1.0, 50000.0, ts, address="0xAAA")
        tracker.process_fill(fill_a)

        # Trader B opens short
        fill_b = self.create_fill("f2", "sell", 1.0, 50000.0, ts, address="0xBBB")
        tracker.process_fill(fill_b)

        assert tracker.has_open_position("0xAAA", "BTC")
        assert tracker.has_open_position("0xBBB", "BTC")

        ep_a = tracker.get_open_episode("0xAAA", "BTC")
        ep_b = tracker.get_open_episode("0xBBB", "BTC")

        assert ep_a.direction == "long"
        assert ep_b.direction == "short"

    def test_multiple_assets(self):
        """Track positions independently per asset."""
        tracker = EpisodeTracker()
        ts = datetime.now(timezone.utc)

        # Long BTC
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0, ts, asset="BTC"))

        # Short ETH
        tracker.process_fill(self.create_fill("f2", "sell", 10.0, 3000.0, ts, asset="ETH"))

        assert tracker.has_open_position("0x123", "BTC")
        assert tracker.has_open_position("0x123", "ETH")

        btc_ep = tracker.get_open_episode("0x123", "BTC")
        eth_ep = tracker.get_open_episode("0x123", "ETH")

        assert btc_ep.direction == "long"
        assert eth_ep.direction == "short"


class TestEpisodeVoteGenerator:
    """Test vote generation from episodes."""

    def create_fill(self, fill_id, side, size, price, address="0x123", asset="BTC"):
        return EpisodeFill(
            fill_id=fill_id,
            address=address,
            asset=asset,
            side=side,
            size=size,
            price=price,
            ts=datetime.now(timezone.utc),
        )

    def test_vote_from_open_position(self):
        """Open position generates vote."""
        tracker = EpisodeTracker()
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0))

        generator = EpisodeVoteGenerator(tracker)
        vote = generator.get_vote_for_trader("0x123", "BTC")

        assert vote is not None
        assert vote['direction'] == "long"
        assert vote['entry_vwap'] == 50000.0
        assert vote['entry_size'] == 1.0

    def test_no_vote_when_flat(self):
        """No vote when no open position."""
        tracker = EpisodeTracker()
        generator = EpisodeVoteGenerator(tracker)

        vote = generator.get_vote_for_trader("0x123", "BTC")
        assert vote is None

    def test_vote_weight_normalization(self):
        """Vote weight normalized by notional."""
        tracker = EpisodeTracker()
        # $50000 notional should give weight 0.5 (normalized by $100k)
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0))

        generator = EpisodeVoteGenerator(tracker)
        vote = generator.get_vote_for_trader("0x123", "BTC")

        assert vote['weight'] == 0.5

    def test_vote_weight_capped(self):
        """Vote weight capped at 1.0."""
        tracker = EpisodeTracker()
        # $200000 notional should cap at 1.0
        tracker.process_fill(self.create_fill("f1", "buy", 4.0, 50000.0))

        generator = EpisodeVoteGenerator(tracker)
        vote = generator.get_vote_for_trader("0x123", "BTC")

        assert vote['weight'] == 1.0

    def test_get_all_votes_for_asset(self):
        """Get all votes for an asset."""
        tracker = EpisodeTracker()

        # 3 traders with BTC positions
        tracker.process_fill(self.create_fill("f1", "buy", 1.0, 50000.0, address="0xA"))
        tracker.process_fill(self.create_fill("f2", "buy", 1.0, 50100.0, address="0xB"))
        tracker.process_fill(self.create_fill("f3", "sell", 1.0, 50200.0, address="0xC"))

        # 1 trader with ETH position
        tracker.process_fill(self.create_fill("f4", "buy", 10.0, 3000.0, address="0xD", asset="ETH"))

        generator = EpisodeVoteGenerator(tracker)
        btc_votes = generator.get_all_votes("BTC")
        eth_votes = generator.get_all_votes("ETH")

        assert len(btc_votes) == 3
        assert len(eth_votes) == 1

        # Check direction counts
        btc_longs = [v for v in btc_votes if v['direction'] == 'long']
        btc_shorts = [v for v in btc_votes if v['direction'] == 'short']
        assert len(btc_longs) == 2
        assert len(btc_shorts) == 1


class TestQuantAcceptance:
    """Hand-verified quant acceptance tests from docs/DEVELOPMENT_PLAN.md."""

    def test_r_audit_positive(self):
        """R audit: +$1000 on $50k entry with 1% stop → R=2.0."""
        config = EpisodeBuilderConfig(default_stop_fraction=0.01)
        tracker = EpisodeTracker(config)
        ts = datetime.now(timezone.utc)

        # Entry: 1 BTC @ $50k = $50k notional
        tracker.process_fill(EpisodeFill(
            fill_id="f1",
            address="0x123",
            asset="BTC",
            side="buy",
            size=1.0,
            price=50000.0,
            ts=ts,
        ))

        # Exit with +$1000 realized
        exit_fill = EpisodeFill(
            fill_id="f2",
            address="0x123",
            asset="BTC",
            side="sell",
            size=1.0,
            price=51000.0,
            ts=ts + timedelta(hours=1),
            realized_pnl=1000.0,
        )
        closed = tracker.process_fill(exit_fill)

        # Risk = $50k * 1% = $500
        # R = $1000 / $500 = 2.0
        assert closed.result_r == 2.0
        assert closed.result_r_unclamped == 2.0

    def test_r_audit_negative_clamped(self):
        """R audit: -$2000 on $80k short → R=-2.0 (clamped)."""
        config = EpisodeBuilderConfig(default_stop_fraction=0.01)
        tracker = EpisodeTracker(config)
        ts = datetime.now(timezone.utc)

        # Entry: short 1 BTC @ $80k
        tracker.process_fill(EpisodeFill(
            fill_id="f1",
            address="0x123",
            asset="BTC",
            side="sell",
            size=1.0,
            price=80000.0,
            ts=ts,
        ))

        # Exit with -$2000 realized
        exit_fill = EpisodeFill(
            fill_id="f2",
            address="0x123",
            asset="BTC",
            side="buy",
            size=1.0,
            price=82000.0,
            ts=ts + timedelta(hours=1),
            realized_pnl=-2000.0,
        )
        closed = tracker.process_fill(exit_fill)

        # Risk = $80k * 1% = $800
        # R = -$2000 / $800 = -2.5 → clamped to -2.0
        assert closed.result_r == -2.0
        assert closed.result_r_unclamped == -2.5

    def test_flip_atomics_single_fill(self):
        """Flip atomics: Single fill reverses sign → close + open."""
        tracker = EpisodeTracker()
        ts = datetime.now(timezone.utc)

        # Open long
        tracker.process_fill(EpisodeFill(
            fill_id="f1",
            address="0x123",
            asset="BTC",
            side="buy",
            size=1.0,
            price=50000.0,
            ts=ts,
        ))

        # Flip: sell 2 (close 1 long + open 1 short)
        flip_fill = EpisodeFill(
            fill_id="f2",
            address="0x123",
            asset="BTC",
            side="sell",
            size=2.0,
            price=51000.0,
            ts=ts + timedelta(hours=1),
            realized_pnl=1000.0,
        )
        closed = tracker.process_fill(flip_fill)

        # Long should be closed
        assert closed is not None
        assert closed.direction == "long"
        assert closed.closed_reason == "direction_flip"

        # New short should be open
        new_ep = tracker.get_open_episode("0x123", "BTC")
        assert new_ep is not None
        assert new_ep.direction == "short"
        assert new_ep.entry_size == 1.0

    def test_vwap_multiple_entry_fills(self):
        """R audit: VWAP across multiple entry fills."""
        config = EpisodeBuilderConfig(default_stop_fraction=0.01)
        tracker = EpisodeTracker(config)
        ts = datetime.now(timezone.utc)

        # Entry 1: 0.5 BTC @ $48k
        tracker.process_fill(EpisodeFill(
            fill_id="f1",
            address="0x123",
            asset="BTC",
            side="buy",
            size=0.5,
            price=48000.0,
            ts=ts,
        ))

        # Entry 2: 0.5 BTC @ $52k
        tracker.process_fill(EpisodeFill(
            fill_id="f2",
            address="0x123",
            asset="BTC",
            side="buy",
            size=0.5,
            price=52000.0,
            ts=ts + timedelta(minutes=5),
        ))

        episode = tracker.get_open_episode("0x123", "BTC")

        # VWAP = (0.5*48000 + 0.5*52000) / 1.0 = 50000
        assert episode.entry_vwap == 50000.0
        assert episode.entry_size == 1.0
        assert len(episode.entry_fills) == 2
