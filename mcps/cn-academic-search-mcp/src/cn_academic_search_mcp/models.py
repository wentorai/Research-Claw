"""Pydantic data models for cn-academic-search-mcp."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class AuthorInfo(BaseModel):
    """Author metadata."""

    name: str = Field(..., description="Author name (中文 preferred)")
    name_en: Optional[str] = Field(default=None, description="English name if available")
    affiliation: Optional[str] = Field(default=None, description="Author affiliation / 单位")
    orcid: Optional[str] = Field(default=None, description="ORCID iD if known")


class Paper(BaseModel):
    """Single paper / article record."""

    paper_id: str = Field(..., description="Provider-prefixed unique id, e.g. mock:0001")
    provider: str = Field(..., description="Source provider name, e.g. mock / wanfang / cqvip / cnki")
    title: str = Field(..., description="Title in Chinese")
    title_en: Optional[str] = Field(default=None, description="Title in English")
    authors: list[AuthorInfo] = Field(default_factory=list)
    abstract: Optional[str] = Field(default=None, description="Abstract / 摘要")
    abstract_en: Optional[str] = Field(default=None, description="English abstract")
    keywords: list[str] = Field(default_factory=list, description="关键词")
    journal: Optional[str] = Field(default=None, description="Journal / 期刊")
    year: Optional[int] = Field(default=None, description="Publication year")
    volume: Optional[str] = Field(default=None)
    issue: Optional[str] = Field(default=None)
    pages: Optional[str] = Field(default=None)
    doi: Optional[str] = Field(default=None)
    url: Optional[str] = Field(default=None, description="Landing page URL")
    citations: Optional[int] = Field(default=None, description="Citation count if known")
    discipline: Optional[str] = Field(default=None, description="Discipline / 学科分类")


class SearchResult(BaseModel):
    """Result of a search request."""

    query: str
    total: int = Field(..., description="Number of results returned (not necessarily total available)")
    papers: list[Paper] = Field(default_factory=list)
    provider: str = Field(..., description="Provider that produced the results")
    tried_providers: list[str] = Field(
        default_factory=list,
        description="All provider names attempted (in order). The last one is the successful one.",
    )


class ProviderStatus(BaseModel):
    """Status entry returned by list_providers tool."""

    name: str
    priority: int
    available: bool
    description: str = ""
