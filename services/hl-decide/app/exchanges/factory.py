"""
Exchange Factory

Creates and manages exchange adapter instances.
Provides a unified way to instantiate exchange connections.

@module exchanges.factory
"""

import logging
from typing import Optional

from .interface import ExchangeConfig, ExchangeInterface, ExchangeType

logger = logging.getLogger(__name__)

# Registry of exchange adapters (lazy loaded)
_exchange_registry: dict[ExchangeType, type[ExchangeInterface]] = {}


def _ensure_registry() -> None:
    """Ensure exchange classes are registered."""
    global _exchange_registry

    if _exchange_registry:
        return

    # Lazy import to avoid circular dependencies and optional deps
    try:
        from .hyperliquid_adapter import HyperliquidAdapter

        _exchange_registry[ExchangeType.HYPERLIQUID] = HyperliquidAdapter
    except ImportError as e:
        logger.warning(f"Hyperliquid adapter not available: {e}")

    try:
        from .aster_adapter import AsterAdapter

        _exchange_registry[ExchangeType.ASTER] = AsterAdapter
    except ImportError as e:
        logger.warning(f"Aster adapter not available: {e}")

    try:
        from .bybit_adapter import BybitAdapter

        _exchange_registry[ExchangeType.BYBIT] = BybitAdapter
    except ImportError as e:
        logger.warning(f"Bybit adapter not available: {e}")


def create_exchange(config: ExchangeConfig) -> ExchangeInterface:
    """
    Create an exchange adapter instance.

    Args:
        config: Exchange configuration

    Returns:
        Exchange adapter instance

    Raises:
        ValueError: If exchange type is not supported
    """
    _ensure_registry()

    exchange_type = config.exchange_type
    adapter_class = _exchange_registry.get(exchange_type)

    if not adapter_class:
        available = list_available_exchanges()
        raise ValueError(
            f"Exchange type '{exchange_type}' not supported. "
            f"Available: {available}"
        )

    return adapter_class(config)


def get_exchange(
    exchange_type: ExchangeType,
    testnet: bool = True,
    **config_overrides,
) -> ExchangeInterface:
    """
    Get exchange adapter with default configuration.

    Uses standard environment variable names for credentials:
    - Hyperliquid: HL_PRIVATE_KEY, HL_ACCOUNT_ADDRESS
    - Aster: ASTER_PRIVATE_KEY, ASTER_ACCOUNT_ADDRESS
    - Bybit: BYBIT_API_KEY, BYBIT_API_SECRET

    Args:
        exchange_type: Type of exchange
        testnet: Use testnet (default True)
        **config_overrides: Override default config values

    Returns:
        Exchange adapter instance
    """
    # Default environment variable mappings
    default_configs = {
        ExchangeType.HYPERLIQUID: {
            "private_key_env": "HL_PRIVATE_KEY",
            "account_address_env": "HL_ACCOUNT_ADDRESS",
        },
        ExchangeType.ASTER: {
            "private_key_env": "ASTER_PRIVATE_KEY",
            "account_address_env": "ASTER_ACCOUNT_ADDRESS",
        },
        ExchangeType.BYBIT: {
            "api_key_env": "BYBIT_API_KEY",
            "api_secret_env": "BYBIT_API_SECRET",
        },
    }

    # Build config
    default = default_configs.get(exchange_type, {})
    default.update(config_overrides)

    config = ExchangeConfig(
        exchange_type=exchange_type,
        testnet=testnet,
        **default,
    )

    return create_exchange(config)


def list_available_exchanges() -> list[str]:
    """
    List available exchange adapters.

    Returns:
        List of exchange type names
    """
    _ensure_registry()
    return [ex.value for ex in _exchange_registry.keys()]


def is_exchange_available(exchange_type: ExchangeType) -> bool:
    """
    Check if an exchange adapter is available.

    Args:
        exchange_type: Type of exchange

    Returns:
        True if adapter is available
    """
    _ensure_registry()
    return exchange_type in _exchange_registry


async def connect_exchange(
    exchange_type: ExchangeType,
    testnet: bool = True,
    **config_overrides,
) -> Optional[ExchangeInterface]:
    """
    Get and connect to an exchange.

    Convenience function that creates adapter and connects.

    Args:
        exchange_type: Type of exchange
        testnet: Use testnet (default True)
        **config_overrides: Override default config values

    Returns:
        Connected exchange adapter or None if connection failed
    """
    try:
        exchange = get_exchange(exchange_type, testnet, **config_overrides)

        if not exchange.is_configured:
            logger.error(f"Exchange {exchange_type} not configured (missing credentials)")
            return None

        if await exchange.connect():
            return exchange
        else:
            logger.error(f"Failed to connect to {exchange_type}")
            return None

    except Exception as e:
        logger.error(f"Error connecting to {exchange_type}: {e}")
        return None
