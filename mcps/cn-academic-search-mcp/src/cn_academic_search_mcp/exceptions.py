"""Custom exceptions for cn-academic-search-mcp."""

from __future__ import annotations


class CnAcademicSearchError(Exception):
    """Base exception."""


class ProviderUnavailableError(CnAcademicSearchError):
    """Raised when a provider cannot be used (missing creds, network, etc.)."""


class PaperNotFoundError(CnAcademicSearchError):
    """Raised when a paper id cannot be resolved by any provider."""


class AllProvidersFailedError(CnAcademicSearchError):
    """Raised when every registered provider failed for a request."""

    def __init__(self, message: str, tried: list[str], errors: dict[str, str]) -> None:
        super().__init__(message)
        self.tried = tried
        self.errors = errors
