"""Shared pytest fixtures for the nsfc-mcp test suite."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from nsfc_mcp.client import DEFAULT_PATHS, NsfcClient

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "sample_response.json"
TEST_BASE_URL = "https://nsfc.example.test"


@pytest.fixture(scope="session")
def fixture_data() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def base_url() -> str:
    return TEST_BASE_URL


@pytest.fixture
def search_url(base_url: str) -> str:
    return f"{base_url}{DEFAULT_PATHS['search']}"


@pytest.fixture
def detail_url(base_url: str) -> str:
    return f"{base_url}{DEFAULT_PATHS['detail']}"


@pytest.fixture
def trends_url(base_url: str) -> str:
    return f"{base_url}{DEFAULT_PATHS['trends']}"


@pytest.fixture
def disciplines_url(base_url: str) -> str:
    return f"{base_url}{DEFAULT_PATHS['disciplines']}"


@pytest.fixture
async def client(base_url: str):
    """An ``NsfcClient`` whose underlying httpx client honours the mocked transport.

    pytest-httpx patches the global ``httpx.AsyncClient`` transport, so simply
    instantiating with the test base URL is enough.
    """
    c = NsfcClient(base_url=base_url, rate_per_sec=1000.0, max_retries=1)
    try:
        yield c
    finally:
        await c.aclose()


@pytest.fixture
def non_mocked_hosts() -> list[str]:
    # We mock everything; nothing should hit a real host.
    return []
