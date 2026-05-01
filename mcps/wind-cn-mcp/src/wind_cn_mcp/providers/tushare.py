"""Tushare Pro provider — partial real implementation.

Tushare uses a single POST endpoint (``http://api.tushare.pro``) where every
request is a JSON object of the form::

    {
        "api_name": "daily",
        "token": "<your token>",
        "params": {"ts_code": "600519.SH", "start_date": "20240101", "end_date": "20240110"},
        "fields": "ts_code,trade_date,open,high,low,close,vol,amount"
    }

Successful responses come back with ``code == 0`` and a ``data`` block holding
``fields`` (column names) and ``items`` (row arrays).  This module wraps the
common API names used by our four MCP tools.

Tests in ``tests/test_tushare_provider.py`` mock httpx, so no real API key or
network is required.
"""

from __future__ import annotations

import os
from datetime import UTC, date, datetime
from typing import Any

import httpx

from wind_cn_mcp.exceptions import ProviderAPIError, ProviderUnavailableError
from wind_cn_mcp.models import (
    FinancialLine,
    FinancialStatement,
    HistoryBar,
    MacroPoint,
    MacroSeries,
    Quote,
    StatementKind,
)
from wind_cn_mcp.providers.base import BaseProvider

TUSHARE_ENDPOINT = "http://api.tushare.pro"

_STATEMENT_API: dict[str, str] = {
    "income": "income",
    "balance": "balancesheet",
    "cashflow": "cashflow",
}

_MACRO_API: dict[str, str] = {
    "cn_gdp": "cn_gdp",
    "cn_cpi": "cn_cpi",
    "cn_ppi": "cn_ppi",
    "cn_m": "cn_m",
}


class TushareProvider(BaseProvider):
    """HTTP-based provider for Tushare Pro."""

    name = "tushare"
    priority = 50  # behind wind/ifind/choice (terminal-grade), ahead of mock

    def __init__(
        self,
        token: str | None = None,
        endpoint: str = TUSHARE_ENDPOINT,
        timeout: float = 15.0,
    ) -> None:
        self._token = token or os.environ.get("TUSHARE_TOKEN")
        self._endpoint = endpoint
        self._timeout = timeout

    async def is_available(self) -> bool:
        return bool(self._token)

    async def _call(
        self,
        api_name: str,
        params: dict[str, Any],
        fields: str | None = None,
    ) -> dict[str, Any]:
        if not self._token:
            raise ProviderUnavailableError(
                "TUSHARE_TOKEN not set — register at https://tushare.pro and export it."
            )
        payload: dict[str, Any] = {
            "api_name": api_name,
            "token": self._token,
            "params": params,
        }
        if fields:
            payload["fields"] = fields
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(self._endpoint, json=payload)
            r.raise_for_status()
            body = r.json()
        if body.get("code", 0) != 0:
            raise ProviderAPIError(f"tushare {api_name} failed: {body.get('msg')}")
        data = body.get("data") or {}
        return data

    @staticmethod
    def _rows(data: dict[str, Any]) -> list[dict[str, Any]]:
        fields = data.get("fields") or []
        items = data.get("items") or []
        return [dict(zip(fields, row, strict=False)) for row in items]

    async def get_quote(self, symbol: str) -> Quote:
        # Use the most recent ``daily`` row as the quote.
        data = await self._call(
            "daily",
            {"ts_code": symbol},
            fields="ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
        )
        rows = self._rows(data)
        if not rows:
            raise ProviderAPIError(f"tushare daily returned no rows for {symbol}")
        row = rows[0]
        ts = _parse_yyyymmdd(str(row["trade_date"]))
        return Quote(
            symbol=symbol,
            name=None,
            price=float(row["close"]),
            change=_to_float(row.get("change")),
            change_pct=_to_float(row.get("pct_chg")),
            volume=_to_float(row.get("vol")),
            turnover=_to_float(row.get("amount")),
            timestamp=datetime(ts.year, ts.month, ts.day, 15, 0, tzinfo=UTC),
            currency="CNY",
            provider=self.name,
        )

    async def get_history(
        self,
        symbol: str,
        start: str,
        end: str,
        freq: str = "D",
    ) -> list[HistoryBar]:
        if freq != "D":
            raise ProviderAPIError(f"tushare provider only supports freq='D', got {freq!r}")
        data = await self._call(
            "daily",
            {
                "ts_code": symbol,
                "start_date": _normalise_date(start),
                "end_date": _normalise_date(end),
            },
            fields="ts_code,trade_date,open,high,low,close,vol,amount",
        )
        bars: list[HistoryBar] = []
        for row in self._rows(data):
            d = _parse_yyyymmdd(str(row["trade_date"]))
            bars.append(
                HistoryBar(
                    symbol=symbol,
                    date=d,
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=_to_float(row.get("vol")) or 0.0,
                    turnover=_to_float(row.get("amount")),
                    provider=self.name,
                )
            )
        bars.sort(key=lambda b: b.date)
        return bars

    async def get_financials(
        self,
        symbol: str,
        statement: StatementKind,
        period: str,
    ) -> FinancialStatement:
        api = _STATEMENT_API.get(statement)
        if api is None:
            raise ProviderAPIError(f"unknown statement kind {statement!r}")
        data = await self._call(
            api,
            {"ts_code": symbol, "period": _normalise_date(period)},
        )
        rows = self._rows(data)
        if not rows:
            raise ProviderAPIError(
                f"tushare {api} returned no data for {symbol} period={period}"
            )
        row = rows[0]
        meta_keys = {"ts_code", "ann_date", "f_ann_date", "end_date", "report_type", "comp_type"}
        lines = [
            FinancialLine(name=k, value=_to_float(v))
            for k, v in row.items()
            if k not in meta_keys
        ]
        return FinancialStatement(
            symbol=symbol,
            statement=statement,
            period=period,
            currency="CNY",
            lines=lines,
            provider=self.name,
        )

    async def get_macro(
        self,
        indicator: str,
        start: str,
        end: str,
    ) -> MacroSeries:
        api = _MACRO_API.get(indicator, indicator)
        data = await self._call(
            api,
            {"start_q": _to_quarter(start), "end_q": _to_quarter(end)},
        )
        rows = self._rows(data)
        # Tushare macro rows always include a period field (``quarter`` or ``month``);
        # we pick the first non-id key as the value.
        points: list[MacroPoint] = []
        for row in rows:
            period = str(row.get("quarter") or row.get("month") or "")
            value = None
            for k, v in row.items():
                if k in {"quarter", "month"}:
                    continue
                value = _to_float(v)
                break
            points.append(MacroPoint(period=period, value=value))
        return MacroSeries(
            indicator=indicator,
            name=indicator,
            unit=None,
            points=points,
            provider=self.name,
        )


def _normalise_date(s: str) -> str:
    return s.replace("-", "")


def _parse_yyyymmdd(s: str) -> date:
    s = s.replace("-", "")
    return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))


def _to_float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _to_quarter(s: str) -> str:
    """Convert a YYYYMMDD-ish date string to ``YYYYQn``."""

    s = s.replace("-", "")
    year = int(s[0:4])
    month = int(s[4:6]) if len(s) >= 6 else 1
    quarter = (month - 1) // 3 + 1
    return f"{year}Q{quarter}"
