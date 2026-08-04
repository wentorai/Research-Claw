"""End-to-end tests: every MCP tool wired against a mock-only registry."""

from __future__ import annotations

import os

import pytest

from econ_image_mcp.providers.mock import MockProvider
from econ_image_mcp.registry import ProviderRegistry
from econ_image_mcp.server import build_server


@pytest.fixture
def server_and_tools(mock_output_dir: str):
    reg = ProviderRegistry([MockProvider(output_dir=mock_output_dir)])
    mcp = build_server(reg)

    tools: dict[str, object] = {}
    tm = getattr(mcp, "_tool_manager", None) or getattr(mcp, "tool_manager", None)
    assert tm is not None, "could not locate FastMCP tool manager"
    for tool in tm._tools.values():  # type: ignore[attr-defined]
        fn = (
            getattr(tool, "fn", None)
            or getattr(tool, "func", None)
            or getattr(tool, "callable", None)
        )
        assert fn is not None, f"tool {tool} exposes no callable"
        tools[tool.name] = fn
    return mcp, tools


@pytest.mark.asyncio
async def test_all_four_tools_registered(server_and_tools) -> None:
    _, tools = server_and_tools
    assert set(tools) == {
        "generate_image",
        "generate_from_template",
        "list_templates",
        "list_providers",
    }


@pytest.mark.asyncio
async def test_generate_image_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    res = await tools["generate_image"](prompt="policy mechanism diagram")
    assert res.provider == "mock"
    assert res.size == "1024x1024"
    assert res.file_path is not None
    assert os.path.exists(res.file_path)


@pytest.mark.asyncio
async def test_generate_image_custom_size(server_and_tools) -> None:
    _, tools = server_and_tools
    res = await tools["generate_image"](prompt="game theory matrix", size="512x512")
    assert res.size == "512x512"


@pytest.mark.asyncio
async def test_generate_from_template_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    res = await tools["generate_from_template"](
        template_id="policy-mechanism",
        params={
            "POLICY": "央行降准",
            "CHANNEL": "银行间流动性",
            "OUTCOME": "企业信贷成本下降",
            "labels": "降准 -> 流动性 -> 信贷成本",
        },
    )
    assert res.provider == "mock"
    # The filled prompt should be reflected in the saved request.
    assert "央行降准" in res.prompt


@pytest.mark.asyncio
async def test_generate_from_template_unknown_id_bubbles_up(server_and_tools) -> None:
    _, tools = server_and_tools
    from econ_image_mcp.exceptions import TemplateNotFoundError

    with pytest.raises(TemplateNotFoundError):
        await tools["generate_from_template"](template_id="nope", params={})


@pytest.mark.asyncio
async def test_list_templates_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    rows = await tools["list_templates"]()
    assert len(rows) >= 10
    titles = {r.title for r in rows}
    assert any("政策传导" in t for t in titles)


@pytest.mark.asyncio
async def test_list_providers_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    statuses = await tools["list_providers"]()
    assert [s.name for s in statuses] == ["mock"]
    assert statuses[0].available is True


@pytest.mark.asyncio
async def test_prefer_unknown_provider_via_tool(server_and_tools) -> None:
    _, tools = server_and_tools
    from econ_image_mcp.exceptions import NoProviderAvailableError

    with pytest.raises(NoProviderAvailableError):
        await tools["generate_image"](prompt="x", provider="ghost")
