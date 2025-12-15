"""
Trader Correlation Calculator

Computes pairwise correlations between traders based on position posture
(direction sign) in 5-minute buckets. Used for effective-K calculation
in consensus detection.

Methodology:
1. Build sign vectors: For each trader+asset, create a series of {-1, 0, +1}
   representing their position direction in each 5-min bucket.
2. Compute phi/tetrachoric correlation on co-occurring buckets.
3. Clip to [0, 1] since we only care about positive correlation
   (negative correlation = independent for our purposes).

Data sources:
- episode_fills table: All fills with timestamps
- position_signals table: Episode info with direction

@module correlation
"""

import asyncio
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta, date
from typing import Dict, List, Optional, Set, Tuple
from collections import defaultdict

import asyncpg

# Configuration
CORR_BUCKET_MINUTES = int(os.getenv("CORR_BUCKET_MINUTES", "5"))
CORR_LOOKBACK_DAYS = int(os.getenv("CORR_LOOKBACK_DAYS", "30"))
CORR_MIN_COMMON_BUCKETS = int(os.getenv("CORR_MIN_COMMON_BUCKETS", "10"))
CORR_BATCH_SIZE = int(os.getenv("CORR_BATCH_SIZE", "1000"))

# Staleness configuration
CORR_MAX_STALENESS_DAYS = int(os.getenv("CORR_MAX_STALENESS_DAYS", "7"))  # Max age before full fallback
CORR_DECAY_HALFLIFE_DAYS = float(os.getenv("CORR_DECAY_HALFLIFE_DAYS", "3.0"))  # Half-life for decay

# Default correlation when data is missing or stale
DEFAULT_CORRELATION = float(os.getenv("DEFAULT_CORRELATION", "0.3"))

# Conservative default for non-Hyperliquid venues (Phase 6.4)
# Higher correlation = lower effective-K = more conservative sizing
NON_HL_DEFAULT_CORRELATION = float(os.getenv("NON_HL_DEFAULT_CORRELATION", "0.5"))


@dataclass
class TraderSignVector:
    """Sign vector for a trader over time buckets."""
    address: str
    asset: str
    # Dict mapping bucket_id -> sign (-1, 0, +1)
    signs: Dict[int, int]

    @property
    def bucket_ids(self) -> Set[int]:
        """Get all bucket IDs where trader had a position."""
        return set(self.signs.keys())


def bucket_id_from_timestamp(ts: datetime) -> int:
    """
    Convert timestamp to bucket ID.

    Bucket ID = minutes since Unix epoch / bucket_size.
    This gives a unique integer for each 5-minute bucket.
    """
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    minutes_since_epoch = int((ts - epoch).total_seconds() / 60)
    return minutes_since_epoch // CORR_BUCKET_MINUTES


def timestamp_from_bucket_id(bucket_id: int) -> datetime:
    """Convert bucket ID back to timestamp (start of bucket)."""
    minutes_since_epoch = bucket_id * CORR_BUCKET_MINUTES
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return epoch + timedelta(minutes=minutes_since_epoch)


def compute_phi_correlation(signs_a: Dict[int, int], signs_b: Dict[int, int]) -> Tuple[float, int]:
    """
    Compute phi (binary) correlation between two sign vectors.

    Phi coefficient for 2x2 contingency table:
    φ = (n11*n00 - n10*n01) / sqrt((n11+n10)(n01+n00)(n11+n01)(n10+n00))

    For sign vectors, we convert to binary (same direction vs different):
    - Same: Both +1 or both -1
    - Different: One +1, other -1
    - Ignore buckets where either is 0

    Args:
        signs_a: Sign vector for trader A
        signs_b: Sign vector for trader B

    Returns:
        Tuple of (correlation, n_common_buckets)
    """
    # Find common buckets where both have non-zero position
    common = set(signs_a.keys()) & set(signs_b.keys())
    common_nonzero = [b for b in common if signs_a[b] != 0 and signs_b[b] != 0]

    n_common = len(common_nonzero)
    if n_common < CORR_MIN_COMMON_BUCKETS:
        return (0.0, n_common)  # Insufficient data, return default

    # Count concordant and discordant pairs
    # Concordant: same sign (both +1 or both -1)
    # Discordant: opposite sign
    concordant = 0
    discordant = 0

    for b in common_nonzero:
        if signs_a[b] == signs_b[b]:
            concordant += 1
        else:
            discordant += 1

    # Simple correlation: (concordant - discordant) / total
    # This is equivalent to Kendall's tau for binary data
    total = concordant + discordant
    if total == 0:
        return (0.0, n_common)

    # Raw correlation can be negative (opposite traders)
    raw_corr = (concordant - discordant) / total

    # Clip to [0, 1] - we only care about positive correlation
    # Negative correlation means traders are independent (different strategies)
    clipped_corr = max(0.0, raw_corr)

    return (clipped_corr, n_common)


