"""Provider registry, priority ordering, and fallback orchestration."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Iterable, TypeVar

from .exceptions import AllProvidersFailedError, ProviderUnavailableError
from .models import Paper, ProviderStatus, SearchResult
from .providers import (
    BaseProvider,
    CnkiProvider,
    CqVipProvider,
    MockProvider,
    WanfangProvider,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ProviderRegistry:
    """Holds providers, orders them by priority, and runs fallback logic."""

    def __init__(self, providers: Iterable[BaseProvider] | None = None) -> None:
        self._providers: list[BaseProvider] = []
        if providers is not None:
            for p in providers:
                self.register(p)

    # ---- registration -------------------------------------------------

    def register(self, provider: BaseProvider) -> None:
        if any(p.name == provider.name for p in self._providers):
            raise ValueError(f"Provider already registered: {provider.name}")
        self._providers.append(provider)

    def unregister(self, name: str) -> None:
        self._providers = [p for p in self._providers if p.name != name]

    def get(self, name: str) -> BaseProvider:
        for p in self._providers:
            if p.name == name:
                return p
        raise KeyError(f"Unknown provider: {name}")

    # ---- ordering -----------------------------------------------------

    def providers_by_priority(self) -> list[BaseProvider]:
        """Return providers sorted by priority ascending (lower = preferred).

        Registration order is preserved as a stable tiebreaker.
        """
        indexed = list(enumerate(self._providers))
        indexed.sort(key=lambda iv: (iv[1].priority, iv[0]))
        return [p for _, p in indexed]

    @property
    def all(self) -> list[BaseProvider]:
        return list(self._providers)

    # ---- status -------------------------------------------------------

    async def status(self) -> list[ProviderStatus]:
        out: list[ProviderStatus] = []
        for p in self.providers_by_priority():
            try:
                avail = await p.is_available()
            except Exception:  # noqa: BLE001 - status check must never throw
                avail = False
            out.append(
                ProviderStatus(
                    name=p.name,
                    priority=p.priority,
                    available=avail,
                    description=getattr(p, "description", "") or "",
                )
            )
        return out

    # ---- fallback orchestration ---------------------------------------

    async def _run_with_fallback(
        self,
        op: Callable[[BaseProvider], Awaitable[T]],
        *,
        only: str | None = None,
    ) -> tuple[T, list[str]]:
        """Try each provider in priority order until one succeeds.

        ``op`` is an async function ``(provider) -> result``.

        Returns the result and the list of provider names attempted (in
        order). If ``only`` is given, restricts to that provider (still
        records it in tried_providers).

        Raises :class:`AllProvidersFailedError` if every provider fails.
        """
        candidates: list[BaseProvider]
        if only is not None:
            candidates = [self.get(only)]
        else:
            candidates = self.providers_by_priority()

        if not candidates:
            raise AllProvidersFailedError(
                "No providers registered.", tried=[], errors={}
            )

        tried: list[str] = []
        errors: dict[str, str] = {}

        for provider in candidates:
            tried.append(provider.name)
            try:
                if not await provider.is_available():
                    errors[provider.name] = "unavailable (is_available=False)"
                    logger.info("provider %s unavailable, trying next", provider.name)
                    continue
            except Exception as exc:  # noqa: BLE001
                errors[provider.name] = f"is_available raised: {exc!r}"
                logger.info("provider %s is_available raised %r", provider.name, exc)
                continue

            try:
                result = await op(provider)
            except NotImplementedError as exc:
                errors[provider.name] = f"NotImplementedError: {exc}"
                logger.info("provider %s not implemented, falling back", provider.name)
                continue
            except ProviderUnavailableError as exc:
                errors[provider.name] = f"ProviderUnavailableError: {exc}"
                logger.info("provider %s reported unavailable: %s", provider.name, exc)
                continue
            except Exception as exc:  # noqa: BLE001 - intentional fallback
                errors[provider.name] = f"{type(exc).__name__}: {exc}"
                logger.warning("provider %s failed with %r, falling back", provider.name, exc)
                continue
            else:
                return result, tried

        raise AllProvidersFailedError(
            f"All providers failed (tried: {', '.join(tried)})",
            tried=tried,
            errors=errors,
        )

    # ---- high-level operations ---------------------------------------

    async def search(
        self,
        query: str,
        limit: int = 20,
        provider: str | None = None,
        **filters: Any,
    ) -> SearchResult:
        async def op(p: BaseProvider) -> SearchResult:
            return await p.search(query, limit=limit, **filters)

        result, tried = await self._run_with_fallback(op, only=provider)
        # Tag tried_providers so callers see the fallback chain.
        result.tried_providers = tried
        return result

    async def get_paper(
        self,
        paper_id: str,
        provider: str | None = None,
    ) -> Paper:
        # Heuristic: paper_id like "mock:0001" → route directly to that provider.
        inferred = None
        if ":" in paper_id:
            inferred = paper_id.split(":", 1)[0]
            if any(p.name == inferred for p in self._providers):
                provider = provider or inferred

        async def op(p: BaseProvider) -> Paper:
            return await p.get_paper(paper_id)

        result, _tried = await self._run_with_fallback(op, only=provider)
        return result


def build_default_registry() -> ProviderRegistry:
    """Construct the default provider line-up.

    Order of registration is the stable tiebreaker for equal priorities.
    Priorities (lower is preferred):

    - CNKI       : 5
    - Wanfang    : 10
    - CqVip      : 20
    - Mock       : 1000  (always tried last; always available)
    """
    reg = ProviderRegistry()
    reg.register(CnkiProvider())
    reg.register(WanfangProvider())
    reg.register(CqVipProvider())
    reg.register(MockProvider())
    return reg
