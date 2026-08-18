"""Tests for the low-level :class:`NsfcClient` against a mocked transport."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from nsfc_mcp.client import NsfcClient
from nsfc_mcp.exceptions import NsfcAuthError, NsfcError, NsfcRateLimitError
from nsfc_mcp.models import ProjectQuery


# ----------------------------------------------------------------- search


async def test_search_projects_happy_path(
    httpx_mock: Any, fixture_data: dict[str, Any], search_url: str, client: NsfcClient
) -> None:
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={
            "page": 1, "pageSize": 20, "keyword": "图神经网络",
        }),
        json=fixture_data["search_page1"],
    )

    result = await client.search_projects(
        ProjectQuery(keyword="图神经网络", page=1, page_size=20)
    )

    assert result.total == 2
    assert result.page == 1
    assert len(result.items) == 2
    first = result.items[0]
    assert first.project_id == "62076123"
    assert first.title.startswith("面向小样本")
    assert first.pi_name == "张三"
    assert first.institution == "清华大学"
    assert first.discipline_code == "F0211"
    assert first.approval_year == 2020
    assert first.funding == 64.0
    assert "图神经网络" in first.keywords
    assert "迁移学习" in first.keywords


async def test_search_projects_full_param_set(
    httpx_mock: Any, fixture_data: dict[str, Any], search_url: str, client: NsfcClient
) -> None:
    expected_params = {
        "page": 2,
        "pageSize": 10,
        "keyword": "可解释",
        "projectAdmin": "李四",
        "dependUnit": "北京大学",
        "projectType": "青年科学基金项目",
        "subjectCode": "F0211",
        "approvalYear": 2021,
    }
    httpx_mock.add_response(
        url=httpx.URL(search_url, params=expected_params),
        json={"data": {"total": 1, "list": [
            fixture_data["search_page1"]["data"]["list"][1]
        ]}},
    )

    result = await client.search_projects(ProjectQuery(
        keyword="可解释",
        pi_name="李四",
        institution="北京大学",
        project_type="青年科学基金项目",
        discipline_code="F0211",
        year=2021,
        page=2,
        page_size=10,
    ))
    assert result.total == 1
    assert result.items[0].project_id == "62106045"
    assert result.page_size == 10


# ----------------------------------------------------------------- detail


async def test_get_project_detail_returns_full_record(
    httpx_mock: Any, fixture_data: dict[str, Any], detail_url: str, client: NsfcClient
) -> None:
    httpx_mock.add_response(
        url=httpx.URL(detail_url, params={"id": "62076123"}),
        json=fixture_data["detail"],
    )
    detail = await client.get_project_detail("62076123")
    assert detail.project_id == "62076123"
    assert detail.abstract and "小样本" in detail.abstract
    assert detail.abstract_en and detail.abstract_en.startswith("This project")
    assert detail.duration == "2021-01 至 2024-12"
    assert "图神经网络" in detail.keywords


async def test_get_project_detail_rejects_empty_id(client: NsfcClient) -> None:
    with pytest.raises(NsfcError):
        await client.get_project_detail("")


# ----------------------------------------------------------------- trends


async def test_get_trends_aggregates_points(
    httpx_mock: Any, fixture_data: dict[str, Any], trends_url: str, client: NsfcClient
) -> None:
    httpx_mock.add_response(
        url=httpx.URL(trends_url, params={
            "keyword": "图神经网络", "yearFrom": 2018, "yearTo": 2021
        }),
        json=fixture_data["trends"],
    )
    trends = await client.get_trends("图神经网络", year_from=2018, year_to=2021)
    assert [p.year for p in trends.points] == [2018, 2019, 2020, 2021]
    assert [p.count for p in trends.points] == [12, 21, 35, 48]
    assert trends.total == 12 + 21 + 35 + 48
    assert trends.points[2].funding_total == 2100.0


async def test_get_trends_rejects_inverted_range(client: NsfcClient) -> None:
    with pytest.raises(NsfcError):
        await client.get_trends("x", year_from=2025, year_to=2020)


async def test_get_trends_handles_dict_shorthand(
    httpx_mock: Any, trends_url: str, client: NsfcClient
) -> None:
    httpx_mock.add_response(
        url=httpx.URL(trends_url, params={
            "keyword": "k", "yearFrom": 2020, "yearTo": 2022
        }),
        json={"data": {"points": {"2020": 5, "2021": 7, "2022": 9}}},
    )
    trends = await client.get_trends("k", year_from=2020, year_to=2022)
    assert trends.total == 21
    assert [p.year for p in trends.points] == [2020, 2021, 2022]


# ----------------------------------------------------------------- disciplines


async def test_list_disciplines_returns_tree_nodes(
    httpx_mock: Any,
    fixture_data: dict[str, Any],
    disciplines_url: str,
    client: NsfcClient,
) -> None:
    httpx_mock.add_response(
        url=disciplines_url, json=fixture_data["disciplines"]
    )
    nodes = await client.list_disciplines()
    codes = {n.code for n in nodes}
    assert {"F", "F02", "F0211"} <= codes
    f02 = next(n for n in nodes if n.code == "F02")
    assert f02.parent_code == "F"


# ----------------------------------------------------------------- suggest


async def test_suggest_keywords_aggregates_cooccurrence(
    httpx_mock: Any, fixture_data: dict[str, Any], search_url: str, client: NsfcClient
) -> None:
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={
            "page": 1, "pageSize": 50, "keyword": "图神经网络"
        }),
        json=fixture_data["search_page1"],
    )
    suggestions = await client.suggest_keywords("图神经网络")
    # The seed keyword itself must be filtered out.
    assert "图神经网络" not in suggestions
    assert "迁移学习" in suggestions
    assert "图卷积" in suggestions


# ----------------------------------------------------------------- errors


async def test_rate_limit_retries_then_raises(
    httpx_mock: Any, search_url: str
) -> None:
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={"page": 1, "pageSize": 20, "keyword": "x"}),
        status_code=429,
        headers={"Retry-After": "0"},
    )
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={"page": 1, "pageSize": 20, "keyword": "x"}),
        status_code=429,
        headers={"Retry-After": "0"},
    )
    c = NsfcClient(base_url="https://nsfc.example.test", rate_per_sec=1000.0, max_retries=1)
    try:
        with pytest.raises(NsfcRateLimitError):
            await c.search_projects(ProjectQuery(keyword="x"))
    finally:
        await c.aclose()


async def test_rate_limit_recovers_on_retry(
    httpx_mock: Any, search_url: str, fixture_data: dict[str, Any]
) -> None:
    params = {"page": 1, "pageSize": 20, "keyword": "x"}
    httpx_mock.add_response(
        url=httpx.URL(search_url, params=params),
        status_code=429,
        headers={"Retry-After": "0"},
    )
    httpx_mock.add_response(
        url=httpx.URL(search_url, params=params),
        json=fixture_data["search_page1"],
    )
    c = NsfcClient(base_url="https://nsfc.example.test", rate_per_sec=1000.0, max_retries=1)
    try:
        result = await c.search_projects(ProjectQuery(keyword="x"))
        assert result.total == 2
    finally:
        await c.aclose()


async def test_server_error_raises(httpx_mock: Any, search_url: str, client: NsfcClient) -> None:
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={"page": 1, "pageSize": 20, "keyword": "x"}),
        status_code=500,
        text="boom",
    )
    with pytest.raises(NsfcError) as excinfo:
        await client.search_projects(ProjectQuery(keyword="x"))
    assert excinfo.value.status_code == 500


async def test_auth_error_raises(httpx_mock: Any, detail_url: str, client: NsfcClient) -> None:
    httpx_mock.add_response(
        url=httpx.URL(detail_url, params={"id": "abc"}),
        status_code=403,
        text="forbidden",
    )
    with pytest.raises(NsfcAuthError):
        await client.get_project_detail("abc")


async def test_timeout_raises_nsfc_error(httpx_mock: Any, search_url: str, client: NsfcClient) -> None:
    httpx_mock.add_exception(httpx.ReadTimeout("simulated"))
    with pytest.raises(NsfcError) as excinfo:
        await client.search_projects(ProjectQuery(keyword="x"))
    assert "timed out" in str(excinfo.value)


# ----------------------------------------------------------------- validation


async def test_search_validates_bad_payload(httpx_mock: Any, search_url: str, client: NsfcClient) -> None:
    httpx_mock.add_response(
        url=httpx.URL(search_url, params={"page": 1, "pageSize": 20, "keyword": "x"}),
        json="not-an-object",
    )
    with pytest.raises(NsfcError):
        await client.search_projects(ProjectQuery(keyword="x"))


def test_project_query_rejects_bad_year() -> None:
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        ProjectQuery(year=1500)


def test_project_query_rejects_bad_page_size() -> None:
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        ProjectQuery(page_size=0)
