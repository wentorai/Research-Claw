# Research-Claw v0.5.5

> Release date: 2026-03-19

## What's New

### OAuth Smart Modal
- Dashboard-initiated OAuth flow for OpenAI Codex (ChatGPT subscription)
- 3-step modal: authenticate → paste redirect URL → done
- Proxy-aware token exchange via CONNECT tunnel (works behind VPN/firewall)
- No CLI required — works in Docker, native, WSL2
- Plugin RPC: `rc.oauth.initiate`, `rc.oauth.complete`, `rc.oauth.status`

### MiniMax Coding Plan Support (PR #13 by @J47erry)
- `sk-cp-*` token auto-detection with local Bearer proxy (port 28790)
- OpenAI Codex provider preset + Dashboard UX (API key disabled for OAuth providers)
- `env.vars.RC_MINIMAX_UPSTREAM_BASEURL` for OC 2026.3.8 config compatibility

### Cron Session Fix (#14 by @J47erry)
- Stable `sessionKey` per preset (`cron:rc-preset:{presetId}`)
- Sessions no longer duplicate on gateway restart
- Auto-label + session reaper still work (key prefixed with `cron:`)

### install.sh Hardening
- SSH auto-detect: `gateway.bind=lan` for PVE CT / cloud VMs / headless servers
- `BIND` env var override (`BIND=loopback` or `BIND=lan`)
- Corepack keyid fallback: standalone pnpm when Corepack shim is broken (PR #12 by @KevinAdams1)
- Dynamic `DASHBOARD_URL` — shows correct IP for remote access
- `pnpm_cmd_works()` functional test replaces `command -v` existence check

### Dashboard P1 UX
- Live tool activity stream (ToolActivityStream component)
- Background activity bar (AgentActivityBar)
- Message copy: raw source with thinking + markdown
- Notification hover expand
- Session-isolated draft persistence
- Refresh chat button
- Paper search CJK dedup + browser reliability (PR #15)

## Stats
- Dashboard: 1023 tests passing (54 files)
- Plugin: 38 tools, 81 RPC methods, 8 hooks
- DB Schema: v7
- Docker: multi-arch (amd64 + arm64)

## Contributors
- @J47erry — OpenAI Codex OAuth preset, MiniMax proxy, cron session issue
- @KevinAdams1 — Corepack keyid fix

## Upgrade
```bash
# Native
curl -fsSL https://wentor.ai/install.sh | bash

# Docker
docker pull ghcr.io/wentorai/research-claw:0.5.5
# or re-run:
curl -fsSL https://wentor.ai/docker-install.sh | bash

# Windows (PowerShell)
irm https://wentor.ai/docker-install.ps1 | iex
```
