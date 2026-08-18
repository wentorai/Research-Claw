"""CqVipProvider skeleton — requires institutional access tokens."""

from __future__ import annotations

import os
from typing import Any

from ..models import Paper, SearchResult
from .base import BaseProvider


_NOT_IMPLEMENTED_MSG = (
    "CqVipProvider 需要机构访问令牌。\n"
    "请参见 docs/setup-cqvip.md 配置 CQVIP_TOKEN 环境变量后实现具体调用。"
)


class CqVipProvider(BaseProvider):
    """Skeleton for the 维普 (CqVip / VIP) provider."""

    name = "cqvip"
    priority = 20
    description = "维普资讯 (CqVip). Requires institutional access; see docs/setup-cqvip.md."

    async def search(self, query: str, limit: int = 20, **filters: Any) -> SearchResult:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def get_paper(self, paper_id: str) -> Paper:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def is_available(self) -> bool:
        return bool(os.getenv("CQVIP_TOKEN"))
