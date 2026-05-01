"""econ-image-mcp — multi-provider image-generation MCP for econ/management research.

Providers: DALL-E 3 (partial real impl via OpenAI HTTP API), FLUX.1 (skeleton),
Imagen 3 (skeleton), Ideogram v2 (skeleton), Recraft v3 (skeleton),
Mock (deterministic placeholder PNG, always available).
"""

from econ_image_mcp.models import (
    ImageRequest,
    ImageResult,
    ProviderStatus,
    TemplateInfo,
)
from econ_image_mcp.registry import ProviderRegistry

__all__ = [
    "ImageRequest",
    "ImageResult",
    "ProviderRegistry",
    "ProviderStatus",
    "TemplateInfo",
]

__version__ = "0.1.0"
