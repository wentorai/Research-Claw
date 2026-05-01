"""Skeleton providers (Wind / iFinD / Choice) — verify graceful degradation."""

from __future__ import annotations

import pytest

from wind_cn_mcp.providers.choice import ChoiceProvider
from wind_cn_mcp.providers.ifind import IFindProvider
from wind_cn_mcp.providers.wind import WindProvider

SKELETONS = [WindProvider, IFindProvider, ChoiceProvider]


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_unavailable_without_vendor_sdk(cls) -> None:
    # The vendor packages (WindPy / iFinDPy / EmQuantAPI) are not installable
    # without a paid licence, so the import will fail and is_available() must
    # return False.
    p = cls()
    assert await p.is_available() is False


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_get_quote_raises_helpful(cls) -> None:
    p = cls()
    with pytest.raises(NotImplementedError) as exc:
        await p.get_quote("600519.SH")
    msg = str(exc.value)
    # Hint should mention the docs path so the user knows where to look.
    assert "docs/setup-" in msg


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_get_history_raises_helpful(cls) -> None:
    p = cls()
    with pytest.raises(NotImplementedError):
        await p.get_history("600519.SH", "20240101", "20240131")


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_get_financials_raises_helpful(cls) -> None:
    p = cls()
    with pytest.raises(NotImplementedError):
        await p.get_financials("600519.SH", "income", "20231231")


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_get_macro_raises_helpful(cls) -> None:
    p = cls()
    with pytest.raises(NotImplementedError):
        await p.get_macro("cn_gdp", "20240101", "20240331")


def test_priority_order() -> None:
    # Wind has the highest priority (lowest number), then iFinD, then Choice.
    assert WindProvider.priority < IFindProvider.priority < ChoiceProvider.priority
