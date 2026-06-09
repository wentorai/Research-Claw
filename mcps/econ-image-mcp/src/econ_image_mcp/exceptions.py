"""Exception hierarchy for econ-image-mcp."""

from __future__ import annotations


class EconImageError(Exception):
    """Base exception for all econ-image-mcp errors."""


class ProviderUnavailableError(EconImageError):
    """Raised when a provider's backend is not installed/configured/reachable."""


class ProviderAPIError(EconImageError):
    """Raised when an upstream provider API returns an error response."""


class NoProviderAvailableError(EconImageError):
    """Raised when no registered provider can satisfy the request."""


class TemplateNotFoundError(EconImageError):
    """Raised when a requested prompt template id is not in the library."""


class TemplateParameterError(EconImageError):
    """Raised when ``params`` passed to a template are missing required keys."""
