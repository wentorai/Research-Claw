"""MockProvider: every method returns valid Pydantic models, deterministic."""

from __future__ import annotations

import pytest

from wind_cn_mcp.models import FinancialStatement, HistoryBar, MacroSeries, Quote
from wind_cn_mcp.providers.mock import MockProvider


@pytest.mark.asyncio
async def test_is_available(mock_provider: MockProvider) -> None:
    assert await mock_provider.is_available() is True


@pytest.mark.asyncio
async def test_get_quote_returns_quote(mock_provider: MockProvider) -> None:
    q = await mock_provider.get_quote("600519.SH")
    assert isinstance(q, Quote)
    assert q.symbol == "600519.SH"
    assert q.name == "贵州茅台"
    assert q.provider == "mock"
    assert q.currency == "CNY"
    assert 5.0 <= q.price < 2000.0


@pytest.mark.asyncio
async def test_get_quote_us_currency(mock_provider: MockProvider) -> None:
    q = await mock_provider.get_quote("AAPL.O")
    assert q.currency == "USD"


@pytest.mark.asyncio
async def test_get_quote_deterministic(mock_provider: MockProvider) -> None:
    a = await mock_provider.get_quote("000001.SZ")
    b = await mock_provider.get_quote("000001.SZ")
    assert a == b


@pytest.mark.asyncio
async def test_get_history_inclusive_range(mock_provider: MockProvider) -> None:
    bars = await mock_provider.get_history("600519.SH", "20240101", "20240105")
    assert len(bars) == 5
    for bar in bars:
        assert isinstance(bar, HistoryBar)
        assert bar.symbol == "600519.SH"
        assert bar.high >= max(bar.open, bar.close)
        assert bar.low <= min(bar.open, bar.close)


@pytest.mark.asyncio
async def test_get_history_empty_when_end_before_start(mock_provider: MockProvider) -> None:
    bars = await mock_provider.get_history("600519.SH", "20240105", "20240101")
    assert bars == []


@pytest.mark.asyncio
async def test_get_history_freq_weekly(mock_provider: MockProvider) -> None:
    bars = await mock_provider.get_history(
        "000300.SH", "20240101", "20240131", freq="W"
    )
    # Jan 1, 8, 15, 22, 29 -> 5 weekly bars
    assert len(bars) == 5


@pytest.mark.asyncio
async def test_get_financials_income(mock_provider: MockProvider) -> None:
    fs = await mock_provider.get_financials("600519.SH", "income", "20231231")
    assert isinstance(fs, FinancialStatement)
    assert fs.statement == "income"
    assert fs.period == "20231231"
    assert {l.name for l in fs.lines} == {
        "revenue",
        "operating_cost",
        "operating_profit",
        "net_income",
    }
    for line in fs.lines:
        assert line.value is not None
        assert line.value > 0


@pytest.mark.asyncio
async def test_get_financials_balance_and_cashflow(mock_provider: MockProvider) -> None:
    bs = await mock_provider.get_financials("000001.SZ", "balance", "20231231")
    cf = await mock_provider.get_financials("000001.SZ", "cashflow", "20231231")
    assert {l.name for l in bs.lines} == {"total_assets", "total_liabilities", "total_equity"}
    assert {l.name for l in cf.lines} == {"cf_operating", "cf_investing", "cf_financing"}


@pytest.mark.asyncio
async def test_get_macro_monthly(mock_provider: MockProvider) -> None:
    series = await mock_provider.get_macro("cn_cpi", "20240101", "20240601")
    assert isinstance(series, MacroSeries)
    assert series.indicator == "cn_cpi"
    # 6 months: Jan..Jun
    assert len(series.points) == 6
    assert series.points[0].period == "202401"
    assert series.points[-1].period == "202406"


@pytest.mark.asyncio
async def test_get_macro_deterministic(mock_provider: MockProvider) -> None:
    a = await mock_provider.get_macro("cn_gdp", "20240101", "20240301")
    b = await mock_provider.get_macro("cn_gdp", "20240101", "20240301")
    assert a == b
