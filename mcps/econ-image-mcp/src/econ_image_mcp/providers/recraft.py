"""Recraft v3 provider — skeleton.

Recraft v3 (very strong at vector / infographic style — perfect for policy
mechanism diagrams) is reachable through Replicate or Recraft's own API:

    POST https://api.replicate.com/v1/predictions
         {"version": "<recraft-v3-hash>", "input": {"prompt": "..."}}

See ``docs/setup-recraft.md`` for token + version hash.
"""

from __future__ import annotations

import os

from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider

_HINT = (
    "RecraftProvider 还是骨架，需要按 docs/setup-recraft.md 配置 REPLICATE_API_TOKEN \n"
    "（或 RECRAFT_API_KEY），并填入 recraft-v3 的 version hash。\n"
    "Recraft 的强项是矢量 / infographic 风格，最适合政策传导机制图、概念图、Graphical Abstract。"
)


class RecraftProvider(BaseImageProvider):
    name = "recraft"
    priority = 40

    def __init__(
        self,
        replicate_token: str | None = None,
        recraft_key: str | None = None,
    ) -> None:
        self._replicate_token = replicate_token or os.environ.get("REPLICATE_API_TOKEN")
        self._recraft_key = recraft_key or os.environ.get("RECRAFT_API_KEY")

    async def is_available(self) -> bool:
        return bool(self._replicate_token or self._recraft_key)

    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        raise NotImplementedError(_HINT)
