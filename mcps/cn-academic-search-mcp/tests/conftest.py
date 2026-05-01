"""Shared pytest fixtures."""

from __future__ import annotations

import os

import pytest

from cn_academic_search_mcp.providers import MockProvider
from cn_academic_search_mcp.registry import ProviderRegistry, build_default_registry


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()


@pytest.fixture
def default_registry() -> ProviderRegistry:
    return build_default_registry()


@pytest.fixture
def mock_only_registry() -> ProviderRegistry:
    """Registry containing only the MockProvider (priority 1)."""
    reg = ProviderRegistry()
    mp = MockProvider()
    mp.priority = 1  # promote to top so it is tried first in this fixture
    reg.register(mp)
    return reg


@pytest.fixture(autouse=True)
def _scrub_provider_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests should run against an unauthenticated environment by default."""
    for var in ("WANFANG_TOKEN", "CQVIP_TOKEN", "CNKI_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    # Sanity check
    assert "WANFANG_TOKEN" not in os.environ
