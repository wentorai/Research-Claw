"""OpenAI DALL-E 3 provider — partial real implementation.

The OpenAI Images API exposes a single endpoint::

    POST https://api.openai.com/v1/images/generations

with a JSON body of the form::

    {
        "model": "dall-e-3",
        "prompt": "<text>",
        "size": "1024x1024",
        "quality": "hd",
        "n": 1
    }

Successful responses come back as::

    {
        "created": 1700000000,
        "data": [
            {
                "url": "https://...",
                "revised_prompt": "..."
            }
        ]
    }

The provider reads ``OPENAI_API_KEY`` from the environment. ``is_available()``
returns ``True`` iff the env var is set; the registry uses this for fallback.

Tests in ``tests/test_dalle_provider.py`` mock httpx via pytest-httpx, so no
real API key or network access is required to run them.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any

import httpx

from econ_image_mcp.exceptions import ProviderAPIError, ProviderUnavailableError
from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider

DALLE_ENDPOINT = "https://api.openai.com/v1/images/generations"
DALLE_MODEL = "dall-e-3"

# DALL-E 3 only accepts these sizes per the public API docs.
_SUPPORTED_SIZES: frozenset[str] = frozenset(
    {"1024x1024", "1024x1792", "1792x1024"}
)


class DalleProvider(BaseImageProvider):
    """HTTP-based provider for OpenAI DALL-E 3."""

    name = "dalle"
    priority = 20  # below FLUX (which is cheaper) and Imagen if licensed,
    # but ahead of skeleton-only providers.

    def __init__(
        self,
        api_key: str | None = None,
        endpoint: str = DALLE_ENDPOINT,
        model: str = DALLE_MODEL,
        quality: str = "hd",
        timeout: float = 60.0,
    ) -> None:
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self._endpoint = endpoint
        self._model = model
        self._quality = quality
        self._timeout = timeout

    async def is_available(self) -> bool:
        return bool(self._api_key)

    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        if not self._api_key:
            raise ProviderUnavailableError(
                "OPENAI_API_KEY not set — get one at https://platform.openai.com/api-keys "
                "and `export OPENAI_API_KEY=...`. See docs/setup-dalle.md."
            )
        if size not in _SUPPORTED_SIZES:
            raise ProviderAPIError(
                f"DALL-E 3 only supports sizes {sorted(_SUPPORTED_SIZES)}, got {size!r}"
            )

        payload: dict[str, Any] = {
            "model": self._model,
            "prompt": prompt,
            "size": size,
            "quality": self._quality,
            "n": 1,
        }
        if style is not None:
            # OpenAI accepts "vivid" or "natural"; we forward whatever the caller
            # passed and let the API validate.
            payload["style"] = style

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(self._endpoint, json=payload, headers=headers)
            if r.status_code >= 400:
                # Try to surface the OpenAI error message if present.
                try:
                    err = r.json().get("error", {}).get("message") or r.text
                except Exception:
                    err = r.text
                raise ProviderAPIError(f"DALL-E API {r.status_code}: {err}")
            body = r.json()

        data = body.get("data") or []
        if not data:
            raise ProviderAPIError("DALL-E returned no images")
        first = data[0]
        url = first.get("url")
        revised = first.get("revised_prompt")
        created_ts = body.get("created")
        if isinstance(created_ts, (int, float)):
            created = datetime.fromtimestamp(float(created_ts), tz=UTC)
        else:
            created = datetime.now(tz=UTC)

        return ImageResult(
            prompt=prompt,
            size=size,
            file_path=None,
            url=url,
            revised_prompt=revised,
            style=style,
            seed=seed,
            provider=self.name,
            model=self._model,
            created_at=created,
            extra={"quality": self._quality},
        )
