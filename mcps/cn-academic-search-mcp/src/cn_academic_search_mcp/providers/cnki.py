"""CnkiProvider skeleton — requires institutional access tokens."""

from __future__ import annotations

import os
from typing import Any

from ..models import Paper, SearchResult
from .base import BaseProvider


_NOT_IMPLEMENTED_MSG = (
    "CnkiProvider 需要机构访问令牌。\n"
    "请参见 docs/setup-cnki.md 配置 CNKI_TOKEN 环境变量后实现具体调用。"
)


class CnkiProvider(BaseProvider):
    """Skeleton for the 中国知网 (CNKI) provider."""

    name = "cnki"
    priority = 5  # CNKI is the most authoritative when authed
    description = "中国知网 (CNKI). Requires institutional access; see docs/setup-cnki.md."

    async def search(self, query: str, limit: int = 20, **filters: Any) -> SearchResult:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def get_paper(self, paper_id: str) -> Paper:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def is_available(self) -> bool:
        return bool(os.getenv("CNKI_TOKEN"))
