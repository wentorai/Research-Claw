"""Pydantic data models exchanged across providers and MCP tools."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Frequency = Literal["D", "W", "M", "Y"]
StatementKind = Literal["income", "balance", "cashflow"]


class Quote(BaseModel):
    """A single point-in-time quote for an instrument."""

    model_config = ConfigDict(extra="forbid")

    symbol: str
    name: str | None = None
    price: float
    change: float | None = None
    change_pct: float | None = None
    volume: float | None = None
    turnover: float | None = None
    timestamp: datetime
    currency: str = "CNY"
    provider: str


class HistoryBar(BaseModel):
    """One OHLCV bar in a historical series."""

    model_config = ConfigDict(extra="forbid")

    symbol: str
    date: date
    open: float
    high: float
    low: float
    close: float
    volume: float
    turnover: float | None = None
    provider: str


class FinancialLine(BaseModel):
    """One line item inside a FinancialStatement."""

    model_config = ConfigDict(extra="forbid")

    name: str
    value: float | None


class FinancialStatement(BaseModel):
    """A periodic financial statement (income / balance / cashflow)."""

    model_config = ConfigDict(extra="forbid")

    symbol: str
    statement: StatementKind
    period: str = Field(description="Reporting period in YYYYMMDD form, e.g. 20231231")
    currency: str = "CNY"
    lines: list[FinancialLine]
    provider: str


class MacroPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period: str
    value: float | None


class MacroSeries(BaseModel):
    """A time series of a single macro indicator."""

    model_config = ConfigDict(extra="forbid")

    indicator: str
    name: str | None = None
    unit: str | None = None
    points: list[MacroPoint]
    provider: str


class ProviderStatus(BaseModel):
    """Lightweight status row used by `list_providers`."""

    model_config = ConfigDict(extra="forbid")

    name: str
    priority: int
    available: bool
    note: str | None = None