async def build_sign_vectors(
    pool: asyncpg.Pool,
    asset: str,
    since: datetime,
    addresses: Optional[List[str]] = None,
) -> Dict[str, TraderSignVector]:
    """
    Build sign vectors for all traders from fill data.

    For each trader, create a sign vector representing their position
    direction in each 5-minute bucket.

    Args:
        pool: Database connection pool
        asset: Asset symbol (BTC, ETH)
        since: Start timestamp for lookback window
        addresses: Optional list of addresses to include (None = all)

    Returns:
        Dict mapping address -> TraderSignVector
    """
    vectors: Dict[str, TraderSignVector] = {}

    async with pool.acquire() as conn:
        # Query fills from episode_fills joined with position_signals
        # to get direction for each fill
        query = """
            SELECT
                ps.address,
                ef.ts,
                ps.direction
            FROM episode_fills ef
            JOIN position_signals ps ON ef.episode_id = ps.id
            WHERE ps.asset = $1
              AND ef.ts >= $2
        """
        params = [asset, since]

        if addresses:
            query += " AND ps.address = ANY($3)"
            params.append(addresses)

        query += " ORDER BY ef.ts"

        rows = await conn.fetch(query, *params)

        # Build sign vectors
        for row in rows:
            addr = row["address"].lower()
            ts = row["ts"]
            direction = row["direction"]

            if addr not in vectors:
                vectors[addr] = TraderSignVector(
                    address=addr,
                    asset=asset,
                    signs={},
                )

            bucket = bucket_id_from_timestamp(ts)
            sign = 1 if direction == "long" else -1

            # Record the sign for this bucket
            # If trader changes direction within bucket, take the latest
            vectors[addr].signs[bucket] = sign

    return vectors


async def compute_all_correlations(
    pool: asyncpg.Pool,
    asset: str,
    as_of_date: date,
    lookback_days: int = CORR_LOOKBACK_DAYS,
) -> List[Tuple[str, str, float, int]]:
    """
    Compute all pairwise correlations for an asset.

    Args:
        pool: Database connection pool
        asset: Asset symbol (BTC, ETH)
        as_of_date: Date for the correlation calculation
        lookback_days: Number of days to look back

    Returns:
        List of (addr_a, addr_b, rho, n_buckets) tuples
    """
    since = datetime.combine(
        as_of_date - timedelta(days=lookback_days),
        datetime.min.time(),
        tzinfo=timezone.utc,
    )

    # Get addresses from alpha pool
    async with pool.acquire() as conn:
        alpha_rows = await conn.fetch(
            """
            SELECT LOWER(address) as address
            FROM alpha_pool_addresses
            WHERE is_active = true
            """
        )
        addresses = [row["address"] for row in alpha_rows]

    if len(addresses) < 2:
        return []

    # Build sign vectors
    vectors = await build_sign_vectors(pool, asset, since, addresses)

    # Compute pairwise correlations
    correlations: List[Tuple[str, str, float, int]] = []
    computed_pairs: Set[Tuple[str, str]] = set()

    for addr_a in vectors:
        for addr_b in vectors:
            if addr_a >= addr_b:  # Only compute each pair once (a < b)
                continue

            pair_key = (addr_a, addr_b)
            if pair_key in computed_pairs:
                continue

            rho, n_buckets = compute_phi_correlation(
                vectors[addr_a].signs,
                vectors[addr_b].signs,
            )

            correlations.append((addr_a, addr_b, rho, n_buckets))
            computed_pairs.add(pair_key)

    return correlations


async def store_correlations(
    pool: asyncpg.Pool,
    asset: str,
    as_of_date: date,
    correlations: List[Tuple[str, str, float, int]],
) -> int:
    """
    Store computed correlations in trader_corr table.

    Args:
        pool: Database connection pool
        asset: Asset symbol
        as_of_date: Date for the correlations
        correlations: List of (addr_a, addr_b, rho, n_buckets)

    Returns:
        Number of rows inserted/updated
    """
    if not correlations:
        return 0

    async with pool.acquire() as conn:
        # Use batch insert with ON CONFLICT
        count = 0
        for batch_start in range(0, len(correlations), CORR_BATCH_SIZE):
            batch = correlations[batch_start:batch_start + CORR_BATCH_SIZE]

            for addr_a, addr_b, rho, n_buckets in batch:
                await conn.execute(
                    """
                    INSERT INTO trader_corr (as_of_date, asset, addr_a, addr_b, rho, n_buckets)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (as_of_date, asset, addr_a, addr_b)
                    DO UPDATE SET
                        rho = EXCLUDED.rho,
                        n_buckets = EXCLUDED.n_buckets,
                        computed_at = NOW()
                    """,
                    as_of_date,
                    asset,
                    addr_a,
                    addr_b,
                    rho,
                    n_buckets,
                )
                count += 1

        return count


