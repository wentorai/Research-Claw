"""Skeleton providers (FLUX / Imagen / Ideogram / Recraft) — graceful degradation."""

from __future__ import annotations

import pytest

from econ_image_mcp.providers.flux import FluxProvider
from econ_image_mcp.providers.ideogram import IdeogramProvider
from econ_image_mcp.providers.imagen import ImagenProvider
from econ_image_mcp.providers.recraft import RecraftProvider

SKELETONS = [FluxProvider, ImagenProvider, IdeogramProvider, RecraftProvider]


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_unavailable_without_credentials(cls) -> None:
    # The autouse fixture clears every relevant env var, so no skeleton
    # provider should claim to be available.
    p = cls()
    assert await p.is_available() is False


@pytest.mark.parametrize("cls", SKELETONS)
@pytest.mark.asyncio
async def test_generate_raises_helpful_chinese_message(cls) -> None:
    p = cls()
    with pytest.raises(NotImplementedError) as exc:
        await p.generate("Schematic of policy transmission")
    msg = str(exc.value)
    # Hint should mention the docs path so the user knows where to look.
    assert "docs/setup-" in msg
    # And should be in Chinese (mention 骨架).
    assert "骨架" in msg


@pytest.mark.asyncio
async def test_flux_recognises_replicate_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REPLICATE_API_TOKEN", "rpl_test")
    p = FluxProvider()
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_imagen_requires_full_gcp_triple(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Only project set -> still unavailable.
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-proj")
    p = ImagenProvider()
    assert await p.is_available() is False
    # Add region + creds -> now available.
    monkeypatch.setenv("GOOGLE_CLOUD_REGION", "us-central1")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/creds.json")
    p2 = ImagenProvider()
    assert await p2.is_available() is True


@pytest.mark.asyncio
async def test_ideogram_recognises_replicate_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REPLICATE_API_TOKEN", "rpl_test")
    p = IdeogramProvider()
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_recraft_recognises_either_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECRAFT_API_KEY", "rk_test")
    p = RecraftProvider()
    assert await p.is_available() is True


def test_priority_order() -> None:
    # FLUX is cheapest, ahead of DALL-E; Imagen / Ideogram / Recraft come after.
    assert FluxProvider.priority < ImagenProvider.priority
    assert ImagenProvider.priority < IdeogramProvider.priority
    assert IdeogramProvider.priority < RecraftProvider.priority
