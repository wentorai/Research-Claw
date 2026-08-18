"""FastMCP server exposing unified Chinese academic search tools."""

from __future__ import annotations

import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP

from .models import Paper, ProviderStatus, SearchResult
from .registry import ProviderRegistry, build_default_registry

logger = logging.getLogger(__name__)


def create_server(registry: ProviderRegistry | None = None) -> FastMCP:
    """Build a FastMCP server bound to ``registry`` (default: full lineup)."""
    reg = registry if registry is not None else build_default_registry()
    mcp = FastMCP("cn-academic-search-mcp")

    @mcp.tool()
    async def search(
        query: str,
        limit: int = 20,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        author: Optional[str] = None,
        journal: Optional[str] = None,
        keyword: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> SearchResult:
        """统一搜索中文学术数据库 (CNKI / 万方 / 维普 / Mock).

        Providers are tried in priority order with auto-fallback. The
        ``provider`` argument forces a specific source.

        Filters (all optional):
        - ``year_from`` / ``year_to``: inclusive year bounds
        - ``author``: matches author name (CN or EN substring)
        - ``journal``: substring match on journal name
        - ``keyword``: substring match on declared keywords
        """
        filters: dict[str, object] = {}
        if year_from is not None:
            filters["year_from"] = year_from
        if year_to is not None:
            filters["year_to"] = year_to
        if author is not None:
            filters["author"] = author
        if journal is not None:
            filters["journal"] = journal
        if keyword is not None:
            filters["keyword"] = keyword
        return await reg.search(query, limit=limit, provider=provider, **filters)

    @mcp.tool()
    async def get_paper(paper_id: str, provider: Optional[str] = None) -> Paper:
        """根据 paper_id 获取一篇论文的详细信息。

        ``paper_id`` 形如 ``"mock:0001"`` 或 ``"cnki:CJFD2023XXXX"``。
        If ``provider`` is omitted, the registry routes by id prefix when
        possible and otherwise falls back through the priority list.
        """
        return await reg.get_paper(paper_id, provider=provider)

    @mcp.tool()
    async def list_providers() -> list[ProviderStatus]:
        """列出所有 provider 及其可用状态 (按 priority 升序)."""
        return await reg.status()

    # Expose registry for tests / programmatic use.
    mcp._registry = reg  # type: ignore[attr-defined]
    return mcp


# Module-level singleton for `mcp run` / `mcp install` workflows.
mcp = create_server()
