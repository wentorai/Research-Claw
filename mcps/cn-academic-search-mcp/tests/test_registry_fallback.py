"""Tests for registry priority ordering and fallback behaviour."""

from __future__ import annotations

from typing import Any

import pytest

from cn_academic_search_mcp.exceptions import (
    AllProvidersFailedError,
    PaperNotFoundError,
)
from cn_academic_search_mcp.models import Paper, SearchResult
from cn_academic_search_mcp.providers import (
    BaseProvider,
    CnkiProvider,
    CqVipProvider,
    MockProvider,
    WanfangProvider,
)
from cn_academic_search_mcp.registry import ProviderRegistry, build_default_registry


class _RecordingProvider(BaseProvider):
    """Provider that records calls and can be configured to fail or succeed."""

    def __init__(
        self,
        name: str,
        priority: int = 100,
        available: bool = True,
        fail_with: Exception | None = None,
        result_paper_id: str = "rec:0001",
    ) -> None:
        self.name = name
        self.priority = priority
        self._available = available
        self._fail_with = fail_with
        self._result_paper_id = result_paper_id
        self.search_called = 0
        self.get_paper_called = 0

    async def is_available(self) -> bool:
        return self._available

    async def search(self, query: str, limit: int = 20, **filters: Any) -> SearchResult:
        self.search_called += 1
        if self._fail_with is not None:
            raise self._fail_with
        paper = Paper(
            paper_id=self._result_paper_id,
            provider=self.name,
            title=f"{self.name} title",
        )
        return SearchResult(
            query=query, total=1, papers=[paper], provider=self.name, tried_providers=[self.name]
        )

    async def get_paper(self, paper_id: str) -> Paper:
        self.get_paper_called += 1
        if self._fail_with is not None:
            raise self._fail_with
        return Paper(paper_id=paper_id, provider=self.name, title=f"{self.name} get")


# ----------------------------------------------------------------------
# Priority ordering
# ----------------------------------------------------------------------


def test_registry_orders_by_priority() -> None:
    reg = build_default_registry()
    order = [p.name for p in reg.providers_by_priority()]
    # CNKI(5) → Wanfang(10) → CqVip(20) → Mock(1000)
    assert order == ["cnki", "wanfang", "cqvip", "mock"]


def test_registry_stable_tiebreak_on_equal_priority() -> None:
    reg = ProviderRegistry()
    a = _RecordingProvider("a", priority=10)
    b = _RecordingProvider("b", priority=10)
    c = _RecordingProvider("c", priority=10)
    reg.register(a)
    reg.register(b)
    reg.register(c)
    assert [p.name for p in reg.providers_by_priority()] == ["a", "b", "c"]


def test_registry_register_duplicate_raises() -> None:
    reg = ProviderRegistry()
    reg.register(MockProvider())
    with pytest.raises(ValueError):
        reg.register(MockProvider())


# ----------------------------------------------------------------------
# Fallback semantics
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_falls_back_past_unavailable() -> None:
    high_unavailable = _RecordingProvider("hi", priority=1, available=False)
    low_available = _RecordingProvider("lo", priority=100, available=True, result_paper_id="lo:1")
    reg = ProviderRegistry([high_unavailable, low_available])

    result = await reg.search("foo")
    assert result.provider == "lo"
    assert result.tried_providers == ["hi", "lo"]
    assert high_unavailable.search_called == 0
    assert low_available.search_called == 1


@pytest.mark.asyncio
async def test_search_falls_back_on_not_implemented() -> None:
    boom = _RecordingProvider(
        "boom", priority=1, available=True, fail_with=NotImplementedError("nope")
    )
    ok = _RecordingProvider("ok", priority=100, available=True, result_paper_id="ok:1")
    reg = ProviderRegistry([boom, ok])

    result = await reg.search("q")
    assert result.provider == "ok"
    assert result.tried_providers == ["boom", "ok"]
    assert boom.search_called == 1
    assert ok.search_called == 1


