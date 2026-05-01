"""End-to-end tests: every MCP tool wired against a mock-only registry."""

from __future__ import annotations

import pytest

from wind_cn_mcp.providers.mock import MockProvider
from wind_cn_mcp.registry import ProviderRegistry
from wind_cn_mcp.server import build_server


@pytest.fixture
def server_and_tools():
    reg = ProviderRegistry([MockProvider()])
    mcp = build_server(reg)

    # FastMCP stores tool callables in a tool manager; this small helper makes
    # the test independent of the exact attribute layout.
    tools: dict[str, object] = {}
    tm = getattr(mcp, "_tool_manager", None) or getattr(mcp, "tool_manager", None)
    assert tm is not None, "could not locate FastMCP tool manager"
    for tool in tm._tools.values():  # type: ignore[attr-defined]
        fn = getattr(tool, "fn", None) or getattr(tool, "func", None) or getattr(tool, "callable", None)
        assert fn is not None, f"tool {tool} exposes no callable"
        tools[tool.name] = fn
    return mcp, tools


@pytest.mark.asyncio
async def test_all_five_tools_registered(server_and_tools) -> None:
    _, tools = server_and_tools
    assert set(tools) == {
        "get_quote",
        "get_history",
        "get_financials",
        "get_macro",
        "list_providers",
    }


@pytest.mark.asyncio
async def test_get_quote_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    q = await tools["get_quote"]("600519.SH")
    assert q.symbol == "600519.SH"
    assert q.provider == "mock"


@pytest.mark.asyncio
async def test_get_history_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    bars = await tools["get_history"]("600519.SH", "20240101", "20240105")
    assert len(bars) == 5
    assert bars[0].provider == "mock"


@pytest.mark.asyncio
async def test_get_financials_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    fs = await tools["get_financials"]("600519.SH", "income", "20231231")
    assert fs.statement == "income"
    assert fs.provider == "mock"
    assert len(fs.lines) == 4


@pytest.mark.asyncio
async def test_get_macro_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    series = await tools["get_macro"]("cn_cpi", "20240101", "20240301")
    assert series.indicator == "cn_cpi"
    assert series.provider == "mock"
    assert len(series.points) == 3


@pytest.mark.asyncio
async def test_list_providers_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    statuses = await tools["list_providers"]()
    assert [s.name for s in statuses] == ["mock"]
    assert statuses[0].available is True


@pytest.mark.asyncio
async def test_prefer_unknown_provider_via_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    from wind_cn_mcp.exceptions import NoProviderAvailableError
    with pytest.raises(NoProviderAvailableError):
        await tools["get_quote"]("600519.SH", provider="ghost")
