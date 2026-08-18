"""FLUX.1 provider — skeleton.

FLUX.1 (Black Forest Labs) is reachable through several gateways:

  * Replicate          (https://replicate.com/black-forest-labs)
  * fal.ai             (https://fal.ai/models/fal-ai/flux)
  * Black Forest Labs' own ``api.bfl.ml``

Each gateway has a slightly different request shape; rather than baking a
specific one in, this skeleton raises ``NotImplementedError`` with a hint so
the user picks one and fills it in. ``is_available`` returns ``True`` if any
of the typical env-var tokens is set.

See ``docs/setup-flux.md``.
"""

from __future__ import annotations

import os

from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider

_HINT = (
    "FluxProvider 还是骨架，需要你按 docs/setup-flux.md 选定一个 gateway "
    "（Replicate / fal.ai / api.bfl.ml）并实现 generate()。\n"
    "认证 token 通常通过环境变量传入：REPLICATE_API_TOKEN / FAL_KEY / BFL_API_KEY。"
)


class FluxProvider(BaseImageProvider):
    name = "flux"
    priority = 15  # cheaper-than-DALL-E inference, slot it ahead when configured

    def __init__(
        self,
        replicate_token: str | None = None,
        fal_key: str | None = None,
        bfl_key: str | None = None,
    ) -> None:
        self._replicate_token = replicate_token or os.environ.get("REPLICATE_API_TOKEN")
        self._fal_key = fal_key or os.environ.get("FAL_KEY")
        self._bfl_key = bfl_key or os.environ.get("BFL_API_KEY")

    async def is_available(self) -> bool:
        # Even though generate() isn't implemented, "credentials present" is a
        # useful signal — the registry will still try and surface the
        # NotImplementedError for the user to act on.
        return bool(self._replicate_token or self._fal_key or self._bfl_key)

    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        raise NotImplementedError(_HINT)
