"""
Episode Builder for Position Lifecycle Tracking

Builds complete position episodes from fills with:
- Sign-aware segmentation (position goes 0 → ±X → 0)
- VWAP entry/exit calculation
- R-multiple calculation with policy-based stop
- Direction flip handling (close + reopen)

Port of packages/ts-lib/src/episode.ts to Python for hl-decide integration.

@module episode
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional, Dict
from uuid import uuid4


@dataclass
class EpisodeFill:
    """A single fill in an episode."""
    fill_id: str
    address: str
    asset: str
    side: str  # 'buy' or 'sell'
    size: float
    price: float
    ts: datetime
    realized_pnl: Optional[float] = None
    fees: float = 0.0

    @property
    def signed_size(self) -> float:
        """Positive for buy, negative for sell."""
        return self.size if self.side.lower() in ('buy', 'long') else -self.size


@dataclass
class Episode:
    """A complete position lifecycle from open to close."""
    id: str
    address: str
    asset: str
    direction: str  # 'long' or 'short'

    # Entry info
    entry_fills: List[EpisodeFill] = field(default_factory=list)
    entry_vwap: float = 0.0
    entry_size: float = 0.0
    entry_ts: Optional[datetime] = None
    entry_notional: float = 0.0

    # Exit info (None while open)
    exit_fills: List[EpisodeFill] = field(default_factory=list)
    exit_vwap: Optional[float] = None
    exit_size: Optional[float] = None
    exit_ts: Optional[datetime] = None
    exit_notional: Optional[float] = None

    # Risk and P&L
    stop_price: float = 0.0
    stop_bps: float = 100.0  # Default 1% = 100 bps
    risk_amount: float = 0.0
    realized_pnl: Optional[float] = None
    result_r: Optional[float] = None
    result_r_unclamped: Optional[float] = None
    total_fees: float = 0.0

    # Status
    status: str = 'open'  # 'open', 'closed'
    closed_reason: Optional[str] = None  # 'full_close', 'direction_flip', 'timeout'


@dataclass
class EpisodeBuilderConfig:
    """Configuration for episode builder."""
    default_stop_fraction: float = 0.01  # 1%
    r_min: float = -2.0
    r_max: float = 2.0
    timeout_hours: float = 168.0  # 7 days


DEFAULT_CONFIG = EpisodeBuilderConfig()


def calculate_vwap(fills: List[EpisodeFill]) -> float:
    """Calculate VWAP from a list of fills."""
    if not fills:
        return 0.0

    total_notional = sum(f.price * f.size for f in fills)
    total_size = sum(f.size for f in fills)

    return total_notional / total_size if total_size > 0 else 0.0


def calculate_stop_price(entry_price: float, direction: str, stop_fraction: float) -> float:
    """Calculate stop price based on entry price and direction."""
    if direction == 'long':
        return entry_price * (1 - stop_fraction)
    else:
        return entry_price * (1 + stop_fraction)


def calculate_stop_bps(entry_price: float, stop_price: float) -> float:
    """Calculate stop distance in basis points."""
    if entry_price <= 0:
        return 0.0
    return abs((entry_price - stop_price) / entry_price) * 10000


def calculate_r(pnl: float, risk_amount: float, r_min: float = -2.0, r_max: float = 2.0) -> tuple:
    """
    Calculate R-multiple from P&L and risk amount.

    Returns:
        Tuple of (clamped_r, unclamped_r)
    """
    if risk_amount <= 0:
        return (0.0, 0.0)
    r = pnl / risk_amount
    clamped = max(r_min, min(r_max, r))
    return (clamped, r)


class EpisodeTracker:
    """
    Tracks position episodes per address+asset pair.

    Maintains state of open episodes and generates closed episodes
    with R-multiples when positions close.
    """

    def __init__(self, config: EpisodeBuilderConfig = None):
        self.config = config or DEFAULT_CONFIG
        # Key: (address, asset) -> Episode
        self.open_episodes: Dict[tuple, Episode] = {}
        # Counter for episode IDs
        self.episode_counters: Dict[tuple, int] = {}

    def _get_episode_key(self, address: str, asset: str) -> tuple:
        """Get the key for an address+asset pair."""
        return (address.lower(), asset.upper())

    def _next_episode_id(self, address: str, asset: str) -> str:
        """Generate the next episode ID for an address+asset pair."""
        key = self._get_episode_key(address, asset)
        self.episode_counters[key] = self.episode_counters.get(key, 0) + 1
        return f"{address[:10]}-{asset}-{self.episode_counters[key]}"

    def process_fill(self, fill: EpisodeFill) -> Optional[Episode]:
        """
        Process a fill and return a closed episode if position closed.

        Args:
            fill: The incoming fill

        Returns:
            Closed Episode if position closed, None otherwise
        """
        key = self._get_episode_key(fill.address, fill.asset)
        current = self.open_episodes.get(key)

        # Calculate new position after this fill
        if current:
            prev_position = current.entry_size if current.direction == 'long' else -current.entry_size
            # Adjust for any partial closes already recorded
            for ef in current.exit_fills:
                prev_position += ef.signed_size
        else:
            prev_position = 0.0

        new_position = prev_position + fill.signed_size

        # Case 1: Was flat, now have position → Start new episode
        if abs(prev_position) < 1e-9 and abs(new_position) > 1e-9:
            direction = 'long' if new_position > 0 else 'short'
            stop_price = calculate_stop_price(
                fill.price, direction, self.config.default_stop_fraction
            )
            entry_notional = fill.price * abs(new_position)

            episode = Episode(
                id=self._next_episode_id(fill.address, fill.asset),
                address=fill.address.lower(),
                asset=fill.asset.upper(),
                direction=direction,
                entry_fills=[fill],
                entry_vwap=fill.price,
                entry_size=abs(new_position),
                entry_ts=fill.ts,
                entry_notional=entry_notional,
                stop_price=stop_price,
                stop_bps=calculate_stop_bps(fill.price, stop_price),
                risk_amount=entry_notional * self.config.default_stop_fraction,
                total_fees=fill.fees,
                status='open',
            )
            self.open_episodes[key] = episode
            return None

        # Case 2: Position crosses zero or flips sign → Close episode
        if current and abs(prev_position) > 1e-9:
            # Check for sign flip or full close
            if (prev_position > 0 and new_position <= 0) or (prev_position < 0 and new_position >= 0):
                return self._close_episode(key, fill, new_position)

        # Case 3: Adding to position (same direction)
        if current and abs(new_position) > abs(prev_position):
            current.entry_fills.append(fill)
            current.entry_vwap = calculate_vwap(current.entry_fills)
            current.entry_size = abs(new_position)
            current.entry_notional = current.entry_vwap * current.entry_size
            current.risk_amount = current.entry_notional * self.config.default_stop_fraction
            current.total_fees += fill.fees
            return None

        # Case 4: Reducing position (partial close)
        if current and abs(new_position) < abs(prev_position) and abs(new_position) > 1e-9:
            current.exit_fills.append(fill)
            current.total_fees += fill.fees
            return None

        return None

    def _close_episode(self, key: tuple, fill: EpisodeFill, new_position: float) -> Episode:
        """Close an episode and calculate R-multiple."""
        current = self.open_episodes[key]
        current.exit_fills.append(fill)
        current.exit_vwap = calculate_vwap(current.exit_fills)
        current.exit_size = current.entry_size
        current.exit_ts = fill.ts
        current.exit_notional = current.exit_vwap * current.exit_size if current.exit_vwap else 0.0

        # Calculate P&L
        if fill.realized_pnl is not None:
            current.realized_pnl = fill.realized_pnl
        else:
            # Calculate from prices
            if current.direction == 'long':
                current.realized_pnl = (current.exit_vwap - current.entry_vwap) * current.entry_size
            else:
                current.realized_pnl = (current.entry_vwap - current.exit_vwap) * current.entry_size

        # Calculate R-multiple
        if current.realized_pnl is not None and current.risk_amount > 0:
            clamped, unclamped = calculate_r(
                current.realized_pnl,
                current.risk_amount,
                self.config.r_min,
                self.config.r_max
            )
            current.result_r = clamped
            current.result_r_unclamped = unclamped

        current.total_fees += fill.fees
        current.status = 'closed'
        current.closed_reason = 'direction_flip' if abs(new_position) > 1e-9 else 'full_close'

        # Remove from open episodes
        del self.open_episodes[key]

        # If position flipped, start new episode
        if abs(new_position) > 1e-9:
            direction = 'long' if new_position > 0 else 'short'
            stop_price = calculate_stop_price(
                fill.price, direction, self.config.default_stop_fraction
            )
            entry_notional = fill.price * abs(new_position)

            new_episode = Episode(
                id=self._next_episode_id(fill.address, fill.asset),
                address=fill.address.lower(),
                asset=fill.asset.upper(),
                direction=direction,
                entry_fills=[fill],
                entry_vwap=fill.price,
                entry_size=abs(new_position),
                entry_ts=fill.ts,
                entry_notional=entry_notional,
                stop_price=stop_price,
                stop_bps=calculate_stop_bps(fill.price, stop_price),
                risk_amount=entry_notional * self.config.default_stop_fraction,
                total_fees=fill.fees,
                status='open',
            )
            self.open_episodes[key] = new_episode

        return current

    def get_open_episode(self, address: str, asset: str) -> Optional[Episode]:
        """Get the current open episode for an address+asset pair."""
        key = self._get_episode_key(address, asset)
        return self.open_episodes.get(key)

    def get_all_open_episodes(self) -> List[Episode]:
        """Get all currently open episodes."""
        return list(self.open_episodes.values())

    def has_open_position(self, address: str, asset: str) -> bool:
        """Check if there's an open position for an address+asset."""
        key = self._get_episode_key(address, asset)
        return key in self.open_episodes


