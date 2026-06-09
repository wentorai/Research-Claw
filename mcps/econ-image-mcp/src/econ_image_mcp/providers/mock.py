"""Deterministic synthetic image provider used by tests and demos.

Generates a 1024x1024 (or whatever ``size`` is requested) gray PNG with the
first 30 chars of the prompt overlaid as text. The output file path is stable:
``/tmp/mock-image-<sha256_8>.png`` — same prompt + size always returns the
same file, which keeps the test suite deterministic.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from datetime import UTC, datetime

from PIL import Image, ImageDraw

from econ_image_mcp.models import ImageResult
from econ_image_mcp.providers.base import BaseImageProvider

_DEFAULT_SIZE = "1024x1024"


def _parse_size(size: str) -> tuple[int, int]:
    try:
        w_s, h_s = size.lower().split("x", 1)
        w, h = int(w_s), int(h_s)
    except Exception as exc:
        raise ValueError(f"invalid size {size!r}; expected e.g. '1024x1024'") from exc
    if w <= 0 or h <= 0:
        raise ValueError(f"size dimensions must be positive, got {size!r}")
    return w, h


def _fingerprint(prompt: str, size: str, seed: int | None) -> str:
    """Stable 8-hex-char fingerprint for prompt+size+seed."""

    h = hashlib.sha256(f"{prompt}|{size}|{seed}".encode("utf-8")).hexdigest()
    return h[:16]


class MockProvider(BaseImageProvider):
    """Synthetic provider — always available, deterministic by prompt+size+seed."""

    name = "mock"
    priority = 1000  # tried last, after every real backend

    def __init__(self, output_dir: str | None = None) -> None:
        self._output_dir = output_dir or tempfile.gettempdir()
        os.makedirs(self._output_dir, exist_ok=True)

    async def is_available(self) -> bool:
        return True

    async def generate(
        self,
        prompt: str,
        *,
        size: str = _DEFAULT_SIZE,
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        w, h = _parse_size(size)
        fp = _fingerprint(prompt, size, seed)
        path = os.path.join(self._output_dir, f"mock-image-{fp}.png")

        # Build a gray canvas with prompt text overlay.
        img = Image.new("RGB", (w, h), color=(200, 200, 200))
        draw = ImageDraw.Draw(img)
        snippet = prompt[:30]
        text = f"Mock: {snippet}"
        # Rough centred placement; falls back to default font (always available).
        try:
            bbox = draw.textbbox((0, 0), text)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        except Exception:  # pragma: no cover - very old Pillow
            tw, th = (len(text) * 6, 11)
        draw.text(
            ((w - tw) // 2, (h - th) // 2),
            text,
            fill=(40, 40, 40),
        )
        img.save(path, format="PNG")

        return ImageResult(
            prompt=prompt,
            size=size,
            file_path=path,
            url=None,
            revised_prompt=None,
            style=style,
            seed=seed,
            provider=self.name,
            model="mock-1.0",
            created_at=datetime(2026, 5, 1, 0, 0, tzinfo=UTC),
            extra={"fingerprint": fp},
        )
