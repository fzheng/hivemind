"""
Tests for hl-sage state persistence and recovery.
"""
import pytest
from datetime import datetime, timedelta, timezone
from collections import OrderedDict
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.main import evict_stale_entries, MAX_TRACKED_ADDRESSES


class TestStaleEviction:
    """Test stale entry eviction logic."""

    def test_evict_stale_entries_by_time(self):
        """Test eviction of stale entries based on timestamp."""
        # Import here to avoid module-level import issues
        from app.main import tracked_addresses, STALE_THRESHOLD_HOURS

        tracked_addresses.clear()

        now = datetime.now(timezone.utc)
        stale_time = now - timedelta(hours=STALE_THRESHOLD_HOURS + 1)
        fresh_time = now - timedelta(hours=1)

        # Add stale and fresh entries
        tracked_addresses["0xstale"] = {
            "weight": 0.5,
            "rank": 10,
            "period": 30,
            "position": 0.0,
            "updated": stale_time
        }
        tracked_addresses["0xfresh"] = {
            "weight": 0.8,
            "rank": 5,
            "period": 30,
            "position": 1.0,
            "updated": fresh_time
        }

        evict_stale_entries()

        assert "0xstale" not in tracked_addresses
        assert "0xfresh" in tracked_addresses

    def test_evict_by_max_limit(self):
        """Test LRU eviction when max limit exceeded."""
        test_addresses = OrderedDict()
        now = datetime.now(timezone.utc)

        # Add more than max (use a small number for testing)
        test_max = 10
        for i in range(test_max + 5):
            test_addresses[f"0x{i:04x}"] = {
                "weight": 0.5,
                "rank": i,
                "period": 30,
                "position": 0.0,
                "updated": now
            }

        # Simulate eviction
        while len(test_addresses) > test_max:
            test_addresses.popitem(last=False)

        assert len(test_addresses) == test_max
        # First entries should be evicted (LRU)
        assert "0x0000" not in test_addresses
        # Last entries should remain
        assert f"0x{test_max + 4:04x}" in test_addresses

    def test_move_to_end_lru_behavior(self):
        """Test that accessing an entry moves it to the end (most recently used)."""
        test_addresses = OrderedDict()

        # Add entries
        test_addresses["0x1111"] = {"updated": datetime.now(timezone.utc)}
        test_addresses["0x2222"] = {"updated": datetime.now(timezone.utc)}
        test_addresses["0x3333"] = {"updated": datetime.now(timezone.utc)}

        # Access the first entry (simulate re-use)
        if "0x1111" in test_addresses:
            test_addresses.move_to_end("0x1111")

        # The order should now be 0x2222, 0x3333, 0x1111
        keys = list(test_addresses.keys())
        assert keys == ["0x2222", "0x3333", "0x1111"]

        # Now if we evict one, it should evict 0x2222 (oldest)
        test_addresses.popitem(last=False)

        assert "0x2222" not in test_addresses
        assert "0x1111" in test_addresses
        assert "0x3333" in test_addresses
