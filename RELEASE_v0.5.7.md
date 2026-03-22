# Research-Claw v0.5.7

> Release date: 2026-03-22

## Highlights

**OpenClaw 2026.3.13 升级** + Dashboard↔OC 协议全面对齐 + 服务端分页 + 性能优化

## Features

### OpenClaw v2026.3.8 → v2026.3.13 Upgrade
- 1183 commits upstream, patch updated for new dist chunk filenames
- Node requirement: >=22.16.0
- New scopes: `operator.admin`, `operator.approvals`, `operator.pairing`

### Dashboard↔OC Protocol Alignment (9 issues)
- **Scopes** — `[admin, approvals, pairing]` replaces legacy `[read, write, admin]`
- **Tool stream session filter** — drop cron/monitor events from other sessions
- **Cron reconcile** — auto re-register presets after gateway restart
- **Hello snapshot** — parse `sessionDefaults` (agentId, mainKey)
- **sessions.delete** — add `deleteTranscript: true` to clean orphaned transcripts
- **sessions.subscribe** — subscribe to session changes (graceful fallback for pre-release OC)
- **Device auth normalization** — align with OC's `normalizeDeviceMetadataForAuth()` (trim + toLowerAscii)
- **Session key utility** — extract shared `utils/session-key.ts`, used by chat/sessions/tool-stream
- **deliver: false** — prevent dashboard chat responses from broadcasting to external channels

### Literature Library Server-Side Pagination
- `rc.lit.list` now accepts `read_status` array filter (SQL `IN` clause)
- Dashboard sends tab-specific filters: Inbox `['unread','reading']`, Archive `['read','reviewed']`
- PAGE_SIZE=30, "Load more" pattern, eliminates client-side filtering
- Tab switch clears papers and triggers server reload

### Tasks Pagination
- PAGE_SIZE=50, cursor-based `offset/limit` with "Load more" button
- Perspective/completion toggle resets pagination state

### Workspace Git Performance
- Batch `git status --porcelain` → single command replaces N per-file calls
- 5s TTL status cache with proper invalidation on commits/restores/mutations
- Fix: rename path parsing took orig instead of new path (porcelain v1)
- Fix: strip git's quote wrapping for CJK/space paths

### Ollama Setup UX (SetupWizard)
- Auto-detect local models via `GET /api/tags`
- Model dropdown shows discovered models with parameter sizes
- API key field hidden for local providers (ollama, vllm)
- Base URL hint for Ollama users

### Startup Banner
- ASCII art banner for `run.sh` and `docker-entrypoint.sh`
- Version, gateway URL, dashboard URL displayed on boot

### Shared Config Cleanup (`ensure-config.cjs`)
- Extracted from 3 entrypoints (run.sh, install.sh, docker-entrypoint.sh)
- Idempotent: plugins.allow, discovery.mdns/wideArea off, stale cleanup, auth token alignment
- Atomic writes (tmp + rename) to prevent corruption

## Fixes

- **ErrorBoundary** — retry now increments React key, forcing full child remount (useEffect re-fires)
- **Data limits** — monitor 500 (was 100), sessions 1000, chat history 500
- **Reconnection** — always schedule reconnect on abnormal close (was stuck on "disconnected" on first connect failure)
- **Non-recoverable error** — extracted `isNonRecoverableError()`, sets `intentionalClose` to prevent reconnect race
- **Global empty state** — only shows on inbox tab (was showing on archive/starred incorrectly)
- **README** — added OC coexistence section (restore original OpenClaw guide)
- **PID lock** — `run.sh` prevents multiple instances from SIGTERM fighting

## Prompt

- AGENTS.md v3.5 — simplified Zotero bridge section, delegated details to research-sop
- TOOLS.md v3.3 — corrected sort parameter documentation for PubMed/Europe PMC/INSPIRE/Zenodo/HAL

## Stats
- Dashboard: 1084 tests (58 files), +13 new
- Plugin: 41 tools, 81 RPC, singleton init guard (prevents double-register resource leaks)
- OpenClaw: 2026.3.13, pnpm patch (dual agent-scope + branding)

## Upgrade
```bash
# Native
curl -fsSL https://wentor.ai/install.sh | bash

# Docker
docker pull ghcr.io/wentorai/research-claw:0.5.7
# or re-run:
curl -fsSL https://wentor.ai/docker-install.sh | bash

# Windows (PowerShell)
irm https://wentor.ai/docker-install.ps1 | iex
```

## Links
- Website: https://wentor.ai
- GitHub: https://github.com/wentorai/Research-Claw
- Research Plugins: https://www.npmjs.com/package/@wentorai/research-plugins
- Previous: [RELEASE_v0.5.6.md](RELEASE_v0.5.6.md)
