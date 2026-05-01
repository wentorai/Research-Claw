"""Pydantic models describing NSFC query inputs and outputs.

The shapes are defined for the MCP boundary; the JSON the upstream actually
returns is normalized into these models inside ``client.py``. Field names
mirror common NSFC vocabulary so downstream agents can reason about them
without translating Chinese keys.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProjectQuery(BaseModel):
    """Query parameters accepted by ``search_projects``."""

    model_config = ConfigDict(extra="forbid")

    keyword: str | None = Field(default=None, description="标题/摘要/关键词模糊匹配")
    pi_name: str | None = Field(default=None, description="项目负责人姓名")
    institution: str | None = Field(default=None, description="依托单位")
    project_type: str | None = Field(
        default=None,
        description="项目类别，例如：面上/青年/重点/重大/优青/杰青",
    )
    discipline_code: str | None = Field(
        default=None,
        description="学科代码，例如 F02 表示信息科学部下子学科",
    )
    year: int | None = Field(default=None, ge=1986, le=2100, description="批准年度")
    page: int = Field(default=1, ge=1, description="页码，1-based")
    page_size: int = Field(default=20, ge=1, le=100, description="每页条数")


class Project(BaseModel):
    """Search-result row. A subset of fields will be present per record."""

    model_config = ConfigDict(extra="ignore")

    project_id: str = Field(description="项目批准号")
    title: str = Field(description="项目中文名称")
    pi_name: str | None = Field(default=None, description="项目负责人")
    institution: str | None = Field(default=None, description="依托单位")
    project_type: str | None = Field(default=None, description="项目类别")
    discipline_code: str | None = Field(default=None, description="申请代码")
    discipline_name: str | None = Field(default=None, description="学科名称")
    approval_year: int | None = Field(default=None, description="批准年度")
    funding: float | None = Field(default=None, description="批准金额(万元)")
    keywords: list[str] = Field(default_factory=list, description="关键词列表")

    @field_validator("keywords", mode="before")
    @classmethod
    def _split_keywords(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            # Common separators on NSFC pages: '；', ';', ',', '，', whitespace.
            for sep in ("；", ";", ",", "，"):
                if sep in value:
                    return [s.strip() for s in value.split(sep) if s.strip()]
            value = value.strip()
            return [value] if value else []
        return value


class ProjectListResult(BaseModel):
    """Paginated search response."""

    model_config = ConfigDict(extra="ignore")

    total: int = Field(description="匹配到的总条数")
    page: int = Field(description="当前页码")
    page_size: int = Field(description="每页条数")
    items: list[Project] = Field(default_factory=list)


class ProjectDetail(Project):
    """Detail page extends ``Project`` with abstract-level fields."""

    abstract: str | None = Field(default=None, description="中文摘要")
    abstract_en: str | None = Field(default=None, description="英文摘要")
    duration: str | None = Field(default=None, description="研究期限，例如 2020-01 至 2023-12")
    conclusion: str | None = Field(default=None, description="结题报告摘要(若公开)")


class TrendPoint(BaseModel):
    """Single ``(year, count)`` point of the trends series."""

    year: int
    count: int
    funding_total: float | None = Field(
        default=None, description="该年度总立项经费(万元)，若无数据为 None"
    )


class TrendsResult(BaseModel):
    """Aggregate result returned by ``get_trends``."""

    model_config = ConfigDict(extra="ignore")

    keyword: str
    year_from: int
    year_to: int
    points: list[TrendPoint] = Field(default_factory=list)
    total: int = Field(description="区间内累计立项数")


class Discipline(BaseModel):
    """One node in the NSFC discipline-code tree."""

    model_config = ConfigDict(extra="ignore")

    code: str = Field(description="学科代码，如 F02")
    name: str = Field(description="学科名称")
    parent_code: str | None = Field(default=None, description="父级学科代码")
    level: int = Field(default=1, ge=1, description="层级，1=学部，2=一级学科…")
