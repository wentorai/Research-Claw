"""FastMCP server exposing the unified Chinese-finance toolset."""

from __future__ import annotations

import logging

from mcp.server.fastmcp import FastMCP

from wind_cn_mcp.models import (
    FinancialStatement,
    HistoryBar,
    MacroSeries,
    ProviderStatus,
    Quote,
    StatementKind,
)
from wind_cn_mcp.registry import ProviderRegistry, default_registry

log = logging.getLogger(__name__)


def build_server(registry: ProviderRegistry | None = None) -> FastMCP:
    """Construct a FastMCP server backed by ``registry`` (or the default lineup).

    Exposed tools:
      * ``get_quote(symbol, provider=None)``
      * ``get_history(symbol, start, end, freq='D', provider=None)``
      * ``get_financials(symbol, statement, period, provider=None)``
      * ``get_macro(indicator, start, end, provider=None)``
      * ``list_providers()``
    """

    reg = registry or default_registry()
    mcp = FastMCP("wind-cn-mcp")

    @mcp.tool()
    async def get_quote(symbol: str, provider: str | None = None) -> Quote:
        """Realtime / latest quote for a Chinese A-share or HK/US ticker.

        Args:
            symbol: Tushare-style code, e.g. ``600519.SH``.
            provider: Force a specific provider name (skips fallback).
        """

        return await reg.call(lambda p: p.get_quote(symbol), prefer=provider)

    @mcp.tool()
    async def get_history(
        symbol: str,
        start: str,
        end: str,
        freq: str = "D",
        provider: str | None = None,
    ) -> list[HistoryBar]:
        """Historical OHLCV bars between ``start`` and ``end`` (YYYYMMDD)."""

        return await reg.call(
            lambda p: p.get_history(symbol, start, end, freq), prefer=provider
        )

    @mcp.tool()
    async def get_financials(
        symbol: str,
        statement: StatementKind,
        period: str,
        provider: str | None = None,
    ) -> FinancialStatement:
        """Periodic financial statement for ``symbol``.

        Args:
            statement: ``income`` | ``balance`` | ``cashflow``.
            period: Reporting period, e.g. ``20231231``.
        """

        return await reg.call(
            lambda p: p.get_financials(symbol, statement, period), prefer=provider
        )

    @mcp.tool()
    async def get_macro(
        indicator: str,
        start: str,
        end: str,
        provider: str | None = None,
    ) -> MacroSeries:
        """Macro indicator series, e.g. ``cn_gdp``, ``cn_cpi``."""

        return await reg.call(
            lambda p: p.get_macro(indicator, start, end), prefer=provider
        )

    @mcp.tool()
    async def list_providers() -> list[ProviderStatus]:
        """Return the registered providers and their availability."""

        return await reg.status()

    return mcp


def main() -> None:  # pragma: no cover - thin CLI wrapper
    logging.basicConfig(level=logging.INFO)
    build_server().run()


if __name__ == "__main__":  # pragma: no cover
    main()
