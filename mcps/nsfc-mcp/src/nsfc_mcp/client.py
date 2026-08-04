"""Async HTTP client for NSFC public query endpoints.

Implementation notes
--------------------
NSFC's public site at ``kd.nsfc.cn`` exposes search and detail pages that are
rendered server-side. The site is known to ship JSON payloads behind a few
backend endpoints whose exact paths change over time and which carry anti-bot
measures. Rather than hard-code one URL family we go through a small adapter
layer:

* ``_request`` is the only place that touches the network. It enforces a
  token-bucket rate limiter, retries once on 429, and lifts transport
  exceptions into our ``NsfcError`` hierarchy so callers never have to import
  ``httpx``.
* The endpoint paths below are *defaults*. They can be overridden at runtime
  by passing a ``paths`` mapping or by setting the ``NSFC_BASE_URL`` /
  ``NSFC_TOKEN`` env vars.
* The client is intentionally tolerant when normalizing fields: the public
  site has shipped at least three different JSON key conventions and we map
  whichever ones are present.

TODO: when NSFC publishes a stable JSON API we can drop the HTML fallback
path and the ``selectolax`` dependency. For now ``_parse_html_*`` exists only
as a future extension point and is not exercised by tests.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Mapping

import httpx

from nsfc_mcp.exceptions import NsfcAuthError, NsfcError, NsfcRateLimitError
from nsfc_mcp.models import (
    Discipline,
    Project,
    ProjectDetail,
    ProjectListResult,
    ProjectQuery,
    TrendPoint,
    TrendsResult,
)

DEFAULT_BASE_URL = "https://kd.nsfc.cn"
DEFAULT_USER_AGENT = (
    "nsfc-mcp/0.1 (+https://github.com/research-claw/nsfc-mcp; academic research only)"
)

DEFAULT_PATHS: dict[str, str] = {
    # These paths are intentional placeholders that mirror the structure of
    # the public site. Override via the ``paths=`` kwarg in tests.
    "search": "/api/baseQuery/conclusionQueryResultsData",
    "detail": "/api/baseQuery/completeProjectInfo",
    "trends": "/api/baseQuery/yearTrend",
    "disciplines": "/api/baseQuery/disciplineTree",
}


class _TokenBucket:
    """Tiny async-safe token bucket (1 request / interval seconds by default)."""

    def __init__(self, rate_per_sec: float) -> None:
        self._interval = 1.0 / max(rate_per_sec, 1e-6)
        self._lock = asyncio.Lock()
        self._next_allowed = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self._next_allowed - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = time.monotonic()
            self._next_allowed = now + self._interval


class NsfcClient:
    """Thin async wrapper around the NSFC public endpoints."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        token: str | None = None,
        timeout: float = 15.0,
        rate_per_sec: float = 1.0,
        max_retries: int = 1,
        client: httpx.AsyncClient | None = None,
        paths: Mapping[str, str] | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("NSFC_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.token = token if token is not None else os.environ.get("NSFC_TOKEN")
        self._timeout = timeout
        self._max_retries = max_retries
        self._bucket = _TokenBucket(rate_per_sec)
        self._owns_client = client is None
        self._paths = {**DEFAULT_PATHS, **(paths or {})}
        headers = {
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "application/json, text/html;q=0.9, */*;q=0.5",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self._client = client or httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
            follow_redirects=True,
        )

    async def __aenter__(self) -> "NsfcClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ------------------------------------------------------------------ HTTP
    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
    ) -> Any:
        attempt = 0
        last_exc: Exception | None = None
        while attempt <= self._max_retries:
            await self._bucket.acquire()
            try:
                resp = await self._client.request(method, path, params=params, json=json)
            except httpx.TimeoutException as exc:  # network timeout
                raise NsfcError(f"NSFC request timed out: {exc}") from exc
            except httpx.TransportError as exc:
                raise NsfcError(f"NSFC transport error: {exc}") from exc

            if resp.status_code == 429:
                retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                if attempt < self._max_retries:
                    await asyncio.sleep(retry_after or 1.0)
                    attempt += 1
                    continue
                raise NsfcRateLimitError(retry_after=retry_after)
            if resp.status_code in (401, 403):
                raise NsfcAuthError(
                    f"NSFC auth failed (status={resp.status_code})",
                    status_code=resp.status_code,
                )
            if resp.status_code >= 500:
                raise NsfcError(
                    f"NSFC upstream error (status={resp.status_code})",
                    status_code=resp.status_code,
                )
            if resp.status_code >= 400:
                raise NsfcError(
                    f"NSFC bad request (status={resp.status_code}): {resp.text[:200]}",
                    status_code=resp.status_code,
                )

            content_type = resp.headers.get("Content-Type", "")
            if "json" in content_type or resp.text.lstrip().startswith(("{", "[")):
                try:
                    return resp.json()
                except ValueError as exc:
                    raise NsfcError(f"Invalid JSON from NSFC: {exc}") from exc
            return resp.text
        # Should be unreachable; retry loop always either returns or raises.
        raise NsfcError(f"NSFC request failed after retries: {last_exc}")

    # ------------------------------------------------------------------ ops
    async def search_projects(self, query: ProjectQuery) -> ProjectListResult:
        params = _build_search_params(query)
        payload = await self._request("GET", self._paths["search"], params=params)
        return _normalize_search_result(payload, page=query.page, page_size=query.page_size)

    async def get_project_detail(self, project_id: str) -> ProjectDetail:
        if not project_id:
            raise NsfcError("project_id must be a non-empty string")
        payload = await self._request(
            "GET", self._paths["detail"], params={"id": project_id}
        )
        return _normalize_detail(payload, project_id=project_id)

    async def get_trends(
        self,
        keyword: str,
        *,
        year_from: int = 2015,
        year_to: int = 2026,
    ) -> TrendsResult:
        if year_to < year_from:
            raise NsfcError("year_to must be >= year_from")
        payload = await self._request(
            "GET",
            self._paths["trends"],
            params={"keyword": keyword, "yearFrom": year_from, "yearTo": year_to},
        )
        return _normalize_trends(
            payload, keyword=keyword, year_from=year_from, year_to=year_to
        )

    async def list_disciplines(self, parent_code: str | None = None) -> list[Discipline]:
        params = {"parentCode": parent_code} if parent_code else None
        payload = await self._request("GET", self._paths["disciplines"], params=params)
        return _normalize_disciplines(payload, parent_code=parent_code)

    async def suggest_keywords(self, topic: str, *, limit: int = 20) -> list[str]:
        """Co-occurrence based keyword suggestions.

        Strategy: pull the first page of search hits for ``topic`` and
        aggregate the ``keywords`` column. This is a pragmatic stand-in for a
        real co-occurrence index and runs entirely off the search endpoint we
        already mock.
        """
        result = await self.search_projects(
            ProjectQuery(keyword=topic, page=1, page_size=50)
        )
        counts: dict[str, int] = {}
        topic_norm = topic.strip().lower()
        for proj in result.items:
            for kw in proj.keywords:
                key = kw.strip()
                if not key or key.lower() == topic_norm:
                    continue
                counts[key] = counts.get(key, 0) + 1
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return [k for k, _ in ranked[:limit]]


