"""WanfangProvider skeleton — requires institutional access tokens."""

from __future__ import annotations

import os
from typing import Any

from ..models import Paper, SearchResult
from .base import BaseProvider


_NOT_IMPLEMENTED_MSG = (
    "WanfangProvider 需要机构访问令牌。\n"
    "请参见 docs/setup-wanfang.md 配置 WANFANG_TOKEN 环境变量后实现具体调用。"
)


class WanfangProvider(BaseProvider):
    """Skeleton for the 万方数据 (Wanfang Data) provider."""

    name = "wanfang"
    priority = 10
    description = "万方数据 (Wanfang Data). Requires institutional access; see docs/setup-wanfang.md."

    async def search(self, query: str, limit: int = 20, **filters: Any) -> SearchResult:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def get_paper(self, paper_id: str) -> Paper:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def is_available(self) -> bool:
        return bool(os.getenv("WANFANG_TOKEN"))
