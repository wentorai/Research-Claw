"""Tests verifying skeleton providers raise the helpful NotImplementedError."""

from __future__ import annotations

import pytest

from cn_academic_search_mcp.providers import (
    CnkiProvider,
    CqVipProvider,
    WanfangProvider,
)


SKELETONS = [
    (WanfangProvider, "wanfang", "WANFANG_TOKEN", "docs/setup-wanfang.md"),
    (CqVipProvider, "cqvip", "CQVIP_TOKEN", "docs/setup-cqvip.md"),
    (CnkiProvider, "cnki", "CNKI_TOKEN", "docs/setup-cnki.md"),
]


@pytest.mark.parametrize("cls,name,_env,_doc", SKELETONS)
def test_skeleton_has_expected_metadata(cls, name, _env, _doc) -> None:
    p = cls()
    assert p.name == name
    assert p.priority < 1000  # higher priority than mock
    assert p.description, "skeleton provider should have a description"


@pytest.mark.parametrize("cls,_name,_env,doc", SKELETONS)
@pytest.mark.asyncio
async def test_search_raises_not_implemented_with_helpful_message(cls, _name, _env, doc) -> None:
    p = cls()
    with pytest.raises(NotImplementedError) as excinfo:
        await p.search("query")
    msg = str(excinfo.value)
    assert "机构访问令牌" in msg
    assert doc in msg


@pytest.mark.parametrize("cls,_name,_env,doc", SKELETONS)
@pytest.mark.asyncio
async def test_get_paper_raises_not_implemented_with_helpful_message(cls, _name, _env, doc) -> None:
    p = cls()
    with pytest.raises(NotImplementedError) as excinfo:
        await p.get_paper("any:id")
    assert doc in str(excinfo.value)


@pytest.mark.parametrize("cls,_name,env,_doc", SKELETONS)
@pytest.mark.asyncio
async def test_is_available_false_when_env_missing(
    cls, _name, env, _doc, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(env, raising=False)
    p = cls()
    assert await p.is_available() is False


@pytest.mark.parametrize("cls,_name,env,_doc", SKELETONS)
@pytest.mark.asyncio
async def test_is_available_true_when_env_set(
    cls, _name, env, _doc, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(env, "fake-token-for-test")
    p = cls()
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_is_available_false_when_env_empty_string(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WANFANG_TOKEN", "")
    p = WanfangProvider()
    assert await p.is_available() is False
