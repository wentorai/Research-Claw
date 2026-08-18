"""Integration test: build a FastMCP server with a mocked client and call each tool.

``FastMCP.call_tool`` returns ``(content_blocks, structured_dict)`` where
``content_blocks`` is a list of ``TextContent`` items and ``structured_dict``
is the JSON-serializable structured output (built from the tool's return
type annotation). We assert against both shapes.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from nsfc_mcp.client import NsfcClient
from nsfc_mcp.server import build_server


@pytest.fixture
async def server_and_client(base_url: str):
    c = NsfcClient(base_url=base_url, rate_per_sec=1000.0, max_retries=1)
    server = build_server(client=c)
    try:
        yield server, c
    finally:
        await c.aclose()


def _content_text(content_blocks: Any) -> str:
    parts: list[str] = []
    for block in content_blocks or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts)


def _unpack(call_result: Any) -> tuple[Any, Any]:
    """``FastMCP.call_tool`` returns ``(content, structured)``; older versions
    returned a single content list. Normalize."""
    if isinstance(call_result, tuple) and len(call_result) == 2:
        return call_result
    return call_result, None


async def test_server_registers_all_tools(server_and_client) -> None:
    server, _ = server_and_client
    tools = await server.list_tools()
    names = {t.name for t in tools}
    assert names == {
        "search_projects",
        "get_project_detail",
        "get_trends",
        "list_disciplines",
        "suggest_keywords",
    }


async def test_server_tool_descriptions_are_chinese(server_and_client) -> None:
    server, _ = server_and_client
    tools = {t.name: t for t in await server.list_tools()}
    assert "立项" in tools["search_projects"].description
    assert "趋势" in tools["get_trends"].description


async def test_tool_search_projects_via_mcp(
    server_and_client, httpx_mock: Any, search_url: str, fixture_data: dict[str, Any]
) -> None:
    server, _ = server_and_client
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={
            "page": 1, "pageSize": 20, "keyword": "图神经网络"
        }),
        json=fixture_data["search_page1"],
    )

    content, structured = _unpack(await server.call_tool(
        "search_projects",
        {"keyword": "图神经网络", "page": 1, "page_size": 20},
    ))
    assert structured["total"] == 2
    assert structured["page"] == 1
    assert len(structured["items"]) == 2
    assert structured["items"][0]["project_id"] == "62076123"
    # Content payload should also surface the data textually.
    text = _content_text(content)
    assert "62076123" in text
    assert "清华大学" in text


async def test_tool_get_project_detail_via_mcp(
    server_and_client, httpx_mock: Any, detail_url: str, fixture_data: dict[str, Any]
) -> None:
    server, _ = server_and_client
    httpx_mock.add_response(
        url=httpx.URL(detail_url, params={"id": "62076123"}),
        json=fixture_data["detail"],
    )
    content, structured = _unpack(await server.call_tool(
        "get_project_detail", {"project_id": "62076123"}
    ))
    assert structured["project_id"] == "62076123"
    assert "小样本" in structured["abstract"]
    assert "图神经网络" in structured["keywords"]
    assert "62076123" in _content_text(content)


async def test_tool_get_trends_via_mcp(
    server_and_client, httpx_mock: Any, trends_url: str, fixture_data: dict[str, Any]
) -> None:
    server, _ = server_and_client
    httpx_mock.add_response(
        url=httpx.URL(trends_url, params={
            "keyword": "图神经网络", "yearFrom": 2018, "yearTo": 2021
        }),
        json=fixture_data["trends"],
    )
    _, structured = _unpack(await server.call_tool(
        "get_trends",
        {"keyword": "图神经网络", "year_from": 2018, "year_to": 2021},
    ))
    assert structured["total"] == 12 + 21 + 35 + 48
    assert len(structured["points"]) == 4
    assert structured["points"][0]["year"] == 2018


async def test_tool_list_disciplines_via_mcp(
    server_and_client, httpx_mock: Any, disciplines_url: str, fixture_data: dict[str, Any]
) -> None:
    server, _ = server_and_client
    httpx_mock.add_response(url=disciplines_url, json=fixture_data["disciplines"])
    _, structured = _unpack(await server.call_tool("list_disciplines", {}))
    # FastMCP wraps top-level list outputs in {"result": [...]}.
    nodes = structured.get("result") if isinstance(structured, dict) else structured
    codes = {n["code"] for n in nodes}
    assert {"F", "F02", "F0211"} <= codes


async def test_tool_suggest_keywords_via_mcp(
    server_and_client, httpx_mock: Any, search_url: str, fixture_data: dict[str, Any]
) -> None:
    server, _ = server_and_client
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={
            "page": 1, "pageSize": 50, "keyword": "图神经网络"
        }),
        json=fixture_data["search_page1"],
    )
    _, structured = _unpack(await server.call_tool(
        "suggest_keywords", {"topic": "图神经网络"}
    ))
    suggestions = structured.get("result") if isinstance(structured, dict) else structured
    assert "迁移学习" in suggestions
    assert "图神经网络" not in suggestions
