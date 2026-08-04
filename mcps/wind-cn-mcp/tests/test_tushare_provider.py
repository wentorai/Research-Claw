"""Tushare provider tests — httpx fully mocked via pytest-httpx."""

from __future__ import annotations

from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from wind_cn_mcp.exceptions import ProviderAPIError, ProviderUnavailableError
from wind_cn_mcp.models import FinancialStatement, HistoryBar, MacroSeries, Quote
from wind_cn_mcp.providers.tushare import TUSHARE_ENDPOINT, TushareProvider


def _ts_response(fields: list[str], items: list[list[Any]]) -> dict[str, Any]:
    """Match the real Tushare envelope shape."""

    return {
        "request_id": "abc",
        "code": 0,
        "msg": None,
        "data": {"fields": fields, "items": items, "has_more": False},
    }


def _ts_error(msg: str) -> dict[str, Any]:
    return {"request_id": "abc", "code": 40203, "msg": msg, "data": None}


@pytest.mark.asyncio
async def test_is_available_requires_token() -> None:
    no_tok = TushareProvider(token=None)
    assert await no_tok.is_available() is False
    with_tok = TushareProvider(token="abc")
    assert await with_tok.is_available() is True


@pytest.mark.asyncio
async def test_call_without_token_raises() -> None:
    p = TushareProvider(token=None)
    with pytest.raises(ProviderUnavailableError):
        await p.get_quote("600519.SH")


@pytest.mark.asyncio
async def test_get_quote_parses_daily(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT,
        method="POST",
        json=_ts_response(
            ["ts_code", "trade_date", "open", "high", "low", "close",
             "pre_close", "change", "pct_chg", "vol", "amount"],
            [["600519.SH", "20240105", 1700.0, 1720.0, 1690.0, 1710.0,
              1700.0, 10.0, 0.5882, 12345.0, 21000000.0]],
        ),
    )
    q = await tushare_provider.get_quote("600519.SH")
    assert isinstance(q, Quote)
    assert q.symbol == "600519.SH"
    assert q.price == 1710.0
    assert q.change == 10.0
    assert q.change_pct == 0.5882
    assert q.volume == 12345.0
    assert q.turnover == 21000000.0
    assert q.provider == "tushare"


@pytest.mark.asyncio
async def test_get_quote_no_rows(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT,
        method="POST",
        json=_ts_response(["ts_code", "trade_date", "close"], []),
    )
    with pytest.raises(ProviderAPIError):
        await tushare_provider.get_quote("000000.SZ")


@pytest.mark.asyncio
async def test_get_quote_api_error(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT, method="POST", json=_ts_error("token invalid")
    )
    with pytest.raises(ProviderAPIError):
        await tushare_provider.get_quote("600519.SH")


@pytest.mark.asyncio
async def test_get_history_sorts_and_parses(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT,
        method="POST",
        json=_ts_response(
            ["ts_code", "trade_date", "open", "high", "low", "close", "vol", "amount"],
            [
                ["600519.SH", "20240105", 1700.0, 1720.0, 1690.0, 1710.0, 12345.0, 2.1e7],
                ["600519.SH", "20240104", 1680.0, 1705.0, 1675.0, 1700.0, 11000.0, 1.9e7],
                ["600519.SH", "20240103", 1670.0, 1690.0, 1660.0, 1680.0, 10000.0, 1.7e7],
            ],
        ),
    )
    bars = await tushare_provider.get_history("600519.SH", "20240103", "20240105")
    assert len(bars) == 3
    assert all(isinstance(b, HistoryBar) for b in bars)
    # Should be ascending by date
    assert [b.date.isoformat() for b in bars] == [
        "2024-01-03",
        "2024-01-04",
        "2024-01-05",
    ]
    assert bars[0].open == 1670.0
    assert bars[-1].close == 1710.0


@pytest.mark.asyncio
async def test_get_history_rejects_non_daily(
    tushare_provider: TushareProvider,
) -> None:
    with pytest.raises(ProviderAPIError):
        await tushare_provider.get_history("600519.SH", "20240101", "20240131", freq="W")


@pytest.mark.asyncio
async def test_get_financials_income(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT,
        method="POST",
        json=_ts_response(
            ["ts_code", "ann_date", "f_ann_date", "end_date", "report_type",
             "comp_type", "revenue", "operating_cost", "n_income"],
            [["600519.SH", "20240328", "20240328", "20231231", "1", "1",
              1.5e11, 5.0e10, 7.5e10]],
        ),
    )
    fs = await tushare_provider.get_financials("600519.SH", "income", "20231231")
    assert isinstance(fs, FinancialStatement)
    assert fs.statement == "income"
    names = {l.name for l in fs.lines}
    # Metadata keys should be stripped
    assert "ts_code" not in names
    assert "end_date" not in names
    assert {"revenue", "operating_cost", "n_income"}.issubset(names)


@pytest.mark.asyncio
async def test_get_financials_unknown_kind(tushare_provider: TushareProvider) -> None:
    with pytest.raises(ProviderAPIError):
        await tushare_provider.get_financials("600519.SH", "unknown", "20231231")  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_get_macro_gdp(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT,
        method="POST",
        json=_ts_response(
            ["quarter", "gdp"],
            [["2024Q1", 296299.6], ["2023Q4", 339236.8]],
        ),
    )
    series = await tushare_provider.get_macro("cn_gdp", "20240101", "20240331")
    assert isinstance(series, MacroSeries)
    assert series.indicator == "cn_gdp"
    assert len(series.points) == 2
    assert series.points[0].period == "2024Q1"
    assert series.points[0].value == 296299.6


@pytest.mark.asyncio
async def test_payload_shape(
    tushare_provider: TushareProvider, httpx_mock: HTTPXMock
) -> None:
    """Confirm we send the canonical Tushare envelope."""

    httpx_mock.add_response(
        url=TUSHARE_ENDPOINT,
        method="POST",
        json=_ts_response(
            ["ts_code", "trade_date", "open", "high", "low", "close",
             "pre_close", "change", "pct_chg", "vol", "amount"],
            [["600519.SH", "20240105", 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0]],
        ),
    )
    await tushare_provider.get_quote("600519.SH")

    request = httpx_mock.get_request()
    assert request is not None
    import json
    body = json.loads(request.content)
    assert body["api_name"] == "daily"
    assert body["token"] == "test-token-xxx"
    assert body["params"]["ts_code"] == "600519.SH"
    assert "fields" in body
