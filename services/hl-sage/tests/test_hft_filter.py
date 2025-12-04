"""
Tests for HFT detection via orders-per-day analysis.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


class TestAnalyzeUserFills:
    """Test the analyze_user_fills function for HFT detection."""

    @pytest.fixture
    def mock_fills_position_trader(self):
        """Mock fills for a position trader (few orders, large fills per order)."""
        # Position trader: 15 orders over ~1.5 days = ~10 orders/day
        # Each order has multiple fills (large orders get filled in parts)
        base_time = 1700000000000  # ms timestamp
        fills = []

        for order_id in range(15):
            # Each order has ~20 fills (simulating large order partial fills)
            # Orders spread over ~2.4 hours each = 36 hours total = 1.5 days
            order_time = base_time + (order_id * 2.4 * 3600 * 1000)  # ~2.4 hours between orders
            for fill_idx in range(20):
                fills.append({
                    "oid": f"order_{order_id}",
                    "coin": "BTC" if order_id % 3 != 0 else "ETH",
                    "time": order_time + (fill_idx * 100),  # fills within same second
                    "sz": "0.001",
                    "px": "90000",
                    "side": "B",
                })

        return fills

    @pytest.fixture
    def mock_fills_hft(self):
        """Mock fills for an HFT trader (many orders per day)."""
        # HFT: 500 orders over 1 day = 500 orders/day
        base_time = 1700000000000
        fills = []

        for order_id in range(500):
            # Each order has only 1-2 fills (small orders)
            order_time = base_time + (order_id * 172800)  # spread over 1 day
            fills.append({
                "oid": f"order_{order_id}",
                "coin": "BTC",
                "time": order_time,
                "sz": "0.0001",
                "px": "90000",
                "side": "B",
            })

        return fills

    @pytest.fixture
    def mock_fills_no_btc_eth(self):
        """Mock fills for a trader who only trades altcoins."""
        base_time = 1700000000000
        fills = []

        for order_id in range(20):
            fills.append({
                "oid": f"order_{order_id}",
                "coin": "SOL",  # Only SOL trades
                "time": base_time + (order_id * 3600 * 1000),
                "sz": "10",
                "px": "100",
                "side": "B",
            })

        return fills

    @pytest.mark.asyncio
    async def test_position_trader_not_hft(self, mock_fills_position_trader):
        """Position trader with 13.6 orders/day should NOT be flagged as HFT."""
        from app.main import analyze_user_fills

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_fills_position_trader

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is not None
        assert result["has_btc_eth"] is True
        assert result["orders_per_day"] < 100  # Should be ~13.6
        assert result["orders_per_day"] > 10  # Sanity check

    @pytest.mark.asyncio
    async def test_hft_trader_detected(self, mock_fills_hft):
        """HFT trader with 500 orders/day should be flagged."""
        from app.main import analyze_user_fills

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_fills_hft

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is not None
        assert result["has_btc_eth"] is True
        assert result["orders_per_day"] > 100  # Should be ~500

    @pytest.mark.asyncio
    async def test_no_btc_eth_detected(self, mock_fills_no_btc_eth):
        """Trader with no BTC/ETH fills should have has_btc_eth=False."""
        from app.main import analyze_user_fills

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_fills_no_btc_eth

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is not None
        assert result["has_btc_eth"] is False

    @pytest.mark.asyncio
    async def test_empty_fills(self):
        """Empty fills should return safe defaults."""
        from app.main import analyze_user_fills

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = []

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is not None
        assert result["has_btc_eth"] is False
        assert result["orders_per_day"] == 0.0
        assert result["fill_count"] == 0

    @pytest.mark.asyncio
    async def test_api_error_returns_none(self):
        """API error should return None."""
        from app.main import analyze_user_fills

        mock_response = MagicMock()
        mock_response.status_code = 500

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is None

    @pytest.mark.asyncio
    async def test_exception_returns_none(self):
        """Exception during request should return None."""
        from app.main import analyze_user_fills

        mock_client = AsyncMock()
        mock_client.post.side_effect = Exception("Network error")

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is None

    @pytest.mark.asyncio
    async def test_single_order_very_short_timespan(self):
        """Single order with very short timespan should return 0 orders/day."""
        from app.main import analyze_user_fills

        # All fills within 1 second (same order)
        fills = [
            {"oid": "order_1", "coin": "BTC", "time": 1700000000000, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "order_1", "coin": "BTC", "time": 1700000000100, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "order_1", "coin": "BTC", "time": 1700000000200, "sz": "1", "px": "90000", "side": "B"},
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = fills

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is not None
        # Very short timespan (< 15 minutes) should return 0
        assert result["orders_per_day"] == 0.0
        assert result["has_btc_eth"] is True


class TestOrdersPerDayCalculation:
    """Test edge cases for orders per day calculation."""

    @pytest.mark.asyncio
    async def test_orders_counted_by_unique_oid(self):
        """Orders should be counted by unique order ID, not by fills."""
        from app.main import analyze_user_fills

        # 3 unique orders, but 10 total fills
        fills = [
            {"oid": "A", "coin": "BTC", "time": 1700000000000, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "A", "coin": "BTC", "time": 1700000000001, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "A", "coin": "BTC", "time": 1700000000002, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "B", "coin": "BTC", "time": 1700043200000, "sz": "1", "px": "90000", "side": "B"},  # +12h
            {"oid": "B", "coin": "BTC", "time": 1700043200001, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "B", "coin": "BTC", "time": 1700043200002, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "B", "coin": "BTC", "time": 1700043200003, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "C", "coin": "BTC", "time": 1700086400000, "sz": "1", "px": "90000", "side": "B"},  # +24h
            {"oid": "C", "coin": "BTC", "time": 1700086400001, "sz": "1", "px": "90000", "side": "B"},
            {"oid": "C", "coin": "BTC", "time": 1700086400002, "sz": "1", "px": "90000", "side": "B"},
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = fills

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await analyze_user_fills(mock_client, "0x1234")

        assert result is not None
        # 3 orders over 1 day = 3 orders/day
        assert 2.5 < result["orders_per_day"] < 3.5
        assert result["fill_count"] == 10
