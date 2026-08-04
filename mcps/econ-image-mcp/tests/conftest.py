"""Shared pytest fixtures."""

from __future__ import annotations

import os
import tempfile

import pytest

from econ_image_mcp.providers.dalle import DalleProvider
from econ_image_mcp.providers.mock import MockProvider
from econ_image_mcp.registry import ProviderRegistry


@pytest.fixture
def mock_output_dir() -> str:
    return tempfile.mkdtemp(prefix="econ-image-mcp-test-")


@pytest.fixture
def mock_provider(mock_output_dir: str) -> MockProvider:
    return MockProvider(output_dir=mock_output_dir)


@pytest.fixture
def dalle_provider() -> DalleProvider:
    # Use a fake key so is_available() returns True; tests mock httpx.
    return DalleProvider(api_key="sk-test-fake-key")


@pytest.fixture
def mock_only_registry(mock_provider: MockProvider) -> ProviderRegistry:
    return ProviderRegistry([mock_provider])


@pytest.fixture(autouse=True)
def _clear_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make sure host env vars never leak into provider tests."""

    for key in (
        "OPENAI_API_KEY",
        "REPLICATE_API_TOKEN",
        "FAL_KEY",
        "BFL_API_KEY",
        "RECRAFT_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        if key in os.environ:
            monkeypatch.delenv(key)
