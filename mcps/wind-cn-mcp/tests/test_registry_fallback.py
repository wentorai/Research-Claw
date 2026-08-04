"""Registry: priority ordering + graceful fallback on provider failure."""

from __future__ import annotations

import pytest

from wind_cn_mcp.exceptions import (
    NoProviderAvailableError,
    ProviderAPIError,
    ProviderUnavailableError,
)
from wind_cn_mcp.models import (
    FinancialStatement,
    HistoryBar,
    MacroSeries,
    Quote,
    StatementKind,
)
from wind_cn_mcp.providers.base import BaseProvider
from wind_cn_mcp.providers.mock import MockProvider
from wind_cn_mcp.registry import ProviderRegistry, default_registry


class FailingProvider(BaseProvider):
    """Always claims to be available, always raises on data calls."""

    name = "failing"
    priority = 1

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def is_available(self) -> bool:
        return True

    async def get_quote(self, symbol: str) -> Quote:
        raise self._exc

    async def get_history(
        self, symbol: str, start: str, end: str, freq: str = "D"
    ) -> list[HistoryBar]:
        raise self._exc

    async def get_financials(
        self, symbol: str, statement: StatementKind, period: str
    ) -> FinancialStatement:
        raise self._exc

    async def get_macro(self, indicator: str, start: str, end: str) -> MacroSeries:
        raise self._exc


class UnavailableProvider(BaseProvider):
    name = "down"
    priority = 5

    async def is_available(self) -> bool:
        return False

    async def get_quote(self, symbol: str) -> Quote:  # pragma: no cover - never called
        raise RuntimeError("should not be called")

    async def get_history(
        self, symbol: str, start: str, end: str, freq: str = "D"
    ) -> list[HistoryBar]:  # pragma: no cover
        raise RuntimeError("should not be called")

    async def get_financials(
        self, symbol: str, statement: StatementKind, period: str
    ) -> FinancialStatement:  # pragma: no cover
        raise RuntimeError("should not be called")

    async def get_macro(self, indicator: str, start: str, end: str) -> MacroSeries:  # pragma: no cover
        raise RuntimeError("should not be called")


@pytest.mark.asyncio
async def test_priority_sorting() -> None:
    a = MockProvider()
    a.priority = 100  # type: ignore[misc]
    b = MockProvider()
    b.priority = 10  # type: ignore[misc]
    b.name = "mock-fast"  # type: ignore[misc]
    reg = ProviderRegistry([a, b])
    assert [p.name for p in reg.providers] == ["mock-fast", "mock"]


@pytest.mark.asyncio
async def test_register_duplicate_rejected() -> None:
    reg = ProviderRegistry([MockProvider()])
    with pytest.raises(ValueError):
        reg.register(MockProvider())


@pytest.mark.asyncio
async def test_fallback_on_not_implemented() -> None:
    reg = ProviderRegistry(
        [FailingProvider(NotImplementedError("install Wind")), MockProvider()]
    )
    q = await reg.call(lambda p: p.get_quote("600519.SH"))
    assert q.provider == "mock"


@pytest.mark.asyncio
async def test_fallback_on_unavailable_error() -> None:
    reg = ProviderRegistry(
        [FailingProvider(ProviderUnavailableError("no token")), MockProvider()]
    )
    q = await reg.call(lambda p: p.get_quote("600519.SH"))
    assert q.provider == "mock"


@pytest.mark.asyncio
async def test_fallback_on_api_error() -> None:
    reg = ProviderRegistry(
        [FailingProvider(ProviderAPIError("upstream 500")), MockProvider()]
    )
    q = await reg.call(lambda p: p.get_quote("600519.SH"))
    assert q.provider == "mock"


@pytest.mark.asyncio
async def test_skips_unavailable_providers() -> None:
    reg = ProviderRegistry([UnavailableProvider(), MockProvider()])
    q = await reg.call(lambda p: p.get_quote("600519.SH"))
    assert q.provider == "mock"


@pytest.mark.asyncio
async def test_no_provider_available_when_all_fail() -> None:
    # Two providers, both raising fallback-eligible errors → registry exhausts
    # the list and raises NoProviderAvailableError.
    p1 = FailingProvider(NotImplementedError("install Wind"))
    p1.name = "f1"  # type: ignore[misc]
    p1.priority = 1  # type: ignore[misc]
    p2 = FailingProvider(NotImplementedError("install iFinD"))
    p2.name = "f2"  # type: ignore[misc]
    p2.priority = 2  # type: ignore[misc]
    reg = ProviderRegistry([p1, p2])
    with pytest.raises(NoProviderAvailableError):
        await reg.call(lambda p: p.get_quote("600519.SH"))


@pytest.mark.asyncio
async def test_unexpected_errors_bubble_up() -> None:
    """Errors outside the fallback whitelist must NOT be swallowed."""

    reg = ProviderRegistry([FailingProvider(RuntimeError("kaboom")), MockProvider()])
    with pytest.raises(RuntimeError, match="kaboom"):
        await reg.call(lambda p: p.get_quote("600519.SH"))


@pytest.mark.asyncio
async def test_prefer_specific_provider() -> None:
    reg = ProviderRegistry(
        [FailingProvider(NotImplementedError("install Wind")), MockProvider()]
    )
    # Forcing the failing provider should NOT silently fall back.
    with pytest.raises(NotImplementedError):
        await reg.call(lambda p: p.get_quote("600519.SH"), prefer="failing")


@pytest.mark.asyncio
async def test_prefer_unknown_provider() -> None:
    reg = ProviderRegistry([MockProvider()])
    with pytest.raises(NoProviderAvailableError):
        await reg.call(lambda p: p.get_quote("600519.SH"), prefer="ghost")


@pytest.mark.asyncio
async def test_status_listing() -> None:
    reg = default_registry()
    statuses = await reg.status()
    by_name = {s.name for s in statuses}
    assert by_name == {"wind", "ifind", "choice", "tushare", "mock"}
    # Mock is always available.
    mock_row = next(s for s in statuses if s.name == "mock")
    assert mock_row.available is True