# --------------------------------------------------------------------- helpers


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _build_search_params(query: ProjectQuery) -> dict[str, Any]:
    """Map our ``ProjectQuery`` onto the camelCase param names NSFC uses."""
    params: dict[str, Any] = {
        "page": query.page,
        "pageSize": query.page_size,
    }
    if query.keyword:
        params["keyword"] = query.keyword
    if query.pi_name:
        params["projectAdmin"] = query.pi_name
    if query.institution:
        params["dependUnit"] = query.institution
    if query.project_type:
        params["projectType"] = query.project_type
    if query.discipline_code:
        params["subjectCode"] = query.discipline_code
    if query.year is not None:
        params["approvalYear"] = query.year
    return params


def _coerce_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def _coerce_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# Maps the various upstream key spellings -> our canonical Project fields.
_PROJECT_KEY_MAP: dict[str, str] = {
    "projectId": "project_id",
    "id": "project_id",
    "ratifyNo": "project_id",
    "approvalNumber": "project_id",
    "projectName": "title",
    "projectTitle": "title",
    "title": "title",
    "name": "title",
    "projectAdmin": "pi_name",
    "principalInvestigator": "pi_name",
    "piName": "pi_name",
    "leader": "pi_name",
    "dependUnit": "institution",
    "institution": "institution",
    "unitName": "institution",
    "projectType": "project_type",
    "category": "project_type",
    "subjectCode": "discipline_code",
    "disciplineCode": "discipline_code",
    "subjectName": "discipline_name",
    "disciplineName": "discipline_name",
    "approvalYear": "approval_year",
    "year": "approval_year",
    "approvalAmount": "funding",
    "funding": "funding",
    "amount": "funding",
    "keywords": "keywords",
    "keywordsCh": "keywords",
}

