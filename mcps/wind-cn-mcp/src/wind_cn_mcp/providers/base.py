"""Abstract base class every provider must implement."""

from __future__ import annotations

from abc import ABC, abstractmethod

from wind_cn_mcp.models import (
    FinancialStatement,
    HistoryBar,
    MacroSeries,
    Quote,
    StatementKind,
)


class BaseProvider(ABC):
    """Common interface for all data providers.

    Subclasses set ``name`` (unique identifier) and ``priority`` (lower = tried
    first by the registry).
    """

    name: str = "base"
    priority: int = 100

    @abstractmethod
    async def is_available(self) -> bool:
        """Quick health check used by the registry for fallback routing."""

    @abstractmethod
    async def get_quote(self, symbol: str) -> Quote: ...

    @abstractmethod
    async def get_history(
        self,
        symbol: str,
        start: str,
        end: str,
        freq: str = "D",
    ) -> list[HistoryBar]: ...

    @abstractmethod
    async def get_financials(
        self,
        symbol: str,
        statement: StatementKind,
        period: str,
    ) -> FinancialStatement: ...

    @abstractmethod
    async def get_macro(
        self,
        indicator: str,
        start: str,
        end: str,
    ) -> MacroSeries: ...

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<{type(self).__name__} name={self.name!r} priority={self.priority}>"
