"""Provider registry with priority ordering and graceful fallback."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import TypeVar

from econ_image_mcp.exceptions import (
    NoProviderAvailableError,
    ProviderAPIError,
    ProviderUnavailableError,
)
from econ_image_mcp.models import ProviderStatus
from econ_image_mcp.providers.base import BaseImageProvider

T = TypeVar("T")
log = logging.getLogger(__name__)

# Errors that mean "this provider can't satisfy the request, try the next one"
# rather than a hard failure of the whole call.
_FALLBACK_ERRORS: tuple[type[BaseException], ...] = (
    NotImplementedError,
    ProviderUnavailableError,
    ProviderAPIError,
)


class ProviderRegistry:
    """Holds providers and routes calls in priority order."""

    def __init__(self, providers: Iterable[BaseImageProvider] | None = None) -> None:
        self._providers: list[BaseImageProvider] = []
        if providers:
            for p in providers:
                self.register(p)

    def register(self, provider: BaseImageProvider) -> None:
        if any(p.name == provider.name for p in self._providers):
            raise ValueError(f"provider {provider.name!r} already registered")
        self._providers.append(provider)
        self._providers.sort(key=lambda p: p.priority)

    @property
    def providers(self) -> list[BaseImageProvider]:
        return list(self._providers)

    def get(self, name: str) -> BaseImageProvider:
        for p in self._providers:
            if p.name == name:
                return p
        raise NoProviderAvailableError(f"no provider named {name!r}")

    async def status(self) -> list[ProviderStatus]:
        out: list[ProviderStatus] = []
        for p in self._providers:
            try:
                avail = await p.is_available()
                note = None
            except Exception as exc:  # pragma: no cover - defensive
                avail = False
                note = f"is_available raised: {exc}"
            out.append(
                ProviderStatus(
                    name=p.name,
                    priority=p.priority,
                    available=avail,
                    note=note,
                )
            )
        return out

    async def call(
        self,
        op: Callable[[BaseImageProvider], Awaitable[T]],
        *,
        prefer: str | None = None,
    ) -> T:
        """Run ``op`` against the first provider that succeeds.

        * If ``prefer`` is set, try that provider only — no fallback, so the
          caller sees the explicit provider's error.
        * Otherwise iterate by priority, skip unavailable providers, and fall
          back on any of ``_FALLBACK_ERRORS``.
        """

        if prefer is not None:
            return await op(self.get(prefer))

        last_err: BaseException | None = None
        tried: list[str] = []
        for provider in self._providers:
            try:
                if not await provider.is_available():
                    tried.append(f"{provider.name}(unavailable)")
                    continue
            except Exception as exc:  # pragma: no cover - defensive
                tried.append(f"{provider.name}(is_available-raised:{exc})")
                continue
            try:
                return await op(provider)
            except _FALLBACK_ERRORS as exc:
                tried.append(f"{provider.name}({type(exc).__name__})")
                last_err = exc
                log.info("provider %s failed (%s); falling back", provider.name, exc)
                continue

        msg = f"no provider could satisfy the request; tried: {tried or 'none registered'}"
        if last_err is not None:
            raise NoProviderAvailableError(msg) from last_err
        raise NoProviderAvailableError(msg)


def default_registry() -> ProviderRegistry:
    """Build the registry with the standard image-provider lineup.

    Order is enforced by each provider's ``priority``:
    flux (15) → dalle (20) → imagen (25) → ideogram (30) → recraft (40) → mock (1000).
    """

    from econ_image_mcp.providers.dalle import DalleProvider
    from econ_image_mcp.providers.flux import FluxProvider
    from econ_image_mcp.providers.ideogram import IdeogramProvider
    from econ_image_mcp.providers.imagen import ImagenProvider
    from econ_image_mcp.providers.mock import MockProvider
    from econ_image_mcp.providers.recraft import RecraftProvider

    return ProviderRegistry(
        [
            FluxProvider(),
            DalleProvider(),
            ImagenProvider(),
            IdeogramProvider(),
            RecraftProvider(),
            MockProvider(),
        ]
    )
