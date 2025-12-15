"""
Bybit Exchange Adapter

Implements ExchangeInterface for Bybit perpetual futures trading.
Uses pybit SDK for API communication with USDT linear perpetuals.

API v5 unified endpoint for all products.
Default category: linear (USDT perpetuals)

@module exchanges.bybit_adapter
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from .interface import (
    Balance,
    ExchangeConfig,
    ExchangeInterface,
    ExchangeType,
    MarginMode,
    MarketData,
    OrderParams,
    OrderResult,
    OrderSide,
    OrderType,
    Position,
    PositionSide,
)

logger = logging.getLogger(__name__)

# Symbol precision cache (qty decimals, price decimals)
DEFAULT_PRECISION = {"qty": 3, "price": 1}
SYMBOL_PRECISION: dict[str, dict[str, int]] = {
    "BTCUSDT": {"qty": 3, "price": 1},
    "ETHUSDT": {"qty": 2, "price": 2},
}


class BybitAdapter(ExchangeInterface):
    """
    Bybit exchange adapter for USDT perpetual futures.

    Uses pybit SDK for API communication.
    Supports one-way mode (hedge mode not implemented).

    Environment variables for credentials:
    - BYBIT_API_KEY: API key
    - BYBIT_API_SECRET: API secret

    Example:
        config = ExchangeConfig(
            exchange_type=ExchangeType.BYBIT,
            testnet=True,
            api_key_env="BYBIT_API_KEY",
            api_secret_env="BYBIT_API_SECRET",
        )
        adapter = BybitAdapter(config)
        await adapter.connect()
    """

    # Bybit API category for USDT perpetuals
    CATEGORY = "linear"

    # API endpoints
    MAINNET_URL = "https://api.bybit.com"
    TESTNET_URL = "https://api-testnet.bybit.com"

    def __init__(self, config: ExchangeConfig):
        """
        Initialize Bybit adapter.

        Args:
            config: Exchange configuration with API credentials
        """
        super().__init__(config)

        if config.exchange_type != ExchangeType.BYBIT:
            raise ValueError(
                f"Invalid exchange type: {config.exchange_type}, expected BYBIT"
            )

        self._client: Any = None
        self._symbol_info: dict[str, dict] = {}
        self._last_leverage: dict[str, int] = {}

    @property
    def is_configured(self) -> bool:
        """Check if exchange is properly configured with API credentials."""
        api_key = self.config.get_api_key()
        api_secret = self.config.get_api_secret()
        return bool(api_key and api_secret)

    async def connect(self) -> bool:
        """
        Connect to Bybit API.

        Returns:
            True if connection successful
        """
        if self._connected:
            return True

        try:
            # Lazy import to avoid requiring pybit if not using Bybit
            from pybit.unified_trading import HTTP

            api_key = self.config.get_api_key()
            api_secret = self.config.get_api_secret()

            if not api_key or not api_secret:
                logger.error("Bybit API key or secret not configured")
                return False

            self._client = HTTP(
                testnet=self.config.testnet,
                api_key=api_key,
                api_secret=api_secret,
            )

            # Test connection by fetching account info
            response = await asyncio.to_thread(
                self._client.get_wallet_balance,
                accountType="UNIFIED",
            )

            if response.get("retCode") == 0:
                self._connected = True
                logger.info(
                    f"Connected to Bybit {'testnet' if self.config.testnet else 'mainnet'}"
                )

                # Pre-load symbol info for common pairs
                await self._load_symbol_info()
                return True
            else:
                logger.error(f"Bybit connection failed: {response.get('retMsg')}")
                return False

        except ImportError:
            logger.error("pybit package not installed. Run: pip install pybit")
            return False
        except Exception as e:
            logger.error(f"Bybit connection error: {e}")
            return False

    async def disconnect(self) -> None:
        """Disconnect from Bybit API."""
        self._client = None
        self._connected = False
        self._symbol_info.clear()
        logger.info("Disconnected from Bybit")

    async def _load_symbol_info(self) -> None:
        """Load instrument info for symbol precision."""
        try:
            response = await asyncio.to_thread(
                self._client.get_instruments_info,
                category=self.CATEGORY,
            )

            if response.get("retCode") == 0:
                for item in response.get("result", {}).get("list", []):
                    symbol = item.get("symbol", "")
                    self._symbol_info[symbol] = item

                    # Extract precision from lot/tick sizes
                    lot_filter = item.get("lotSizeFilter", {})
                    price_filter = item.get("priceFilter", {})

                    qty_step = lot_filter.get("qtyStep", "0.001")
                    tick_size = price_filter.get("tickSize", "0.1")

                    SYMBOL_PRECISION[symbol] = {
                        "qty": self._decimals_from_step(qty_step),
                        "price": self._decimals_from_step(tick_size),
                    }

                logger.info(f"Loaded {len(self._symbol_info)} Bybit symbols")

        except Exception as e:
            logger.warning(f"Failed to load Bybit symbol info: {e}")

    def _decimals_from_step(self, step: str) -> int:
        """Calculate decimal places from step size string."""
        if "." not in step:
            return 0
        return len(step.split(".")[1].rstrip("0"))

    async def get_balance(self) -> Optional[Balance]:
        """
        Get account balance.

        Returns:
            Balance object or None if unavailable
        """
        if not self._connected or not self._client:
            return None

        try:
            response = await asyncio.to_thread(
                self._client.get_wallet_balance,
                accountType="UNIFIED",
            )

            if response.get("retCode") != 0:
                logger.error(f"Failed to get balance: {response.get('retMsg')}")
                return None

            # Find USDT coin balance
            result = response.get("result", {})
            for account in result.get("list", []):
                for coin in account.get("coin", []):
                    if coin.get("coin") == "USDT":
                        return Balance(
                            total_equity=float(coin.get("equity", 0)),
                            available_balance=float(
                                coin.get("availableToWithdraw", 0)
                            ),
                            margin_used=float(coin.get("totalPositionMM", 0)),
                            unrealized_pnl=float(coin.get("unrealisedPnl", 0)),
                            realized_pnl_today=float(coin.get("cumRealisedPnl", 0)),
                            currency="USDT",
                            timestamp=datetime.now(timezone.utc),
                        )

            return None

        except Exception as e:
            logger.error(f"Error getting Bybit balance: {e}")
            return None

    async def get_positions(self) -> list[Position]:
        """
        Get all open positions.

        Returns:
            List of Position objects
        """
        if not self._connected or not self._client:
            return []

        try:
            response = await asyncio.to_thread(
                self._client.get_positions,
                category=self.CATEGORY,
                settleCoin="USDT",
            )

            if response.get("retCode") != 0:
                logger.error(f"Failed to get positions: {response.get('retMsg')}")
                return []

            positions = []
            for item in response.get("result", {}).get("list", []):
                size = float(item.get("size", 0))
                if size == 0:
                    continue

                side_str = item.get("side", "")
                side = PositionSide.LONG if side_str == "Buy" else PositionSide.SHORT

                # Bybit uses positive size for both sides, direction in "side"
                if side == PositionSide.SHORT:
                    size = -size

                positions.append(
                    Position(
                        symbol=item.get("symbol", ""),
                        side=side,
                        size=size,
                        entry_price=float(item.get("avgPrice", 0)),
                        mark_price=float(item.get("markPrice", 0)),
                        liquidation_price=float(item.get("liqPrice", 0)) or None,
                        unrealized_pnl=float(item.get("unrealisedPnl", 0)),
                        realized_pnl=float(item.get("cumRealisedPnl", 0)),
                        leverage=int(float(item.get("leverage", 1))),
                        margin_mode=(
                            MarginMode.ISOLATED
                            if item.get("tradeMode") == 1
                            else MarginMode.CROSS
                        ),
                        margin_used=float(item.get("positionMM", 0)),
                        timestamp=datetime.now(timezone.utc),
                    )
                )

            return positions

        except Exception as e:
            logger.error(f"Error getting Bybit positions: {e}")
            return []

    async def get_position(self, symbol: str) -> Optional[Position]:
        """
        Get position for specific symbol.

        Args:
            symbol: Trading pair symbol

        Returns:
            Position object or None if no position
        """
        formatted_symbol = self.format_symbol(symbol)
        positions = await self.get_positions()

        for pos in positions:
            if pos.symbol == formatted_symbol:
                return pos

        return None

    async def open_position(self, params: OrderParams) -> OrderResult:
        """
        Open a new position or add to existing.

        Args:
            params: Order parameters

        Returns:
            OrderResult with fill details
        """
        # Set leverage first if specified
        if params.leverage:
            formatted_symbol = self.format_symbol(params.symbol)
            await self.set_leverage(formatted_symbol, params.leverage)

        return await self.place_order(params)

    async def close_position(
        self,
        symbol: str,
        size: Optional[float] = None,
    ) -> OrderResult:
        """
        Close position partially or fully.

        Args:
            symbol: Trading pair symbol
            size: Size to close (None for full close)

        Returns:
            OrderResult with fill details
        """
        position = await self.get_position(symbol)

        if not position:
            return OrderResult(
                success=False,
                error=f"No position found for {symbol}",
                timestamp=datetime.now(timezone.utc),
            )

        # Determine close size
        close_size = abs(size) if size else abs(position.size)

        # Close direction is opposite of position
        close_side = OrderSide.SELL if position.is_long else OrderSide.BUY

        return await self.place_order(
            OrderParams(
                symbol=symbol,
                side=close_side,
                size=close_size,
                order_type=OrderType.MARKET,
                reduce_only=True,
            )
        )

    async def place_order(self, params: OrderParams) -> OrderResult:
        """
        Place a generic order.

        Args:
            params: Order parameters

        Returns:
            OrderResult with order details
        """
        if not self._connected or not self._client:
            return OrderResult(
                success=False,
                error="Not connected to Bybit",
                timestamp=datetime.now(timezone.utc),
            )

        try:
            formatted_symbol = self.format_symbol(params.symbol)
            formatted_qty = self.format_quantity(formatted_symbol, params.size)

            # Build order params
            order_params: dict[str, Any] = {
                "category": self.CATEGORY,
                "symbol": formatted_symbol,
                "side": "Buy" if params.side == OrderSide.BUY else "Sell",
                "orderType": "Market" if params.order_type == OrderType.MARKET else "Limit",
                "qty": str(formatted_qty),
                "positionIdx": 0,  # One-way mode
            }

            # Add limit price
            if params.order_type == OrderType.LIMIT and params.price:
                formatted_price = self.format_price(formatted_symbol, params.price)
                order_params["price"] = str(formatted_price)
                order_params["timeInForce"] = "GTC"

            # Add reduce only flag
            if params.reduce_only:
                order_params["reduceOnly"] = True

            # Add stop loss/take profit if specified
            if params.stop_loss:
                order_params["stopLoss"] = str(
                    self.format_price(formatted_symbol, params.stop_loss)
                )
                order_params["slOrderType"] = "Market"

            if params.take_profit:
                order_params["takeProfit"] = str(
                    self.format_price(formatted_symbol, params.take_profit)
                )
                order_params["tpOrderType"] = "Market"

            # Add client order id if specified
            if params.client_order_id:
                order_params["orderLinkId"] = params.client_order_id

            logger.info(f"Placing Bybit order: {order_params}")

            response = await asyncio.to_thread(
                self._client.place_order,
                **order_params,
            )

            if response.get("retCode") != 0:
                return OrderResult(
                    success=False,
                    error=response.get("retMsg", "Unknown error"),
                    raw_response=response,
                    timestamp=datetime.now(timezone.utc),
                )

            result = response.get("result", {})
            order_id = result.get("orderId", "")

            # For market orders, get fill info
            fill_price = None
            fill_size = None
            status = "pending"

            if params.order_type == OrderType.MARKET:
                # Wait briefly for fill
                await asyncio.sleep(0.5)
                order_status = await self.get_order_status(order_id)

                if order_status:
                    fill_price = float(order_status.get("avgPrice", 0)) or None
                    fill_size = float(order_status.get("cumExecQty", 0)) or None
                    status = order_status.get("orderStatus", "pending").lower()

            return OrderResult(
                success=True,
                order_id=order_id,
                client_order_id=params.client_order_id,
                fill_price=fill_price,
                fill_size=fill_size,
                filled_pct=100.0 if status == "filled" else 0.0,
                status=status,
                fees=float(result.get("cumExecFee", 0)),
                raw_response=response,
                timestamp=datetime.now(timezone.utc),
            )

        except Exception as e:
            logger.error(f"Error placing Bybit order: {e}")
            return OrderResult(
                success=False,
                error=str(e),
                timestamp=datetime.now(timezone.utc),
            )

    async def get_order_status(self, order_id: str) -> Optional[dict]:
        """
        Get status of an order.

        Args:
            order_id: Order ID

        Returns:
            Order status dict or None
        """
        if not self._connected or not self._client:
            return None

        try:
            response = await asyncio.to_thread(
                self._client.get_order_history,
                category=self.CATEGORY,
                orderId=order_id,
            )

            if response.get("retCode") != 0:
                return None

            orders = response.get("result", {}).get("list", [])
            return orders[0] if orders else None

        except Exception as e:
            logger.error(f"Error getting Bybit order status: {e}")
            return None

    async def cancel_order(self, symbol: str, order_id: str) -> bool:
        """
        Cancel a specific order.

        Args:
            symbol: Trading pair symbol
            order_id: Order ID to cancel

        Returns:
            True if cancelled successfully
        """
        if not self._connected or not self._client:
            return False

        try:
            formatted_symbol = self.format_symbol(symbol)

            response = await asyncio.to_thread(
                self._client.cancel_order,
                category=self.CATEGORY,
                symbol=formatted_symbol,
                orderId=order_id,
            )

            success = response.get("retCode") == 0
            if not success:
                logger.error(f"Failed to cancel order: {response.get('retMsg')}")

            return success

        except Exception as e:
            logger.error(f"Error cancelling Bybit order: {e}")
            return False

    async def cancel_all_orders(self, symbol: Optional[str] = None) -> int:
        """
        Cancel all open orders.

        Args:
            symbol: Optional symbol to filter (None = all symbols)

        Returns:
            Number of orders cancelled
        """
        if not self._connected or not self._client:
            return 0

        try:
            params: dict[str, Any] = {"category": self.CATEGORY}

            if symbol:
                params["symbol"] = self.format_symbol(symbol)

            response = await asyncio.to_thread(
                self._client.cancel_all_orders,
                **params,
            )

            if response.get("retCode") != 0:
                logger.error(f"Failed to cancel all orders: {response.get('retMsg')}")
                return 0

            cancelled = response.get("result", {}).get("list", [])
            return len(cancelled)

        except Exception as e:
            logger.error(f"Error cancelling all Bybit orders: {e}")
            return 0

    async def set_leverage(self, symbol: str, leverage: int) -> bool:
        """
        Set leverage for a symbol.

        Args:
            symbol: Trading pair symbol
            leverage: Leverage multiplier

        Returns:
            True if set successfully
        """
        if not self._connected or not self._client:
            return False

        try:
            formatted_symbol = self.format_symbol(symbol)

            # Skip if leverage already set
            if self._last_leverage.get(formatted_symbol) == leverage:
                return True

            response = await asyncio.to_thread(
                self._client.set_leverage,
                category=self.CATEGORY,
                symbol=formatted_symbol,
                buyLeverage=str(leverage),
                sellLeverage=str(leverage),  # Must match in one-way mode
            )

            # retCode 110043 means leverage already set
            if response.get("retCode") in [0, 110043]:
                self._last_leverage[formatted_symbol] = leverage
                logger.info(f"Set leverage for {formatted_symbol}: {leverage}x")
                return True
            else:
                logger.error(f"Failed to set leverage: {response.get('retMsg')}")
                return False

        except Exception as e:
            logger.error(f"Error setting Bybit leverage: {e}")
            return False

    async def set_stop_loss(
        self,
        symbol: str,
        stop_price: float,
        size: Optional[float] = None,
    ) -> OrderResult:
        """
        Set stop-loss order for position.

        Args:
            symbol: Trading pair symbol
            stop_price: Stop trigger price
            size: Size to close (None = full position)

        Returns:
            OrderResult with stop order details
        """
        if not self._connected or not self._client:
            return OrderResult(
                success=False,
                error="Not connected to Bybit",
                timestamp=datetime.now(timezone.utc),
            )

        try:
            position = await self.get_position(symbol)
            if not position:
                return OrderResult(
                    success=False,
                    error=f"No position found for {symbol}",
                    timestamp=datetime.now(timezone.utc),
                )

            formatted_symbol = self.format_symbol(symbol)
            formatted_price = self.format_price(formatted_symbol, stop_price)

            response = await asyncio.to_thread(
                self._client.set_trading_stop,
                category=self.CATEGORY,
                symbol=formatted_symbol,
                stopLoss=str(formatted_price),
                slSize=str(size) if size else None,
                slTriggerBy="MarkPrice",
                positionIdx=0,
            )

            if response.get("retCode") != 0:
                return OrderResult(
                    success=False,
                    error=response.get("retMsg", "Unknown error"),
                    raw_response=response,
                    timestamp=datetime.now(timezone.utc),
                )

            return OrderResult(
                success=True,
                status="set",
                raw_response=response,
                timestamp=datetime.now(timezone.utc),
            )

        except Exception as e:
            logger.error(f"Error setting Bybit stop loss: {e}")
            return OrderResult(
                success=False,
                error=str(e),
                timestamp=datetime.now(timezone.utc),
            )

    async def set_take_profit(
        self,
        symbol: str,
        take_profit_price: float,
        size: Optional[float] = None,
    ) -> OrderResult:
        """
        Set take-profit order for position.

        Args:
            symbol: Trading pair symbol
            take_profit_price: Take profit trigger price
            size: Size to close (None = full position)

        Returns:
            OrderResult with take profit order details
        """
        if not self._connected or not self._client:
            return OrderResult(
                success=False,
                error="Not connected to Bybit",
                timestamp=datetime.now(timezone.utc),
            )

        try:
            position = await self.get_position(symbol)
            if not position:
                return OrderResult(
                    success=False,
                    error=f"No position found for {symbol}",
                    timestamp=datetime.now(timezone.utc),
                )

            formatted_symbol = self.format_symbol(symbol)
            formatted_price = self.format_price(formatted_symbol, take_profit_price)

            response = await asyncio.to_thread(
                self._client.set_trading_stop,
                category=self.CATEGORY,
                symbol=formatted_symbol,
                takeProfit=str(formatted_price),
                tpSize=str(size) if size else None,
                tpTriggerBy="MarkPrice",
                positionIdx=0,
            )

            if response.get("retCode") != 0:
                return OrderResult(
                    success=False,
                    error=response.get("retMsg", "Unknown error"),
                    raw_response=response,
                    timestamp=datetime.now(timezone.utc),
                )

            return OrderResult(
                success=True,
                status="set",
                raw_response=response,
                timestamp=datetime.now(timezone.utc),
            )

        except Exception as e:
            logger.error(f"Error setting Bybit take profit: {e}")
            return OrderResult(
                success=False,
                error=str(e),
                timestamp=datetime.now(timezone.utc),
            )

    async def cancel_stop_orders(self, symbol: str) -> int:
        """
        Cancel all stop-loss and take-profit orders for a symbol.

        Uses Bybit's set_trading_stop with 0 values to clear SL/TP.

        Args:
            symbol: Trading pair symbol

        Returns:
            Number of orders cancelled (0-2 for Bybit)
        """
        if not self._connected or not self._client:
            return 0

        try:
            formatted_symbol = self.format_symbol(symbol)

            # Bybit uses set_trading_stop with stopLoss=0 and takeProfit=0 to clear
            response = await asyncio.to_thread(
                self._client.set_trading_stop,
                category=self.CATEGORY,
                symbol=formatted_symbol,
                stopLoss="0",
                takeProfit="0",
                positionIdx=0,
            )

            if response.get("retCode") == 0:
                logger.info(f"Cancelled stop orders for {formatted_symbol}")
                return 2  # Cleared both SL and TP

            # 110020: No trading stop to cancel (position has no stops)
            if response.get("retCode") == 110020:
                return 0

            logger.error(f"Failed to cancel stop orders: {response.get('retMsg')}")
            return 0

        except Exception as e:
            logger.error(f"Error cancelling Bybit stop orders: {e}")
            return 0

    async def get_market_price(self, symbol: str) -> Optional[float]:
        """
        Get current market mid price.

        Args:
            symbol: Trading pair symbol

        Returns:
            Mid price or None if unavailable
        """
        market_data = await self.get_market_data(symbol)
        return market_data.mid_price if market_data else None

    async def get_market_data(self, symbol: str) -> Optional[MarketData]:
        """
        Get full market data including bid/ask.

        Args:
            symbol: Trading pair symbol

        Returns:
            MarketData object or None
        """
        if not self._connected or not self._client:
            return None

        try:
            formatted_symbol = self.format_symbol(symbol)

            response = await asyncio.to_thread(
                self._client.get_tickers,
                category=self.CATEGORY,
                symbol=formatted_symbol,
            )

            if response.get("retCode") != 0:
                return None

            tickers = response.get("result", {}).get("list", [])
            if not tickers:
                return None

            ticker = tickers[0]

            return MarketData(
                symbol=formatted_symbol,
                bid=float(ticker.get("bid1Price", 0)),
                ask=float(ticker.get("ask1Price", 0)),
                last=float(ticker.get("lastPrice", 0)),
                mark_price=float(ticker.get("markPrice", 0)),
                index_price=float(ticker.get("indexPrice", 0)),
                funding_rate=float(ticker.get("fundingRate", 0)),
                volume_24h=float(ticker.get("volume24h", 0)),
                timestamp=datetime.now(timezone.utc),
            )

        except Exception as e:
            logger.error(f"Error getting Bybit market data: {e}")
            return None

    def format_symbol(self, symbol: str) -> str:
        """
        Format symbol to Bybit format (BTCUSDT).

        Args:
            symbol: Generic symbol (e.g., "BTC", "BTC-PERP", "BTCUSDT")

        Returns:
            Bybit format symbol (e.g., "BTCUSDT")
        """
        # Already in Bybit format
        if symbol.endswith("USDT"):
            return symbol.upper()

        # Remove suffixes
        clean = symbol.upper()
        for suffix in ["-PERP", "-USD", "/USDT", "/USD"]:
            clean = clean.replace(suffix, "")

        return f"{clean}USDT"

    def format_quantity(self, symbol: str, quantity: float) -> float:
        """
        Format quantity to exchange precision.

        Args:
            symbol: Trading pair symbol
            quantity: Raw quantity

        Returns:
            Quantity rounded to exchange precision
        """
        formatted_symbol = self.format_symbol(symbol)
        precision = SYMBOL_PRECISION.get(formatted_symbol, DEFAULT_PRECISION)
        decimals = precision["qty"]
        return round(quantity, decimals)

    def format_price(self, symbol: str, price: float) -> float:
        """
        Format price to exchange precision.

        Args:
            symbol: Trading pair symbol
            price: Raw price

        Returns:
            Price rounded to exchange precision
        """
        formatted_symbol = self.format_symbol(symbol)
        precision = SYMBOL_PRECISION.get(formatted_symbol, DEFAULT_PRECISION)
        decimals = precision["price"]
        return round(price, decimals)
