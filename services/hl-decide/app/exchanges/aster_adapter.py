"""
Aster DEX Exchange Adapter

Implements ExchangeInterface for Aster DEX perp DEX.

Features:
- ECDSA signing with EIP-712 messages
- Agent wallet support
- Automatic precision handling
- Position reconstruction from trades (no position history API)

@module exchanges.aster_adapter
"""

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from .interface import (
    ExchangeInterface,
    ExchangeConfig,
    ExchangeType,
    OrderParams,
    OrderResult,
    OrderSide,
    OrderType,
    Position,
    PositionSide,
    Balance,
    MarketData,
    MarginMode,
)

# Conditional imports for signing
try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_abi import encode
    from web3 import Web3
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False
    Account = None  # type: ignore
    encode_typed_data = None  # type: ignore
    encode = None  # type: ignore
    Web3 = None  # type: ignore


# Aster API endpoints
ASTER_MAINNET_API = "https://api.aster.finance"
ASTER_TESTNET_API = "https://testnet-api.aster.finance"


class AsterAdapter(ExchangeInterface):
    """
    Aster DEX exchange adapter.

    Uses ECDSA signing for order authentication. Similar to Hyperliquid
    but with different API structure.

    Configuration:
        config = ExchangeConfig(
            exchange_type=ExchangeType.ASTER,
            testnet=True,
            private_key_env="ASTER_PRIVATE_KEY",
            account_address_env="ASTER_ACCOUNT_ADDRESS",
        )
        adapter = AsterAdapter(config)
    """

    def __init__(self, config: ExchangeConfig):
        """Initialize Aster adapter."""
        super().__init__(config)

        self._http_client: Optional[httpx.AsyncClient] = None
        self._wallet = None
        self._account_address: Optional[str] = None

        # Symbol precision cache
        self._precision_cache: dict[str, dict] = {}

    @property
    def is_configured(self) -> bool:
        """Check if exchange is properly configured."""
        return CRYPTO_AVAILABLE and bool(self.config.get_private_key())

    @property
    def _base_url(self) -> str:
        """Get API base URL."""
        return ASTER_TESTNET_API if self.config.testnet else ASTER_MAINNET_API

    async def connect(self) -> bool:
        """Connect to Aster API."""
        if not CRYPTO_AVAILABLE:
            print("[aster] Crypto libraries not available - install eth_account, eth_abi, web3")
            return False

        private_key = self.config.get_private_key()
        if not private_key:
            print(f"[aster] Private key not found in {self.config.private_key_env}")
            return False

        try:
            # Create wallet from private key
            self._wallet = Account.from_key(private_key)
            self._account_address = self.config.get_account_address() or self._wallet.address

            if self.config.testnet:
                print("[aster] Using TESTNET")
            else:
                print("[aster] WARNING: Using MAINNET")

            # Create HTTP client
            self._http_client = httpx.AsyncClient(timeout=30)

            # Load symbol precision data
            await self._load_precision_data()

            self._connected = True
            print(f"[aster] Connected as {self._account_address[:10]}...")
            return True

        except Exception as e:
            print(f"[aster] Connection failed: {e}")
            return False

    async def disconnect(self) -> None:
        """Disconnect from Aster API."""
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None
        self._wallet = None
        self._account_address = None
        self._connected = False

    async def _load_precision_data(self) -> None:
        """Load symbol precision information."""
        if not self._http_client:
            return

        try:
            resp = await self._http_client.get(f"{self._base_url}/v1/public/instruments")
            if resp.status_code == 200:
                data = resp.json()
                for instrument in data.get("data", []):
                    symbol = instrument.get("symbol", "")
                    self._precision_cache[symbol] = {
                        "price_precision": instrument.get("pricePrecision", 2),
                        "size_precision": instrument.get("sizePrecision", 4),
                        "min_size": float(instrument.get("minSize", 0.001)),
                        "tick_size": float(instrument.get("tickSize", 0.01)),
                    }
        except Exception as e:
            print(f"[aster] Failed to load precision data: {e}")

    async def _get_http_client(self) -> httpx.AsyncClient:
        """Get HTTP client."""
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=30)
        return self._http_client

    def _generate_signature(self, params: dict) -> tuple[str, int]:
        """
        Generate ECDSA signature for request.

        Returns:
            Tuple of (signature, nonce)
        """
        if not self._wallet or not CRYPTO_AVAILABLE:
            raise ValueError("Wallet not initialized")

        # Generate nonce (microsecond timestamp)
        nonce = int(time.time() * 1_000_000)

        # Encode parameters
        params_str = json.dumps(params, separators=(",", ":"), sort_keys=True)

        # Create message hash
        message = f"{params_str}{self._account_address}{nonce}"
        message_hash = Web3.keccak(text=message)

        # Sign message
        signed = self._wallet.sign_message(
            encode_typed_data(
                domain_data={
                    "name": "Aster",
                    "version": "1",
                    "chainId": 1,
                },
                message_types={
                    "Order": [
                        {"name": "params", "type": "string"},
                        {"name": "user", "type": "address"},
                        {"name": "nonce", "type": "uint256"},
                    ],
                },
                message_data={
                    "params": params_str,
                    "user": self._account_address,
                    "nonce": nonce,
                },
            )
        )

        return signed.signature.hex(), nonce

    async def _signed_request(
        self,
        method: str,
        endpoint: str,
        params: Optional[dict] = None,
    ) -> dict:
        """Make a signed API request."""
        client = await self._get_http_client()
        params = params or {}

        try:
            signature, nonce = self._generate_signature(params)
            headers = {
                "X-Signature": signature,
                "X-Nonce": str(nonce),
                "X-Address": self._account_address,
                "Content-Type": "application/json",
            }

            url = f"{self._base_url}{endpoint}"

            if method.upper() == "GET":
                resp = await client.get(url, params=params, headers=headers)
            else:
                resp = await client.post(url, json=params, headers=headers)

            return resp.json()

        except Exception as e:
            return {"error": str(e)}

    # Account operations

    async def get_balance(self) -> Optional[Balance]:
        """Get account balance."""
        try:
            result = await self._signed_request("GET", "/v1/private/account")

            if "error" in result:
                print(f"[aster] Balance error: {result['error']}")
                return None

            data = result.get("data", {})

            return Balance(
                total_equity=float(data.get("equity", 0)),
                available_balance=float(data.get("availableBalance", 0)),
                margin_used=float(data.get("marginUsed", 0)),
                unrealized_pnl=float(data.get("unrealizedPnl", 0)),
                currency="USD",
                timestamp=datetime.now(timezone.utc),
            )

        except Exception as e:
            print(f"[aster] Failed to get balance: {e}")
            return None

    async def get_positions(self) -> list[Position]:
        """Get all open positions."""
        try:
            result = await self._signed_request("GET", "/v1/private/positions")

            if "error" in result:
                print(f"[aster] Positions error: {result['error']}")
                return []

            positions = []
            for pos_data in result.get("data", []):
                size = float(pos_data.get("size", 0))
                if size == 0:
                    continue

                positions.append(Position(
                    symbol=pos_data.get("symbol", ""),
                    side=PositionSide.LONG if size > 0 else PositionSide.SHORT,
                    size=size,
                    entry_price=float(pos_data.get("entryPrice", 0)),
                    mark_price=float(pos_data.get("markPrice", 0)),
                    liquidation_price=float(pos_data.get("liquidationPrice", 0)) or None,
                    unrealized_pnl=float(pos_data.get("unrealizedPnl", 0)),
                    leverage=int(pos_data.get("leverage", 1)),
                    margin_mode=MarginMode.CROSS if pos_data.get("marginMode") == "cross" else MarginMode.ISOLATED,
                    margin_used=float(pos_data.get("margin", 0)),
                    timestamp=datetime.now(timezone.utc),
                ))

            return positions

        except Exception as e:
            print(f"[aster] Failed to get positions: {e}")
            return []

    async def get_position(self, symbol: str) -> Optional[Position]:
        """Get position for specific symbol."""
        positions = await self.get_positions()
        for pos in positions:
            if pos.symbol == symbol or pos.symbol == self.format_symbol(symbol):
                return pos
        return None

    # Trading operations

    async def open_position(self, params: OrderParams) -> OrderResult:
        """Open a new position."""
        symbol = self.format_symbol(params.symbol)
        mid_price = await self.get_market_price(params.symbol)

        if not mid_price:
            return OrderResult(success=False, error=f"Could not get price for {symbol}")

        try:
            # Set leverage if specified
            if params.leverage:
                await self.set_leverage(symbol, params.leverage)

            # Calculate limit price with slippage buffer
            slippage_mult = 1 + (params.slippage_pct / 100)
            if params.side == OrderSide.BUY:
                limit_price = mid_price * slippage_mult
            else:
                limit_price = mid_price / slippage_mult

            order_params = {
                "symbol": symbol,
                "side": "buy" if params.side == OrderSide.BUY else "sell",
                "type": "limit",
                "size": self.format_quantity(symbol, params.size),
                "price": self.format_price(symbol, limit_price),
                "timeInForce": "IOC",  # Immediate or cancel for market-like execution
                "reduceOnly": params.reduce_only,
            }

            result = await self._signed_request("POST", "/v1/private/orders", order_params)

            return self._parse_order_result(result, mid_price)

        except Exception as e:
            return OrderResult(success=False, error=f"Order failed: {str(e)}")

    async def close_position(
        self,
        symbol: str,
        size: Optional[float] = None,
    ) -> OrderResult:
        """Close position partially or fully."""
        symbol = self.format_symbol(symbol)
        position = await self.get_position(symbol)

        if not position or position.size == 0:
            return OrderResult(success=True, fill_size=0, error="No position to close")

        close_size = abs(size if size else position.size)
        side = OrderSide.SELL if position.size > 0 else OrderSide.BUY

        return await self.open_position(OrderParams(
            symbol=symbol,
            side=side,
            size=close_size,
            reduce_only=True,
            slippage_pct=self.config.default_slippage_pct,
        ))

    async def place_order(self, params: OrderParams) -> OrderResult:
        """Place a generic order."""
        if params.reduce_only:
            return await self.close_position(params.symbol, params.size)

        symbol = self.format_symbol(params.symbol)

        try:
            order_params = {
                "symbol": symbol,
                "side": "buy" if params.side == OrderSide.BUY else "sell",
                "type": "limit" if params.order_type == OrderType.LIMIT else "market",
                "size": self.format_quantity(symbol, params.size),
                "reduceOnly": params.reduce_only,
            }

            if params.order_type == OrderType.LIMIT and params.price:
                order_params["price"] = self.format_price(symbol, params.price)
                order_params["timeInForce"] = "GTC"
            else:
                order_params["timeInForce"] = "IOC"

            result = await self._signed_request("POST", "/v1/private/orders", order_params)
            return self._parse_order_result(result, params.price)

        except Exception as e:
            return OrderResult(success=False, error=f"Order failed: {str(e)}")

    def _parse_order_result(
        self,
        result: dict,
        reference_price: Optional[float] = None,
    ) -> OrderResult:
        """Parse API response into OrderResult."""
        if "error" in result:
            return OrderResult(success=False, error=result["error"], status="rejected")

        data = result.get("data", {})

        if data.get("status") in ("filled", "partiallyFilled"):
            fill_price = float(data.get("avgPrice", 0))
            fill_size = float(data.get("filledSize", 0))
            slippage = (
                abs(fill_price - reference_price) / reference_price * 100
                if reference_price and reference_price > 0
                else None
            )

            return OrderResult(
                success=True,
                order_id=data.get("orderId"),
                fill_price=fill_price,
                fill_size=fill_size,
                filled_pct=float(data.get("filledPercent", 100)),
                status=data.get("status", "filled"),
                slippage_actual=slippage,
                fees=float(data.get("fee", 0)),
                raw_response=result,
            )

        elif data.get("status") == "pending":
            return OrderResult(
                success=True,
                order_id=data.get("orderId"),
                status="pending",
                raw_response=result,
            )

        return OrderResult(
            success=False,
            error=f"Unexpected status: {data.get('status')}",
            raw_response=result,
        )

    # Order management

    async def get_order_status(self, order_id: str) -> Optional[dict]:
        """Get status of an order."""
        try:
            result = await self._signed_request(
                "GET",
                "/v1/private/orders",
                {"orderId": order_id},
            )

            if "error" in result:
                return None

            return result.get("data")

        except Exception as e:
            print(f"[aster] Failed to get order status: {e}")
            return None

    async def cancel_order(self, symbol: str, order_id: str) -> bool:
        """Cancel a specific order."""
        try:
            result = await self._signed_request(
                "POST",
                "/v1/private/orders/cancel",
                {"orderId": order_id},
            )
            return "error" not in result

        except Exception as e:
            print(f"[aster] Failed to cancel order: {e}")
            return False

    async def cancel_all_orders(self, symbol: Optional[str] = None) -> int:
        """Cancel all open orders."""
        try:
            params = {}
            if symbol:
                params["symbol"] = self.format_symbol(symbol)

            result = await self._signed_request(
                "POST",
                "/v1/private/orders/cancel-all",
                params,
            )

            return result.get("data", {}).get("cancelledCount", 0)

        except Exception as e:
            print(f"[aster] Failed to cancel orders: {e}")
            return 0

    # Risk management

    async def set_leverage(self, symbol: str, leverage: int) -> bool:
        """Set leverage for a symbol."""
        try:
            result = await self._signed_request(
                "POST",
                "/v1/private/leverage",
                {
                    "symbol": self.format_symbol(symbol),
                    "leverage": leverage,
                },
            )
            return "error" not in result

        except Exception as e:
            print(f"[aster] Failed to set leverage: {e}")
            return False

    async def set_stop_loss(
        self,
        symbol: str,
        stop_price: float,
        size: Optional[float] = None,
    ) -> OrderResult:
        """Set stop-loss order."""
        symbol = self.format_symbol(symbol)
        position = await self.get_position(symbol)

        if not position:
            return OrderResult(success=False, error="No position for stop-loss")

        try:
            order_size = abs(size if size else position.size)
            side = "sell" if position.size > 0 else "buy"

            result = await self._signed_request(
                "POST",
                "/v1/private/conditional-orders",
                {
                    "symbol": symbol,
                    "side": side,
                    "type": "stopLoss",
                    "size": self.format_quantity(symbol, order_size),
                    "triggerPrice": self.format_price(symbol, stop_price),
                    "reduceOnly": True,
                },
            )

            return self._parse_order_result(result, stop_price)

        except Exception as e:
            return OrderResult(success=False, error=f"Stop-loss failed: {str(e)}")

    async def set_take_profit(
        self,
        symbol: str,
        take_profit_price: float,
        size: Optional[float] = None,
    ) -> OrderResult:
        """Set take-profit order."""
        symbol = self.format_symbol(symbol)
        position = await self.get_position(symbol)

        if not position:
            return OrderResult(success=False, error="No position for take-profit")

        try:
            order_size = abs(size if size else position.size)
            side = "sell" if position.size > 0 else "buy"

            result = await self._signed_request(
                "POST",
                "/v1/private/conditional-orders",
                {
                    "symbol": symbol,
                    "side": side,
                    "type": "takeProfit",
                    "size": self.format_quantity(symbol, order_size),
                    "triggerPrice": self.format_price(symbol, take_profit_price),
                    "reduceOnly": True,
                },
            )

            return self._parse_order_result(result, take_profit_price)

        except Exception as e:
            return OrderResult(success=False, error=f"Take-profit failed: {str(e)}")

    async def cancel_stop_orders(self, symbol: str) -> int:
        """
        Cancel all stop-loss and take-profit orders for a symbol.

        Args:
            symbol: Trading pair symbol

        Returns:
            Number of orders cancelled
        """
        try:
            formatted_symbol = self.format_symbol(symbol)

            result = await self._signed_request(
                "POST",
                "/v1/private/conditional-orders/cancel-all",
                {"symbol": formatted_symbol},
            )

            if "error" in result:
                print(f"[aster] Failed to cancel stop orders: {result['error']}")
                return 0

            return result.get("data", {}).get("cancelledCount", 0)

        except Exception as e:
            print(f"[aster] Failed to cancel stop orders: {e}")
            return 0

    # Market data

    async def get_market_price(self, symbol: str) -> Optional[float]:
        """Get current market mid price."""
        try:
            client = await self._get_http_client()
            resp = await client.get(
                f"{self._base_url}/v1/public/ticker",
                params={"symbol": self.format_symbol(symbol)},
            )

            if resp.status_code == 200:
                data = resp.json().get("data", {})
                bid = float(data.get("bestBid", 0))
                ask = float(data.get("bestAsk", 0))
                return (bid + ask) / 2 if bid and ask else None

            return None

        except Exception as e:
            print(f"[aster] Failed to get price: {e}")
            return None

    async def get_market_data(self, symbol: str) -> Optional[MarketData]:
        """Get full market data."""
        try:
            client = await self._get_http_client()
            resp = await client.get(
                f"{self._base_url}/v1/public/ticker",
                params={"symbol": self.format_symbol(symbol)},
            )

            if resp.status_code == 200:
                data = resp.json().get("data", {})

                return MarketData(
                    symbol=symbol,
                    bid=float(data.get("bestBid", 0)),
                    ask=float(data.get("bestAsk", 0)),
                    last=float(data.get("lastPrice", 0)),
                    mark_price=float(data.get("markPrice", 0)),
                    index_price=float(data.get("indexPrice", 0)) or None,
                    funding_rate=float(data.get("fundingRate", 0)) or None,
                    volume_24h=float(data.get("volume24h", 0)) or None,
                    timestamp=datetime.now(timezone.utc),
                )

            return None

        except Exception as e:
            print(f"[aster] Failed to get market data: {e}")
            return None

    # Utility methods

    def format_symbol(self, symbol: str) -> str:
        """Format symbol for Aster (add -PERP suffix if needed)."""
        symbol = symbol.upper()
        if not symbol.endswith("-PERP"):
            return f"{symbol}-PERP"
        return symbol

    def format_quantity(self, symbol: str, quantity: float) -> float:
        """Format quantity to exchange precision."""
        precision_data = self._precision_cache.get(
            self.format_symbol(symbol),
            {"size_precision": 4},
        )
        decimals = precision_data.get("size_precision", 4)
        factor = 10 ** decimals
        return int(quantity * factor) / factor

    def format_price(self, symbol: str, price: float) -> float:
        """Format price to exchange precision."""
        precision_data = self._precision_cache.get(
            self.format_symbol(symbol),
            {"price_precision": 2},
        )
        decimals = precision_data.get("price_precision", 2)
        factor = 10 ** decimals
        return int(price * factor) / factor
