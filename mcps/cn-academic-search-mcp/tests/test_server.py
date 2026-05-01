"""End-to-end server tool tests with only the Mock provider available."""

from __future__ import annotations

import json

import pytest

from cn_academic_search_mcp.models import Paper, ProviderStatus, SearchResult
from cn_academic_search_mcp.server import create_server


def _resolve_tool(mcp, name: str):
    """Return the underlying async callable for tool ``name``.

    FastMCP stores tools internally; we walk a few common shapes so the
    test is robust to minor SDK refactors.
    """
    tm = getattr(mcp, "_tool_manager", None)
    if tm is None:
        raise RuntimeError("FastMCP missing _tool_manager")
    tools = getattr(tm, "_tools", None)
    if tools is None:
        # Newer SDKs store as dict on tm.tools
        tools = getattr(tm, "tools", None)
    if tools is None:
        raise RuntimeError(f"Cannot find tool registry on {tm!r}")
    tool = tools[name] if isinstance(tools, dict) else next(t for t in tools if t.name == name)
    fn = getattr(tool, "fn", None) or getattr(tool, "func", None) or getattr(tool, "handler", None)
    if fn is None:
        raise RuntimeError(f"Could not extract callable from tool {name}: {tool!r}")
    return fn


@pytest.fixture
def server():
    return create_server()


@pytest.mark.asyncio
async def test_server_lists_three_tools(server) -> None:
    tm = server._tool_manager
    tools = getattr(tm, "_tools", None) or getattr(tm, "tools", None)
    names = (
        list(tools.keys()) if isinstance(tools, dict) else [t.name for t in tools]
    )
    assert set(names) >= {"search", "get_paper", "list_providers"}


@pytest.mark.asyncio
async def test_server_search_tool_falls_through_to_mock(server) -> None:
    search = _resolve_tool(server, "search")
    result = await search(query="数字经济", limit=5)
    # FastMCP may unwrap pydantic returns or pass them through; handle both.
    if isinstance(result, dict):
        result = SearchResult.model_validate(result)
    elif isinstance(result, str):
        result = SearchResult.model_validate(json.loads(result))
    assert isinstance(result, SearchResult)
    assert result.provider == "mock"
    assert result.tried_providers == ["cnki", "wanfang", "cqvip", "mock"]
    assert result.total >= 1


@pytest.mark.asyncio
async def test_server_search_with_filters(server) -> None:
    search = _resolve_tool(server, "search")
    result = await search(query="", limit=20, year_from=2022, year_to=2023, journal="经济研究")
    if isinstance(result, dict):
        result = SearchResult.model_validate(result)
    assert all(p.journal == "经济研究" and 2022 <= (p.year or 0) <= 2023 for p in result.papers)
    assert result.total >= 1


@pytest.mark.asyncio
async def test_server_get_paper_tool(server) -> None:
    get_paper = _resolve_tool(server, "get_paper")
    paper = await get_paper(paper_id="mock:0001")
    if isinstance(paper, dict):
        paper = Paper.model_validate(paper)
    assert paper.paper_id == "mock:0001"
    assert paper.provider == "mock"


@pytest.mark.asyncio
async def test_server_list_providers_tool(server) -> None:
    list_providers = _resolve_tool(server, "list_providers")
    statuses = await list_providers()
    parsed: list[ProviderStatus] = []
    for s in statuses:
        if isinstance(s, ProviderStatus):
            parsed.append(s)
        elif isinstance(s, dict):
            parsed.append(ProviderStatus.model_validate(s))
        else:
            parsed.append(ProviderStatus.model_validate_json(s))
    by_name = {s.name: s for s in parsed}
    assert set(by_name) == {"cnki", "wanfang", "cqvip", "mock"}
    assert by_name["mock"].available is True
    assert by_name["cnki"].available is False  # no env token
