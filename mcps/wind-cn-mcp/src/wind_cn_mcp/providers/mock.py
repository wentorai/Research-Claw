"""Deterministic synthetic provider used by tests and demos."""

from __future__ import annotations

import hashlib
from datetime import UTC, date, datetime, timedelta

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

SAMPLE_NAMES: dict[str, str] = {
    "600519.SH": "贵州茅台",
    "000001.SZ": "平安银行",
    "000300.SH": "沪深300",
    "AAPL.O": "Apple Inc.",
    "510300.SH": "沪深300ETF",
}


def _seed(*parts: str) -> int:
    """Stable 32-bit seed derived from a tuple of strings."""

    h = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big")


def _rand_float(seed: int, lo: float, hi: float) -> float:
    """Deterministic float in [lo, hi) from an integer seed."""

    return lo + (seed % 10_000) / 10_000.0 * (hi - lo)


class MockProvider(BaseProvider):
    """Synthetic provider — always available, deterministic by symbol+date."""

    name = "mock"
    priority = 1000  # tried last, after every real backend

    async def is_available(self) -> bool:
        return True

    async def get_quote(self, symbol: str) -> Quote:
        s = _seed("quote", symbol)
        price = round(_rand_float(s, 5.0, 2000.0), 2)
        change_pct = round(_rand_float(s + 1, -3.0, 3.0), 4)
        change = round(price * change_pct / 100.0, 2)
        return Quote(
            symbol=symbol,
            name=SAMPLE_NAMES.get(symbol, f"MOCK-{symbol}"),
            price=price,
            change=change,
            change_pct=change_pct,
            volume=float(_seed("vol", symbol) % 10_000_000),
            turnover=float(_seed("turn", symbol) % 1_000_000_000),
            timestamp=datetime(2026, 5, 1, 9, 30, tzinfo=UTC),
            currency="USD" if symbol.endswith(".O") else "CNY",
            provider=self.name,
        )

    async def get_history(
        self,
        symbol: str,
        start: str,
        end: str,
        freq: str = "D",
    ) -> list[HistoryBar]:
        start_d = _parse_yyyymmdd(start)
        end_d = _parse_yyyymmdd(end)
        if end_d < start_d:
            return []

        step = {"D": 1, "W": 7, "M": 30, "Y": 365}.get(freq, 1)
        bars: list[HistoryBar] = []
        cur = start_d
        while cur <= end_d:
            s = _seed("bar", symbol, cur.isoformat())
            base = _rand_float(s, 5.0, 2000.0)
            o = round(base, 2)
            c = round(base * (1 + _rand_float(s + 1, -0.02, 0.02)), 2)
            h = round(max(o, c) * (1 + _rand_float(s + 2, 0.0, 0.01)), 2)
            low = round(min(o, c) * (1 - _rand_float(s + 3, 0.0, 0.01)), 2)
            vol = float(_seed("v", symbol, cur.isoformat()) % 10_000_000)
            bars.append(
                HistoryBar(
                    symbol=symbol,
                    date=cur,
                    open=o,
                    high=h,
                    low=low,
                    close=c,
                    volume=vol,
                    turnover=round(vol * c, 2),
                    provider=self.name,
                )
            )
            cur += timedelta(days=step)
        return bars

    async def get_financials(
        self,
        symbol: str,
        statement: StatementKind,
        period: str,
    ) -> FinancialStatement:
        line_names = {
            "income": ["revenue", "operating_cost", "operating_profit", "net_income"],
            "balance": ["total_assets", "total_liabilities", "total_equity"],
            "cashflow": ["cf_operating", "cf_investing", "cf_financing"],
        }[statement]
        lines = [
            FinancialLine(
                name=n,
                value=round(_rand_float(_seed(symbol, period, n), 1e7, 1e10), 2),
            )
            for n in line_names
        ]
        return FinancialStatement(
            symbol=symbol,
            statement=statement,
            period=period,
            currency="USD" if symbol.endswith(".O") else "CNY",
            lines=lines,
            provider=self.name,
        )

    async def get_macro(
        self,
        indicator: str,
        start: str,
        end: str,
    ) -> MacroSeries:
        start_d = _parse_yyyymmdd(start)
        end_d = _parse_yyyymmdd(end)
        points: list[MacroPoint] = []
        cur = date(start_d.year, start_d.month, 1)
        while cur <= end_d:
            s = _seed("macro", indicator, cur.isoformat())
            points.append(
                MacroPoint(period=cur.strftime("%Y%m"), value=round(_rand_float(s, 0.0, 10.0), 4))
            )
            # advance by one calendar month
            year, month = cur.year, cur.month + 1
            if month > 12:
                year, month = year + 1, 1
            cur = date(year, month, 1)
        return MacroSeries(
            indicator=indicator,
            name=f"MOCK {indicator}",
            unit="%",
            points=points,
            provider=self.name,
        )


def _parse_yyyymmdd(s: str) -> date:
    s = s.replace("-", "")
    return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))
