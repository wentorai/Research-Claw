"""FastMCP server exposing the unified image-generation toolset."""

from __future__ import annotations

import logging

from mcp.server.fastmcp import FastMCP

from econ_image_mcp.models import ImageResult, ProviderStatus, TemplateInfo
from econ_image_mcp.prompts import fill_template, list_template_infos
from econ_image_mcp.registry import ProviderRegistry, default_registry

log = logging.getLogger(__name__)


def build_server(registry: ProviderRegistry | None = None) -> FastMCP:
    """Construct a FastMCP server backed by ``registry`` (or the default lineup).

    Exposed tools:
      * ``generate_image(prompt, provider=None, size, style)``
      * ``generate_from_template(template_id, params, provider=None)``
      * ``list_templates()``
      * ``list_providers()``
    """

    reg = registry or default_registry()
    mcp = FastMCP("econ-image-mcp")

    @mcp.tool()
    async def generate_image(
        prompt: str,
        provider: str | None = None,
        size: str = "1024x1024",
        style: str | None = None,
    ) -> ImageResult:
        """Generate an image from a free-form prompt.

        Args:
            prompt: Free-form prompt text, English or Chinese.
            provider: Force a specific provider name (skips fallback).
            size: e.g. ``1024x1024``, ``1792x1024``, ``1024x1792``.
            style: Provider-dependent style hint (DALL-E: ``vivid`` / ``natural``).
        """

        return await reg.call(
            lambda p: p.generate(prompt, size=size, style=style),
            prefer=provider,
        )

    @mcp.tool()
    async def generate_from_template(
        template_id: str,
        params: dict[str, str],
        provider: str | None = None,
        size: str = "1024x1024",
        style: str | None = None,
    ) -> ImageResult:
        """Generate an image from a named econ/management prompt template.

        Args:
            template_id: One of :func:`list_templates` ids,
                e.g. ``policy-mechanism``, ``game-theory-payoff``,
                ``concept-illustration``, ``graphical-abstract``,
                ``poster-background``, ``policy-brief-cover``.
            params: Dict supplying every required parameter for the template.
            provider: Force a specific provider name (skips fallback).
            size: Image size, e.g. ``1024x1024``.
            style: Provider-dependent style hint.
        """

        prompt = fill_template(template_id, params)
        return await reg.call(
            lambda p: p.generate(prompt, size=size, style=style),
            prefer=provider,
        )

    @mcp.tool()
    async def list_templates() -> list[TemplateInfo]:
        """Return the catalogue of econ/management prompt templates."""

        return list_template_infos()

    @mcp.tool()
    async def list_providers() -> list[ProviderStatus]:
        """Return the registered providers and their availability."""

        return await reg.status()

    return mcp


def main() -> None:  # pragma: no cover - thin CLI wrapper
    logging.basicConfig(level=logging.INFO)
    build_server().run()


if __name__ == "__main__":  # pragma: no cover
    main()