async def load_correlations(
    pool: asyncpg.Pool,
    as_of_date: Optional[date] = None,
) -> Dict[Tuple[str, str], float]:
    """
    Load correlations from database into a lookup dict.

    Args:
        pool: Database connection pool
        as_of_date: Date to load (None = latest)

    Returns:
        Dict mapping (addr_a, addr_b) tuple -> rho
    """
    correlations: Dict[Tuple[str, str], float] = {}

    async with pool.acquire() as conn:
        if as_of_date:
            rows = await conn.fetch(
                """
                SELECT addr_a, addr_b, rho
                FROM trader_corr
                WHERE as_of_date = $1
                """,
                as_of_date,
            )
        else:
            # Get latest date's correlations
            rows = await conn.fetch(
                """
                SELECT addr_a, addr_b, rho
                FROM trader_corr
                WHERE as_of_date = (SELECT MAX(as_of_date) FROM trader_corr)
                """
            )

        for row in rows:
            key = tuple(sorted([row["addr_a"], row["addr_b"]]))
            correlations[key] = float(row["rho"])

    return correlations


async def prune_old_correlations(
    pool: asyncpg.Pool,
    keep_days: int = CORR_LOOKBACK_DAYS,
) -> int:
    """
    Remove correlation entries older than keep_days.

    Args:
        pool: Database connection pool
        keep_days: Days of history to keep

    Returns:
        Number of rows deleted
    """
    cutoff = date.today() - timedelta(days=keep_days)

    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            DELETE FROM trader_corr
            WHERE as_of_date < $1
            """,
            cutoff,
        )
        # Parse "DELETE N" result
        count = int(result.split()[-1]) if result else 0
        return count


async def run_daily_correlation_job(pool: asyncpg.Pool) -> dict:
    """
    Run the daily correlation computation job.

    This is the main entry point for the daily job. It:
    1. Computes correlations for both BTC and ETH
    2. Stores results in trader_corr table
    3. Prunes old entries

    Args:
        pool: Database connection pool

    Returns:
        Summary dict with counts
    """
    today = date.today()
    summary = {
        "date": today.isoformat(),
        "btc_pairs": 0,
        "eth_pairs": 0,
        "pruned": 0,
    }

    # Compute BTC correlations
    btc_corrs = await compute_all_correlations(pool, "BTC", today)
    summary["btc_pairs"] = await store_correlations(pool, "BTC", today, btc_corrs)

    # Compute ETH correlations
    eth_corrs = await compute_all_correlations(pool, "ETH", today)
    summary["eth_pairs"] = await store_correlations(pool, "ETH", today, eth_corrs)

    # Prune old entries
    summary["pruned"] = await prune_old_correlations(pool)

    return summary


class CorrelationProvider:
    """
    Provides correlation data to the consensus detector.

    Loads correlations from database and provides lookup interface.
    Applies time-decay to older correlations and handles staleness.
    """

    def __init__(self, pool: Optional[asyncpg.Pool] = None):
        self.pool = pool
        self.correlations: Dict[Tuple[str, str], float] = {}
        self._loaded_date: Optional[date] = None
        self._default_used_count: int = 0

    def set_pool(self, pool: asyncpg.Pool) -> None:
        """Set the database pool."""
        self.pool = pool

    @property
    def is_stale(self) -> bool:
        """Check if loaded correlations exceed max staleness."""
        if self._loaded_date is None:
            return True
        age_days = (date.today() - self._loaded_date).days
        return age_days > CORR_MAX_STALENESS_DAYS

    @property
    def age_days(self) -> int:
        """Get age of loaded correlations in days."""
        if self._loaded_date is None:
            return float('inf')
        return (date.today() - self._loaded_date).days

    def _decay_factor(self) -> float:
        """
        Calculate decay factor based on data age.

        Uses exponential decay: factor = 2^(-age/halflife)
        - Age 0: factor = 1.0 (no decay)
        - Age = halflife: factor = 0.5
        - Age >> halflife: factor -> 0
        """
        if self._loaded_date is None:
            return 0.0
        age_days = (date.today() - self._loaded_date).days
        if age_days <= 0:
            return 1.0
        return math.pow(2, -age_days / CORR_DECAY_HALFLIFE_DAYS)

    async def load(self, as_of_date: Optional[date] = None) -> int:
        """
        Load correlations from database.

        Args:
            as_of_date: Date to load (None = latest)

        Returns:
            Number of pairs loaded
        """
        if self.pool is None:
            return 0

        self.correlations = await load_correlations(self.pool, as_of_date)
        self._loaded_date = as_of_date or date.today()
        self._default_used_count = 0

        # Log staleness warning if applicable
        if self.is_stale:
            print(
                f"[correlation] WARNING: Correlation data is stale "
                f"({self.age_days} days old, max {CORR_MAX_STALENESS_DAYS} days). "
                f"Using default ρ={DEFAULT_CORRELATION} for new pairs."
            )

        return len(self.correlations)

    def get(self, addr_a: str, addr_b: str) -> Optional[float]:
        """
        Get correlation between two traders.

        Args:
            addr_a: First trader address
            addr_b: Second trader address

        Returns:
            Correlation value or None if not found
        """
        key = tuple(sorted([addr_a.lower(), addr_b.lower()]))
        return self.correlations.get(key)

    def get_with_decay(
        self,
        addr_a: str,
        addr_b: str,
        log_default: bool = True,
        target_exchange: str = "hyperliquid",
    ) -> float:
        """
        Get correlation with time-decay applied.

        Blends stored correlation toward default based on data age:
        - Fresh data (decay=1.0): Use stored correlation
        - Stale data (decay=0.0): Use default correlation
        - In between: Weighted blend

        Phase 6.4: Uses exchange-aware default. For non-Hyperliquid venues,
        we use a more conservative default (higher ρ) since our correlation
        data is derived from Hyperliquid traders only.

        Args:
            addr_a: First trader address
            addr_b: Second trader address
            log_default: Whether to log when default is used
            target_exchange: Target execution venue for default selection

        Returns:
            Decayed correlation value (always returns a value, never None)
        """
        raw_rho = self.get(addr_a, addr_b)

        # Determine default based on exchange (Phase 6.4)
        if target_exchange.lower() == "hyperliquid":
            default_rho = DEFAULT_CORRELATION
        else:
            default_rho = NON_HL_DEFAULT_CORRELATION

        if raw_rho is None:
            # No stored correlation, use exchange-aware default
            self._default_used_count += 1
            if log_default and self._default_used_count <= 5:
                print(
                    f"[correlation] Using default ρ={default_rho} "
                    f"for pair ({addr_a[:8]}..., {addr_b[:8]}...) - "
                    f"no stored correlation found (exchange={target_exchange})"
                )
            return default_rho

        # Apply decay
        decay = self._decay_factor()
        if decay >= 0.99:
            return raw_rho  # No significant decay

        # Blend toward default: decayed = raw * decay + default * (1 - decay)
        decayed_rho = raw_rho * decay + default_rho * (1 - decay)
        return decayed_rho

    def check_freshness(self) -> Tuple[bool, str]:
        """
        Check freshness of correlation data.

        Returns:
            Tuple of (is_fresh, status_message)
        """
        if self._loaded_date is None:
            return (False, "No correlation data loaded")

        age_days = self.age_days
        decay = self._decay_factor()

        if self.is_stale:
            return (
                False,
                f"Correlations stale: {age_days} days old "
                f"(max {CORR_MAX_STALENESS_DAYS}), decay={decay:.2f}"
            )

        return (
            True,
            f"Correlations fresh: {age_days} days old, decay={decay:.2f}"
        )

    def hydrate_detector(
        self,
        detector,
        apply_decay: bool = True,
        target_exchange: str = "hyperliquid",
    ) -> int:
        """
        Hydrate a ConsensusDetector with loaded correlations.

        Phase 6.4: Uses exchange-aware default for decay blending.

        Args:
            detector: ConsensusDetector instance
            apply_decay: Whether to apply time-decay
            target_exchange: Target execution venue for default selection

        Returns:
            Number of pairs added
        """
        decay = self._decay_factor() if apply_decay else 1.0

        # Determine default based on exchange (Phase 6.4)
        if target_exchange.lower() == "hyperliquid":
            default_rho = DEFAULT_CORRELATION
        else:
            default_rho = NON_HL_DEFAULT_CORRELATION

        count = 0

        for (addr_a, addr_b), rho in self.correlations.items():
            if apply_decay and decay < 0.99:
                rho = rho * decay + default_rho * (1 - decay)
            detector.update_correlation(addr_a, addr_b, rho)
            count += 1

        # Log summary
        is_fresh, message = self.check_freshness()
        status = "✓" if is_fresh else "⚠"
        print(f"[correlation] {status} Hydrated detector with {count} pairs. {message}")

        return count


# Global singleton
_correlation_provider: Optional[CorrelationProvider] = None


def get_correlation_provider() -> CorrelationProvider:
    """Get the global correlation provider singleton."""
    global _correlation_provider
    if _correlation_provider is None:
        _correlation_provider = CorrelationProvider()
    return _correlation_provider


def init_correlation_provider(pool: asyncpg.Pool) -> CorrelationProvider:
    """Initialize the global correlation provider with a database pool."""
    provider = get_correlation_provider()
    provider.set_pool(pool)
    return provider
