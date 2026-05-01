"""Abstract base class for academic database providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..models import Paper, SearchResult


class BaseProvider(ABC):
    """Abstract provider for a Chinese academic database backend.

    Subclasses must implement :meth:`search`, :meth:`get_paper`, and
    :meth:`is_available`.

    The :attr:`priority` field controls fallback order. Lower values are
    preferred (similar to Unix `nice`); ties broken by registration order.
    """

    name: str = "base"
    priority: int = 100
    description: str = ""

    @abstractmethod
    async def search(
        self,
        query: str,
        limit: int = 20,
        **filters: Any,
    ) -> SearchResult:
        """Search papers matching ``query``.

        Recognized filters (provider may ignore unknown ones):

        - ``year_from`` / ``year_to`` (int)
        - ``author`` (str)
        - ``journal`` (str)
        - ``keyword`` (str)
        """

    @abstractmethod
    async def get_paper(self, paper_id: str) -> Paper:
        """Return a single paper by its provider-prefixed id."""

    @abstractmethod
    async def is_available(self) -> bool:
        """Return True if the provider is ready to serve requests."""
