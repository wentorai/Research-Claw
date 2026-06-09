"""Ideogram v2 provider — skeleton.

Ideogram v2 (excellent at typography) is most easily reached through Replicate:

    POST https://api.replicate.com/v1/predictions
         {"version": "<ideogram-v2-hash>", "input": {"prompt": "..."}}

This skeleton raises ``NotImplementedError`` and pushes the user to
``docs/setup-ideogram.md`` for the version hash and request shape.
"""

from __future__ import annotations

import os

from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider

_HINT = (
    "IdeogramProvider 还是骨架，需要按 docs/setup-ideogram.md 配置 REPLICATE_API_TOKEN，\n"
    "并在调用 https://api.replicate.com/v1/predictions 时填入 ideogram-v2 的 version hash。\n"
    "Ideogram 的强项是排版与中英文字效果，特别适合海报 / 政策简报封面。"
)


class IdeogramProvider(BaseImageProvider):
    name = "ideogram"
    priority = 30

    def __init__(self, replicate_token: str | None = None) -> None:
        self._replicate_token = replicate_token or os.environ.get("REPLICATE_API_TOKEN")

    async def is_available(self) -> bool:
        return bool(self._replicate_token)

    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        raise NotImplementedError(_HINT)
