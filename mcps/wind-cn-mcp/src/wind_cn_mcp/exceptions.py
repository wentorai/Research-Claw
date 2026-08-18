"""Exception hierarchy for wind-cn-mcp."""

from __future__ import annotations


class WindCNError(Exception):
    """Base exception for all wind-cn-mcp errors."""


class ProviderUnavailableError(WindCNError):
    """Raised when a provider's backend is not installed/configured/reachable."""


class ProviderAPIError(WindCNError):
    """Raised when an upstream provider API returns an error response."""


class NoProviderAvailableError(WindCNError):
    """Raised when no registered provider can satisfy the request."""


class SymbolNotFoundError(WindCNError):
    """Raised when a symbol is not recognised by the provider."""
