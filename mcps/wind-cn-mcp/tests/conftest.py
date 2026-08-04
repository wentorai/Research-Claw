"""Shared pytest fixtures."""

from __future__ import annotations

import pytest

from wind_cn_mcp.providers.mock import MockProvider
from wind_cn_mcp.providers.tushare import TushareProvider
from wind_cn_mcp.registry import ProviderRegistry


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def tushare_provider() -> TushareProvider:
    # Use a fake token so is_available() returns True; tests mock httpx.
    return TushareProvider(token="test-token-xxx")


@pytest.fixture
def mock_only_registry(mock_provider: MockProvider) -> ProviderRegistry:
    return ProviderRegistry([mock_provider])
