"""DALL-E 3 provider tests — httpx fully mocked via pytest-httpx."""

from __future__ import annotations

import json

import pytest
from pytest_httpx import HTTPXMock

from econ_image_mcp.exceptions import ProviderAPIError, ProviderUnavailableError
from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.dalle import DALLE_ENDPOINT, DALLE_MODEL, DalleProvider


def _dalle_response(url: str, revised: str = "revised") -> dict:
    """Match the real OpenAI Images envelope shape."""

    return {
        "created": 1_700_000_000,
        "data": [{"url": url, "revised_prompt": revised}],
    }


def _dalle_error(msg: str) -> dict:
    return {"error": {"message": msg, "type": "invalid_request_error"}}


@pytest.mark.asyncio
async def test_is_available_requires_key() -> None:
    no_key = DalleProvider(api_key=None)
    assert await no_key.is_available() is False
    with_key = DalleProvider(api_key="sk-something")
    assert await with_key.is_available() is True


@pytest.mark.asyncio
async def test_generate_without_key_raises() -> None:
    p = DalleProvider(api_key=None)
    with pytest.raises(ProviderUnavailableError):
        await p.generate("anything")


@pytest.mark.asyncio
async def test_generate_parses_response(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        json=_dalle_response(
            url="https://files.openai.com/img/abc.png",
            revised="A clean infographic showing policy transmission.",
        ),
    )
    res = await dalle_provider.generate(
        "policy transmission infographic", size="1024x1024"
    )
    assert isinstance(res, ImageResult)
    assert res.provider == "dalle"
    assert res.model == DALLE_MODEL
    assert res.url == "https://files.openai.com/img/abc.png"
    assert res.revised_prompt and "policy transmission" in res.revised_prompt
    assert res.size == "1024x1024"
    assert res.file_path is None  # DALL-E returns a remote URL, no local file


@pytest.mark.asyncio
async def test_generate_includes_auth_header(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        json=_dalle_response("https://x/y.png"),
    )
    await dalle_provider.generate("anything")

    req = httpx_mock.get_request()
    assert req is not None
    assert req.headers["Authorization"] == "Bearer sk-test-fake-key"
    body = json.loads(req.content)
    assert body["model"] == "dall-e-3"
    assert body["prompt"] == "anything"
    assert body["size"] == "1024x1024"
    assert body["quality"] == "hd"
    assert body["n"] == 1


@pytest.mark.asyncio
async def test_generate_forwards_style(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        json=_dalle_response("https://x/y.png"),
    )
    await dalle_provider.generate("anything", style="vivid")

    req = httpx_mock.get_request()
    assert req is not None
    body = json.loads(req.content)
    assert body["style"] == "vivid"


@pytest.mark.asyncio
async def test_generate_unsupported_size_rejected(
    dalle_provider: DalleProvider,
) -> None:
    with pytest.raises(ProviderAPIError):
        await dalle_provider.generate("x", size="512x512")


@pytest.mark.asyncio
async def test_generate_supports_landscape(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        json=_dalle_response("https://x/y.png"),
    )
    res = await dalle_provider.generate("graphical abstract", size="1792x1024")
    assert res.size == "1792x1024"


@pytest.mark.asyncio
async def test_generate_api_error(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        status_code=400,
        json=_dalle_error("Your prompt was rejected by the safety system."),
    )
    with pytest.raises(ProviderAPIError) as exc:
        await dalle_provider.generate("something risky")
    assert "safety system" in str(exc.value)


@pytest.mark.asyncio
async def test_generate_no_data_rows(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        json={"created": 1, "data": []},
    )
    with pytest.raises(ProviderAPIError):
        await dalle_provider.generate("x")


@pytest.mark.asyncio
async def test_generate_uses_created_timestamp(
    dalle_provider: DalleProvider, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=DALLE_ENDPOINT,
        method="POST",
        json=_dalle_response("https://x/y.png"),
    )
    res = await dalle_provider.generate("anything")
    # 1_700_000_000 -> 2023-11-14T22:13:20Z
    assert res.created_at.year == 2023
    assert res.created_at.month == 11
