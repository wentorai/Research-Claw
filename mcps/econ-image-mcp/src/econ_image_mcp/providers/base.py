"""Abstract base class every image-generation provider must implement."""

from __future__ import annotations

from abc import ABC, abstractmethod

from econ_image_mcp.models import ImageResult


class BaseImageProvider(ABC):
    """Common interface for all image-generation providers.

    Subclasses set ``name`` (unique identifier) and ``priority`` (lower = tried
    first by the registry).
    """

    name: str = "base"
    priority: int = 100

    @abstractmethod
    async def is_available(self) -> bool:
        """Quick health check used by the registry for fallback routing."""

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        *,
        size: str = "1024x1024",
        style: str | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        """Generate an image and return an ``ImageResult``."""

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<{type(self).__name__} name={self.name!r} priority={self.priority}>"
