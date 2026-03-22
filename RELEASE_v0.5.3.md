# Research-Claw v0.5.3

> AI-powered local academic research assistant | 科研龙虾

## What's New

### Monitor v2 Cleanup

- Remove phantom `monitor_scan` references from codebase
- Fix duplicate fingerprint inflation bug in monitor dedup logic
- Complete radar → monitor terminology migration across all code and docs

### Semantic Scholar Removal

- Fully remove Semantic Scholar integration (was returning 429 without API key)
- Clean references from code, documentation, config templates, and tool whitelist

### Docker Improvements

- Parameterized `APT_MIRROR` / `NPM_REGISTRY` build args — supports both China mainland (TUNA/npmmirror default) and overseas (`--build-arg APT_MIRROR=deb.debian.org`)
- Fix volume mount path: `/root/.research-claw` → `/app/.research-claw` (consistent with plugin dbPath)
- Docker Compose now references `ghcr.io/wentorai/research-claw:latest`
- Improved healthcheck (explicit `127.0.0.1:28789`)
- One-time migration in entrypoint for users upgrading from older volume mounts

### Plugin Management

- Whitelist all 34 research-plugins API tools in config template
- Stale tool cleanup in docker-entrypoint: removes legacy `search_papers`, `radar_*` tools on startup

### Dashboard UX

- Cache-bust theme mechanism for reliable dark/light switching
- DockerFileModal: graceful degradation for file operations in Docker environment
- File/folder download support (tar.gz archive)
- Multi-file upload support

## Stats

- 39 local tools + 34 API tools = **73 registered tools**
- Dashboard: 54 test files, **1020 tests passing**
- DB schema v10

## Upgrade

```bash
# macOS / Linux — run or re-run the install script
curl -fsSL https://wentor.ai/install.sh | bash

# Docker — pull the latest image
docker pull ghcr.io/wentorai/research-claw:0.5.3
```

Existing installations: re-run the install script. It detects and upgrades in-place.
User data files (USER.md, MEMORY.md) are automatically preserved during upgrade.

## Links

- Website: https://wentor.ai
- GitHub: https://github.com/wentorai/Research-Claw
- Research Plugins: https://www.npmjs.com/package/@wentorai/research-plugins
- Previous: [RELEASE_v0.5.1.md](RELEASE_v0.5.1.md)