@pytest.mark.asyncio
async def test_search_falls_back_on_arbitrary_exception() -> None:
    boom = _RecordingProvider(
        "boom", priority=1, available=True, fail_with=RuntimeError("network")
    )
    ok = _RecordingProvider("ok", priority=100, available=True)
    reg = ProviderRegistry([boom, ok])

    result = await reg.search("q")
    assert result.tried_providers == ["boom", "ok"]
    assert result.provider == "ok"


@pytest.mark.asyncio
async def test_search_all_fail_raises_all_providers_failed() -> None:
    bad1 = _RecordingProvider("a", priority=1, available=True, fail_with=NotImplementedError("a"))
    bad2 = _RecordingProvider("b", priority=2, available=True, fail_with=RuntimeError("b"))
    reg = ProviderRegistry([bad1, bad2])

    with pytest.raises(AllProvidersFailedError) as excinfo:
        await reg.search("q")

    err = excinfo.value
    assert err.tried == ["a", "b"]
    assert set(err.errors.keys()) == {"a", "b"}


@pytest.mark.asyncio
async def test_search_returns_first_successful() -> None:
    ok1 = _RecordingProvider("first", priority=1, available=True, result_paper_id="first:1")
    ok2 = _RecordingProvider("second", priority=2, available=True, result_paper_id="second:1")
    reg = ProviderRegistry([ok1, ok2])

    result = await reg.search("q")
    assert result.provider == "first"
    assert result.tried_providers == ["first"]
    assert ok1.search_called == 1
    assert ok2.search_called == 0


@pytest.mark.asyncio
async def test_search_only_provider_short_circuits(default_registry) -> None:
    # Force "mock" only — even though CNKI is higher priority.
    result = await default_registry.search("数字经济", provider="mock")
    assert result.provider == "mock"
    assert result.tried_providers == ["mock"]


@pytest.mark.asyncio
async def test_get_paper_routes_by_id_prefix(default_registry) -> None:
    paper = await default_registry.get_paper("mock:0001")
    assert paper.paper_id == "mock:0001"
    assert paper.provider == "mock"


@pytest.mark.asyncio
async def test_get_paper_falls_back_when_inferred_provider_fails() -> None:
    """If id prefix names a provider that throws, registry surfaces the error.

    Forcing a specific provider via the id-prefix shortcut means we don't
    fall through other providers — this test pins that behaviour.
    """
    cnki = CnkiProvider()  # raises NotImplementedError
    mock = MockProvider()
    reg = ProviderRegistry([cnki, mock])

    with pytest.raises(AllProvidersFailedError):
        # cnki:xxx → routed to cnki only, which raises NotImplementedError
        await reg.get_paper("cnki:does-not-matter")


@pytest.mark.asyncio
async def test_status_reports_availability(default_registry) -> None:
    statuses = await default_registry.status()
    by_name = {s.name: s for s in statuses}
    # No env tokens set ⇒ only mock is available
    assert by_name["mock"].available is True
    assert by_name["cnki"].available is False
    assert by_name["wanfang"].available is False
    assert by_name["cqvip"].available is False
    # Returned in priority order
    assert [s.name for s in statuses] == ["cnki", "wanfang", "cqvip", "mock"]


@pytest.mark.asyncio
async def test_default_registry_search_falls_through_to_mock(default_registry) -> None:
    """End-to-end: with no env tokens, search must succeed via Mock.

    The 3 skeleton providers are unavailable (no token) and Mock succeeds.
    """
    result = await default_registry.search("数字经济")
    assert result.provider == "mock"
    # All 4 providers were considered (3 skipped due to is_available, 1 succeeded)
    assert result.tried_providers == ["cnki", "wanfang", "cqvip", "mock"]
    assert result.total >= 1


def test_default_registry_contains_all_providers() -> None:
    reg = build_default_registry()
    names = {p.name for p in reg.all}
    assert names == {"cnki", "wanfang", "cqvip", "mock"}
    # Spot-check types
    assert isinstance(reg.get("cnki"), CnkiProvider)
    assert isinstance(reg.get("wanfang"), WanfangProvider)
    assert isinstance(reg.get("cqvip"), CqVipProvider)
    assert isinstance(reg.get("mock"), MockProvider)
