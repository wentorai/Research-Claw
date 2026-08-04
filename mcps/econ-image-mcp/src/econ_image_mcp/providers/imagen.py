"""Google Imagen 3 provider — skeleton.

Imagen 3 is exposed via Vertex AI:

    POST https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/
         locations/{REGION}/publishers/google/models/imagen-3.0-generate-001:predict

The request requires an OAuth2 access token (typically obtained from a service
account via ``google-auth``), the project ID, and a region. Because spinning
that up requires GCP-side configuration that doesn't fit in a single env var,
``generate`` raises ``NotImplementedError``.

See ``docs/setup-imagen.md``.
"""

from __future__ import annotations

import os

from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider

_HINT = (
    "ImagenProvider 还是骨架，需要按 docs/setup-imagen.md 配置 GCP 服务账号 + Vertex AI，\n"
    "然后实现 generate()。需要：GOOGLE_CLOUD_PROJECT、GOOGLE_CLOUD_REGION、\n"
    "GOOGLE_APPLICATION_CREDENTIALS（指向服务账号 JSON）。"
)


class ImagenProvider(BaseImageProvider):
    name = "imagen"
    priority = 25

    def __init__(
        self,
        project: str | None = None,
        region: str | None = None,
        credentials_path: str | None = None,
    ) -> None:
        self._project = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
        self._region = region or os.environ.get("GOOGLE_CLOUD_REGION")
        self._credentials = credentials_path or os.environ.get(
            "GOOGLE_APPLICATION_CREDENTIALS"
        )

    async def is_available(self) -> bool:
        return bool(self._project and self._region and self._credentials)

    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        raise NotImplementedError(_HINT)
