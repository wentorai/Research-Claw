"""iFinD 同花顺 provider — skeleton.

iFinD requires:
  1. The 同花顺 iFinD 客户端 installed locally with a valid account.
  2. ``iFinDPy`` Python SDK (vendor-distributed).
  3. ``THS_iFinDLogin(account, password)`` returning ``0``.

See ``docs/setup-ifind.md`` for the licence + login flow.  All data methods
raise ``NotImplementedError`` with a Chinese-language hint.
"""

from __future__ import annotations

from wind_cn_mcp.models import FinancialStatement, HistoryBar, MacroSeries, Quote, StatementKind
from wind_cn_mcp.providers.base import BaseProvider

_HINT = (
    "IFindProvider 需要本机安装同花顺 iFinD 终端 + iFinDPy SDK。\n"
    "请先按照 docs/setup-ifind.md 完成 THS_iFinDLogin 登录，\n"
    "然后由用户实现具体的 THS_RealtimeQuotes / THS_HistoryQuotes / THS_BasicData / THS_DateSerial 调用。"
)


class IFindProvider(BaseProvider):
    name = "ifind"
    priority = 20

    async def is_available(self) -> bool:
        try:
            import iFinDPy  # type: ignore[import-not-found]  # noqa: F401
        except ImportError:
            return False
        # The vendor SDK keeps a module-level login flag we can't reliably
        # introspect cross-platform, so a successful import is the most we can
        # check without driving an actual login.
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
