"""Registry: priority ordering + graceful fallback on provider failure."""

from __future__ import annotations

import pytest

from econ_image_mcp.exceptions import (
    NoProviderAvailableError,
    ProviderAPIError,
    ProviderUnavailableError,
)
from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider
from econ_image_mcp.providers.mock import MockProvider
from econ_image_mcp.registry import ProviderRegistry, default_registry


class FailingProvider(BaseImageProvider):
    """Always claims to be available, always raises on data calls."""

    name = "failing"
    priority = 1

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def is_available(self) -> bool:
        return True

    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        raise self._exc


class UnavailableProvider(BaseImageProvider):
    name = "down"
    priority = 5

    async def is_available(self) -> bool:
        return False

    async def generate(  # pragma: no cover - never called
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        raise RuntimeError("should not be called")


@pytest.mark.asyncio
async def test_priority_sorting() -> None:
    a = MockProvider()
    a.priority = 100  # type: ignore[misc]
    b = MockProvider()
    b.priority = 10  # type: ignore[misc]
    b.name = "mock-fast"  # type: ignore[misc]
    reg = ProviderRegistry([a, b])
    assert [p.name for p in reg.providers] == ["mock-fast", "mock"]


@pytest.mark.asyncio
async def test_register_duplicate_rejected() -> None:
    reg = ProviderRegistry([MockProvider()])
    with pytest.raises(ValueError):
        reg.register(MockProvider())


@pytest.mark.asyncio
async def test_fallback_on_not_implemented() -> None:
    reg = ProviderRegistry(
        [FailingProvider(NotImplementedError("skeleton")), MockProvider()]
    )
    res = await reg.call(lambda p: p.generate("anything"))
    assert res.provider == "mock"


@pytest.mark.asyncio
async def test_fallback_on_unavailable_error() -> None:
    reg = ProviderRegistry(
        [FailingProvider(ProviderUnavailableError("no key")), MockProvider()]
    )
    res = await reg.call(lambda p: p.generate("anything"))
    assert res.provider == "mock"


@pytest.mark.asyncio
async def test_fallback_on_api_error() -> None:
    reg = ProviderRegistry(
        [FailingProvider(ProviderAPIError("upstream 500")), MockProvider()]
    )
    res = await reg.call(lambda p: p.generate("anything"))
    assert res.provider == "mock"


@pytest.mark.asyncio
async def test_skips_unavailable_providers() -> None:
    reg = ProviderRegistry([UnavailableProvider(), MockProvider()])
    res = await reg.call(lambda p: p.generate("anything"))
    assert res.provider == "mock"


@pytest.mark.asyncio
async def test_no_provider_available_when_all_fail() -> None:
    p1 = FailingProvider(NotImplementedError("install A"))
    p1.name = "f1"  # type: ignore[misc]
    p1.priority = 1  # type: ignore[misc]
    p2 = FailingProvider(NotImplementedError("install B"))
    p2.name = "f2"  # type: ignore[misc]
    p2.priority = 2  # type: ignore[misc]
    reg = ProviderRegistry([p1, p2])
    with pytest.raises(NoProviderAvailableError):
        await reg.call(lambda p: p.generate("x"))


@pytest.mark.asyncio
async def test_unexpected_errors_bubble_up() -> None:
    """Errors outside the fallback whitelist must NOT be swallowed."""

    reg = ProviderRegistry([FailingProvider(RuntimeError("kaboom")), MockProvider()])
    with pytest.raises(RuntimeError, match="kaboom"):
        await reg.call(lambda p: p.generate("x"))


@pytest.mark.asyncio
async def test_prefer_specific_provider_skips_fallback() -> None:
    reg = ProviderRegistry(
        [FailingProvider(NotImplementedError("skeleton")), MockProvider()]
    )
    # Forcing the failing provider should NOT silently fall back.
    with pytest.raises(NotImplementedError):
        await reg.call(lambda p: p.generate("x"), prefer="failing")


@pytest.mark.asyncio
async def test_prefer_unknown_provider() -> None:
    reg = ProviderRegistry([MockProvider()])
    with pytest.raises(NoProviderAvailableError):
        await reg.call(lambda p: p.generate("x"), prefer="ghost")


@pytest.mark.asyncio
async def test_dalle_unavailable_falls_back_to_mock() -> None:
    """End-to-end: with no OPENAI_API_KEY (autouse cleared), the default
    registry should still produce an image via the mock fallback."""

    reg = default_registry()
    res = await reg.call(lambda p: p.generate("policy mechanism diagram"))
    assert res.provider == "mock"


@pytest.mark.asyncio
async def test_status_listing_default_lineup() -> None:
    reg = default_registry()
    statuses = await reg.status()
    by_name = {s.name for s in statuses}
    assert by_name == {"flux", "dalle", "imagen", "ideogram", "recraft", "mock"}
    mock_row = next(s for s in statuses if s.name == "mock")
    assert mock_row.available is True
