# cn-academic-search-mcp

Unified **MCP server** for Chinese academic database search across **万方 (Wanfang)**, **维普 (CqVip)**, and **中国知网 (CNKI)** — with a deterministic mock provider for development and testing.

Part of [Research-Claw (科研龙虾)](https://github.com/research-claw).

## Why this exists

The three major Chinese academic databases all require **institutional access** (campus IP, CARSI SSO, or paid contracts) and do not expose stable public APIs. Rather than ship something that works only inside a single university, this server implements a **pluggable Provider abstraction**:

- A fully working `MockProvider` with ~16 synthetic Chinese papers across 经济 / 金融 / 管理 / 教育 / 医学 — drives all tests and lets the server be useful out of the box.
- Skeleton providers for `WanfangProvider`, `CqVipProvider`, `CnkiProvider` that raise `NotImplementedError` with a pointer to the relevant `docs/setup-*.md`.
- A registry with **priority ordering** and **automatic fallback**: CNKI → Wanfang → CqVip → Mock. If a higher-priority provider is unauthenticated or fails, the next one is tried; the response includes a `tried_providers` field showing the chain.

The architecture is a clean-room implementation of the multi-provider pattern common in the MCP ecosystem. **No source code is copied** from any upstream project. See `NOTICE` for the inspirations.

## Install

```bash
cd cn-academic-search-mcp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Run the tests

```bash
.venv/bin/pytest tests/ -v
```

All tests must pass against the `MockProvider`.

## Use as a Claude Desktop MCP server

See `examples/claude_desktop_config.json`. Minimal config:

```jsonc
{
  "mcpServers": {
    "cn-academic-search": {
      "command": "python",
      "args": ["-m", "cn_academic_search_mcp"],
      "env": {
        // Set these only after implementing the corresponding provider
        // and obtaining institutional access. See docs/setup-*.md.
        "WANFANG_TOKEN": "",
        "CQVIP_TOKEN": "",
        "CNKI_TOKEN": ""
      }
    }
  }
}
```

## MCP tools

| Tool             | Description                                                                          |
| ---------------- | ------------------------------------------------------------------------------------ |
| `search`         | Unified search; tries providers in priority order, falls back on failure.            |
| `get_paper`      | Fetch a paper by `provider:id` (e.g. `mock:0001`); routes by id prefix when present. |
| `list_providers` | Show every provider with its priority and current `is_available()` status.           |

### `search` arguments

- `query` — free-text query (matches title / abstract / keywords / authors).
- `limit` — max results, default 20.
- `year_from` / `year_to` — inclusive year filter.
- `author`, `journal`, `keyword` — substring filters.
- `provider` — force a specific source (skips fallback).

## Architecture

```
┌─────────────────────────┐
│  FastMCP server.py      │  tools: search / get_paper / list_providers
└──────────┬──────────────┘
           │
┌──────────▼──────────────┐
│  registry.py            │  priority order + fallback orchestration
└──────────┬──────────────┘
           │
   ┌───────┼────────────┬───────────────┬────────────┐
   ▼       ▼            ▼               ▼            ▼
 cnki   wanfang       cqvip           mock        (your custom)
 (skel) (skel)        (skel)        (deterministic)
   prio=5 prio=10     prio=20       prio=1000
```

Implement a custom backend by subclassing `BaseProvider` and registering it on a `ProviderRegistry`:

```python
from cn_academic_search_mcp.providers import BaseProvider
from cn_academic_search_mcp.registry import ProviderRegistry, build_default_registry

class MyProvider(BaseProvider):
    name = "mine"
    priority = 50
    async def search(self, query, limit=20, **filters): ...
    async def get_paper(self, paper_id): ...
    async def is_available(self): return True

reg = build_default_registry()
reg.register(MyProvider())
```

## Implementing a real provider

Each skeleton provider has detailed setup instructions:

- [`docs/setup-wanfang.md`](docs/setup-wanfang.md)
- [`docs/setup-cqvip.md`](docs/setup-cqvip.md)
- [`docs/setup-cnki.md`](docs/setup-cnki.md)

> **Important:** these databases require legitimate institutional access. Do not scrape, share accounts, or bypass authentication. The skeletons exist to make compliance the user's explicit decision, not the server's default behaviour.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
