"""Wind 万得 provider — skeleton.

Wind requires:
  1. A locally installed Wind 金融终端 (Windows / macOS) with valid licence.
  2. The ``WindPy`` package (``pip install WindPy``) — distributed by Wind.
  3. A successful ``w.start()`` call inside the same process; on Windows the
     terminal also needs to be logged in via the COM interface.

Because none of that is portable, all data methods raise
``NotImplementedError`` with a Chinese-language hint pointing to
``docs/setup-wind.md``.  ``is_available`` returns ``False`` whenever WindPy
isn't importable or the connection is down.
"""

from __future__ import annotations

from wind_cn_mcp.models import FinancialStatement, HistoryBar, MacroSeries, Quote, StatementKind
from wind_cn_mcp.providers.base import BaseProvider

_HINT = (
    "WindProvider 需要本机安装 Wind 金融终端 + WindPy（pip install WindPy）。\n"
    "请先按照 docs/setup-wind.md 配置 COM 客户端并完成 w.start() 登录，\n"
    "然后由用户实现具体的 w.wsq() / w.wsd() / w.wss() / w.edb() 调用。"
)


class WindProvider(BaseProvider):
    name = "wind"
    priority = 10  # terminal-grade, highest priority when available

    async def is_available(self) -> bool:
        try:
            from WindPy import w  # type: ignore[import-not-found]
        except ImportError:
            return False
        try:
            return bool(w.isconnected())
        except Exception:  # pragma: no cover - defensive
            return False

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
