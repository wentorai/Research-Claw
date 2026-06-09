"""MockProvider: deterministic placeholder PNGs."""

from __future__ import annotations

import os

import pytest
from PIL import Image

from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.mock import MockProvider


@pytest.mark.asyncio
async def test_is_available(mock_provider: MockProvider) -> None:
    assert await mock_provider.is_available() is True


@pytest.mark.asyncio
async def test_generate_returns_image_result(mock_provider: MockProvider) -> None:
    res = await mock_provider.generate("Schematic of policy transmission")
    assert isinstance(res, ImageResult)
    assert res.provider == "mock"
    assert res.size == "1024x1024"
    assert res.file_path is not None
    assert os.path.exists(res.file_path)
    assert res.url is None


@pytest.mark.asyncio
async def test_generated_png_is_valid(mock_provider: MockProvider) -> None:
    res = await mock_provider.generate("Game payoff matrix", size="512x512")
    assert res.file_path is not None
    with Image.open(res.file_path) as img:
        assert img.format == "PNG"
        assert img.size == (512, 512)


@pytest.mark.asyncio
async def test_generate_deterministic(mock_provider: MockProvider) -> None:
    a = await mock_provider.generate("policy brief cover", size="1024x1024", seed=42)
    b = await mock_provider.generate("policy brief cover", size="1024x1024", seed=42)
    assert a.file_path == b.file_path
    assert a.extra == b.extra


@pytest.mark.asyncio
async def test_generate_different_prompts_distinct_files(
    mock_provider: MockProvider,
) -> None:
    a = await mock_provider.generate("prompt one")
    b = await mock_provider.generate("prompt two")
    assert a.file_path != b.file_path


@pytest.mark.asyncio
async def test_generate_handles_long_prompt(mock_provider: MockProvider) -> None:
    long_prompt = "very " * 100 + "long prompt about supply and demand curve"
    res = await mock_provider.generate(long_prompt)
    assert res.file_path is not None
    assert os.path.exists(res.file_path)


@pytest.mark.asyncio
async def test_invalid_size_raises(mock_provider: MockProvider) -> None:
    with pytest.raises(ValueError):
        await mock_provider.generate("anything", size="not-a-size")


@pytest.mark.asyncio
async def test_negative_size_rejected(mock_provider: MockProvider) -> None:
    with pytest.raises(ValueError):
        await mock_provider.generate("anything", size="0x0")


@pytest.mark.asyncio
async def test_style_and_seed_round_tripped(mock_provider: MockProvider) -> None:
    res = await mock_provider.generate(
        "concept illustration", style="vivid", seed=123
    )
    assert res.style == "vivid"
    assert res.seed == 123
