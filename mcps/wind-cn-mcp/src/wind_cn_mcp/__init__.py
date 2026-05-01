"""wind-cn-mcp — unified MCP adapter for Chinese financial data terminals.

Providers: Wind (skeleton), iFinD (skeleton), Choice (skeleton),
Tushare (partial real impl), Mock (synthetic, always available).
"""

from wind_cn_mcp.models import (
    FinancialStatement,
    HistoryBar,
    MacroSeries,
    ProviderStatus,
    Quote,
)
from wind_cn_mcp.registry import ProviderRegistry

__all__ = [
    "FinancialStatement",
    "HistoryBar",
    "MacroSeries",
    "ProviderRegistry",
    "ProviderStatus",
    "Quote",
]

__version__ = "0.1.0"