class EpisodeVoteGenerator:
    """
    Generates consensus votes from episodes.

    Key principle: One vote per trader derived from their current episode state,
    not from individual fills.
    """

    def __init__(self, episode_tracker: EpisodeTracker):
        self.tracker = episode_tracker

    def get_vote_for_trader(self, address: str, asset: str) -> Optional[dict]:
        """
        Get the current vote for a trader based on their open episode.

        Returns:
            Dict with vote info or None if no open position
        """
        episode = self.tracker.get_open_episode(address, asset)
        if not episode:
            return None

        return {
            'address': episode.address,
            'asset': episode.asset,
            'direction': episode.direction,
            'entry_vwap': episode.entry_vwap,
            'entry_size': episode.entry_size,
            'entry_ts': episode.entry_ts,
            'notional': episode.entry_notional,
            'weight': min(episode.entry_notional / 100000, 1.0),  # Normalize by $100k
        }

    def get_all_votes(self, asset: str) -> List[dict]:
        """
        Get all current votes for an asset.

        Returns:
            List of vote dicts from all traders with open positions
        """
        votes = []
        for episode in self.tracker.get_all_open_episodes():
            if episode.asset.upper() == asset.upper():
                vote = self.get_vote_for_trader(episode.address, asset)
                if vote:
                    votes.append(vote)
        return votes
