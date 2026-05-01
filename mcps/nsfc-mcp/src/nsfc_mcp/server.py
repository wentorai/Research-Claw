"""FastMCP server exposing NSFC query tools.

The server is built lazily so tests can construct an isolated instance with a
mocked ``NsfcClient``. The module-level ``mcp`` instance is what the
``nsfc-mcp`` console script and ``python -m nsfc_mcp`` use; tests import
``build_server`` directly.
"""

from __future__ import annotations

from typing import Awaitable, Callable

from mcp.server.fastmcp import FastMCP

from nsfc_mcp.client import NsfcClient
from nsfc_mcp.models import (
    Discipline,
    ProjectDetail,
    ProjectListResult,
    ProjectQuery,
    TrendsResult,
)

ClientFactory = Callable[[], Awaitable[NsfcClient]] | Callable[[], NsfcClient]


def build_server(
    *,
    client: NsfcClient | None = None,
    name: str = "nsfc-mcp",
) -> FastMCP:
    """Build a FastMCP server. Tests pass a pre-wired client.

    When ``client`` is None, a fresh :class:`NsfcClient` is constructed for
    every tool invocation and disposed of afterwards. This keeps the long-
    running server free of stale HTTP connections.
    """

    mcp = FastMCP(name)

    async def _with_client():  # type: ignore[no-untyped-def]
        if client is not None:
            return client, False
        return NsfcClient(), True

    @mcp.tool(description="根据关键词/PI/单位/学科/年度查询 NSFC 立项项目列表。")
    async def search_projects(
        keyword: str | None = None,
        pi_name: str | None = None,
        institution: str | None = None,
        project_type: str | None = None,
        discipline_code: str | None = None,
        year: int | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> ProjectListResult:
        query = ProjectQuery(
            keyword=keyword,
            pi_name=pi_name,
            institution=institution,
            project_type=project_type,
            discipline_code=discipline_code,
            year=year,
            page=page,
            page_size=page_size,
        )
        c, owns = await _with_client()
        try:
            return await c.search_projects(query)
        finally:
            if owns:
                await c.aclose()

    @mcp.tool(description="按项目批准号获取单个 NSFC 项目的详情(含摘要、关键词等)。")
    async def get_project_detail(project_id: str) -> ProjectDetail:
        c, owns = await _with_client()
        try:
            return await c.get_project_detail(project_id)
        finally:
            if owns:
                await c.aclose()

    @mcp.tool(description="统计某关键词在指定区间内的年度立项数趋势。")
    async def get_trends(
        keyword: str,
        year_from: int = 2015,
        year_to: int = 2026,
    ) -> TrendsResult:
        c, owns = await _with_client()
        try:
            return await c.get_trends(keyword, year_from=year_from, year_to=year_to)
        finally:
            if owns:
                await c.aclose()

    @mcp.tool(description="列出 NSFC 学科代码树；不传 parent_code 则返回学部级。")
    async def list_disciplines(parent_code: str | None = None) -> list[Discipline]:
        c, owns = await _with_client()
        try:
            return await c.list_disciplines(parent_code)
        finally:
            if owns:
                await c.aclose()

    @mcp.tool(description="基于已立项项目对相关关键词做共现统计，返回最高频的关联关键词列表。")
    async def suggest_keywords(topic: str, limit: int = 20) -> list[str]:
        c, owns = await _with_client()
        try:
            return await c.suggest_keywords(topic, limit=limit)
        finally:
            if owns:
                await c.aclose()

    return mcp


# Module-level singleton used by ``python -m nsfc_mcp``.
mcp = build_server()
