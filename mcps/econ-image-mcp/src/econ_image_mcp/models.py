"""Pydantic data models exchanged across providers and MCP tools."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ImageSize = Literal[
    "256x256",
    "512x512",
    "1024x1024",
    "1024x1792",
    "1792x1024",
    "1024x1536",
    "1536x1024",
]


class ImageRequest(BaseModel):
    """A normalized image-generation request."""

    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1)
    size: str = "1024x1024"
    style: str | None = None
    seed: int | None = None
    n: int = 1


class ImageResult(BaseModel):
    """The result of a single image-generation call."""

    model_config = ConfigDict(extra="forbid")

    prompt: str
    size: str
    file_path: str | None = Field(
        default=None,
        description="Local filesystem path of the generated image, if downloaded/written.",
    )
    url: str | None = Field(
        default=None,
        description="Remote URL for the generated image, when the provider returns one.",
    )
    revised_prompt: str | None = None
    style: str | None = None
    seed: int | None = None
    provider: str
    model: str | None = None
    created_at: datetime
    extra: dict[str, str] | None = None


class ProviderStatus(BaseModel):
    """Lightweight status row used by ``list_providers``."""

    model_config = ConfigDict(extra="forbid")

    name: str
    priority: int
    available: bool
    note: str | None = None


class TemplateInfo(BaseModel):
    """Metadata about a single prompt template."""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    template: str
    params: list[str]
    example: str | None = None
    category: str | None = None
