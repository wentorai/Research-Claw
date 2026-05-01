"""Choice 东方财富 provider — skeleton.

Choice (Eastmoney 东方财富 Choice 金融终端) ships an ``EmQuantAPI`` Python
package whose canonical entry point is::

    from EmQuantAPI import c
    c.start("ForceLogin=1")

See ``docs/setup-choice.md`` for licence + login details.  All data methods
raise ``NotImplementedError`` with a Chinese-language hint.
"""

from __future__ import annotations

from wind_cn_mcp.models import FinancialStatement, HistoryBar, MacroSeries, Quote, StatementKind
from wind_cn_mcp.providers.base import BaseProvider

_HINT = (
    "ChoiceProvider 需要本机安装东方财富 Choice 金融终端 + EmQuantAPI 包。\n"
    "请先按照 docs/setup-choice.md 完成 c.start('ForceLogin=1') 登录，\n"
    "然后由用户实现具体的 c.csqsnapshot / c.csd / c.css / c.edb 调用。"
)


class ChoiceProvider(BaseProvider):
    name = "choice"
    priority = 30

    async def is_available(self) -> bool:
        try:
            from EmQuantAPI import c  # type: ignore[import-not-found]  # noqa: F401
        except ImportError:
            return False
        return True

    async def get_quote(self, symbol: str) -> Quote:
        raise NotImplementedError(_HINT)

    async def get_history(
        self,
        symbol: str,
        start: str,
        end: str,
        freq: str = "D",
    ) -> list[HistoryBar]:
        raise NotImplementedError(_HINT)

    async def get_financials(
        self,
        symbol: str,
        statement: StatementKind,
        period: str,
    ) -> FinancialStatement:
        raise NotImplementedError(_HINT)

    async def get_macro(
        self,
        indicator: str,
        start: str,
        end: str,
    ) -> MacroSeries:
        raise NotImplementedError(_HINT)
