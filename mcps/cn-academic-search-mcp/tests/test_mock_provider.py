"""Tests for MockProvider: shape, filters, determinism."""

from __future__ import annotations

import pytest

from cn_academic_search_mcp.exceptions import PaperNotFoundError
from cn_academic_search_mcp.models import Paper, SearchResult
from cn_academic_search_mcp.providers import MockProvider


@pytest.mark.asyncio
async def test_mock_is_available(mock_provider: MockProvider) -> None:
    assert await mock_provider.is_available() is True


@pytest.mark.asyncio
async def test_mock_dataset_has_required_disciplines(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=100)
    disciplines = {p.discipline for p in result.papers}
    # Must cover the five required disciplines
    for required in {"经济学", "金融学", "管理学", "教育学", "医学"}:
        assert required in disciplines, f"missing discipline {required}"
    # Sanity: dataset size in the prescribed range
    assert 10 <= len(result.papers) <= 20


@pytest.mark.asyncio
async def test_mock_search_returns_search_result_shape(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("数字经济", limit=5)
    assert isinstance(result, SearchResult)
    assert result.provider == "mock"
    assert result.tried_providers == ["mock"]
    assert result.total == len(result.papers)
    assert result.total >= 1
    for p in result.papers:
        assert isinstance(p, Paper)
        assert p.paper_id.startswith("mock:")
        assert p.provider == "mock"
        assert p.title and p.title_en
        assert p.authors and all(a.name for a in p.authors)
        assert p.journal and p.year and p.doi and p.url


@pytest.mark.asyncio
async def test_mock_search_query_matches_keywords_and_authors(mock_provider: MockProvider) -> None:
    by_keyword = await mock_provider.search("机器学习")
    assert by_keyword.total >= 1
    assert any("机器学习" in p.title or "机器学习" in p.keywords for p in by_keyword.papers)

    by_author = await mock_provider.search("张伟")
    assert by_author.total >= 1
    assert any(any(a.name == "张伟" for a in p.authors) for p in by_author.papers)

    by_english_author = await mock_provider.search("Li Na")
    assert by_english_author.total >= 1


@pytest.mark.asyncio
async def test_mock_filter_year_from_year_to(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=100, year_from=2022, year_to=2023)
    assert result.total >= 1
    assert all(2022 <= (p.year or 0) <= 2023 for p in result.papers)


@pytest.mark.asyncio
async def test_mock_filter_exact_year(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=100, year=2023)
    assert all(p.year == 2023 for p in result.papers)
    assert result.total >= 1


@pytest.mark.asyncio
async def test_mock_filter_journal(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=100, journal="经济研究")
    assert all((p.journal or "") == "经济研究" for p in result.papers)
    assert result.total >= 1


@pytest.mark.asyncio
async def test_mock_filter_author(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=100, author="陈芳")
    assert result.total >= 1
    assert all(any("陈芳" in (a.name or "") for a in p.authors) for p in result.papers)


@pytest.mark.asyncio
async def test_mock_filter_keyword(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=100, keyword="ESG")
    assert result.total >= 1
    assert all(any("ESG" in kw for kw in p.keywords) for p in result.papers)


@pytest.mark.asyncio
async def test_mock_filter_combo(mock_provider: MockProvider) -> None:
    result = await mock_provider.search(
        "", limit=100, year_from=2020, year_to=2024, journal="金融研究"
    )
    assert result.total >= 1
    for p in result.papers:
        assert p.journal == "金融研究"
        assert 2020 <= (p.year or 0) <= 2024


@pytest.mark.asyncio
async def test_mock_limit_truncates(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("", limit=3)
    assert result.total == 3
    assert len(result.papers) == 3


@pytest.mark.asyncio
async def test_mock_search_is_deterministic(mock_provider: MockProvider) -> None:
    a = await mock_provider.search("数字", limit=10)
    b = await mock_provider.search("数字", limit=10)
    assert [p.paper_id for p in a.papers] == [p.paper_id for p in b.papers]


@pytest.mark.asyncio
async def test_mock_get_paper_roundtrip(mock_provider: MockProvider) -> None:
    paper = await mock_provider.get_paper("mock:0001")
    assert paper.paper_id == "mock:0001"
    assert paper.title


@pytest.mark.asyncio
async def test_mock_get_paper_missing(mock_provider: MockProvider) -> None:
    with pytest.raises(PaperNotFoundError):
        await mock_provider.get_paper("mock:does-not-exist")


@pytest.mark.asyncio
async def test_mock_no_match_returns_empty(mock_provider: MockProvider) -> None:
    result = await mock_provider.search("绝对不会出现的奇怪查询字符串xxxyyyzzz")
    assert result.total == 0
    assert result.papers == []
