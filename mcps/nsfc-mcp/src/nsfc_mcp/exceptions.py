"""Exception types raised by nsfc-mcp."""

from __future__ import annotations


class NsfcError(Exception):
    """Base exception for all nsfc-mcp failures."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class NsfcAuthError(NsfcError):
    """Raised when an authenticated request is rejected (401/403)."""


class NsfcRateLimitError(NsfcError):
    """Raised when the upstream signals rate limiting (HTTP 429)."""

    def __init__(
        self,
        message: str = "NSFC rate limit exceeded",
        *,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message, status_code=429)
        self.retry_after = retry_after