_DETAIL_KEY_MAP: dict[str, str] = {
    **_PROJECT_KEY_MAP,
    "abstract": "abstract",
    "abstractCh": "abstract",
    "abstractEn": "abstract_en",
    "projectAbstractEn": "abstract_en",
    "duration": "duration",
    "researchPeriod": "duration",
    "conclusionAbstract": "conclusion",
    "achievementAbstract": "conclusion",
}


def _project_from_dict(data: Mapping[str, Any], key_map: Mapping[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for src_key, value in data.items():
        canonical = key_map.get(src_key)
        if canonical is None:
            continue
        if canonical == "approval_year":
            out[canonical] = _coerce_int(value)
        elif canonical == "funding":
            out[canonical] = _coerce_float(value)
        else:
            out[canonical] = value
    out.setdefault("project_id", str(data.get("projectId") or data.get("id") or "unknown"))
    out.setdefault("title", str(data.get("title") or data.get("projectName") or ""))
    return out


def _normalize_search_result(
    payload: Any, *, page: int, page_size: int
) -> ProjectListResult:
    if not isinstance(payload, Mapping):
        raise NsfcError("Unexpected NSFC response: not a JSON object")
    # NSFC sometimes wraps the body in {"code":0,"data":{...}}.
    body = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    raw_items = (
        body.get("items")
        or body.get("list")
        or body.get("resultsData")
        or body.get("rows")
        or []
    )
    if not isinstance(raw_items, list):
        raise NsfcError("Unexpected NSFC response: items is not a list")
    items: list[Project] = []
    for raw in raw_items:
        if not isinstance(raw, Mapping):
            continue
        items.append(Project.model_validate(_project_from_dict(raw, _PROJECT_KEY_MAP)))
    total = (
        _coerce_int(body.get("total"))
        or _coerce_int(body.get("totalCount"))
        or _coerce_int(payload.get("total"))
        or len(items)
    )
    return ProjectListResult(
        total=total or 0,
        page=page,
        page_size=page_size,
        items=items,
    )


def _normalize_detail(payload: Any, *, project_id: str) -> ProjectDetail:
    if not isinstance(payload, Mapping):
        raise NsfcError("Unexpected NSFC detail response: not a JSON object")
    body = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    if not isinstance(body, Mapping):
        raise NsfcError("Unexpected NSFC detail response: missing body")
    record = _project_from_dict(body, _DETAIL_KEY_MAP)
    record.setdefault("project_id", project_id)
    return ProjectDetail.model_validate(record)


def _normalize_trends(
    payload: Any, *, keyword: str, year_from: int, year_to: int
) -> TrendsResult:
    if not isinstance(payload, Mapping):
        raise NsfcError("Unexpected NSFC trends response: not a JSON object")
    body = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    raw_points = body.get("points") or body.get("series") or body.get("yearly") or []
    points: list[TrendPoint] = []
    if isinstance(raw_points, list):
        for raw in raw_points:
            if not isinstance(raw, Mapping):
                continue
            year = _coerce_int(raw.get("year") or raw.get("y"))
            count = _coerce_int(raw.get("count") or raw.get("c") or raw.get("value"))
            if year is None or count is None:
                continue
            points.append(
                TrendPoint(
                    year=year,
                    count=count,
                    funding_total=_coerce_float(
                        raw.get("fundingTotal") or raw.get("amount")
                    ),
                )
            )
    elif isinstance(raw_points, Mapping):
        # ``{"2020": 12, "2021": 18, ...}`` shorthand
        for year_key, value in raw_points.items():
            year = _coerce_int(year_key)
            count = _coerce_int(value)
            if year is None or count is None:
                continue
            points.append(TrendPoint(year=year, count=count))

    points.sort(key=lambda p: p.year)
    total = sum(p.count for p in points)
    return TrendsResult(
        keyword=keyword,
        year_from=year_from,
        year_to=year_to,
        points=points,
        total=total,
    )


def _normalize_disciplines(
    payload: Any, *, parent_code: str | None
) -> list[Discipline]:
    if not isinstance(payload, Mapping):
        raise NsfcError("Unexpected NSFC disciplines response: not a JSON object")
    body = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    raw_nodes = body.get("nodes") or body.get("list") or body.get("tree") or []
    if not isinstance(raw_nodes, list):
        return []
    out: list[Discipline] = []
    for node in raw_nodes:
        if not isinstance(node, Mapping):
            continue
        out.append(
            Discipline(
                code=str(node.get("code") or node.get("subjectCode") or ""),
                name=str(node.get("name") or node.get("subjectName") or ""),
                parent_code=node.get("parentCode") or parent_code,
                level=_coerce_int(node.get("level")) or 1,
            )
        )
    return out
