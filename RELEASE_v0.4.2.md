# Research-Claw v0.4.2

> AI-powered local academic research assistant | 科研龙虾

## What's New

### Dashboard — UX Fixes

- **Logo link**: TopBar logo now clickable — opens wentor.ai in a new tab (`target="_blank"`, `rel="noopener noreferrer"`)
- **Session divider**: Project switcher dropdown uses Ant Design native `type: 'divider'` instead of a manual `<div>` (eliminates hover/click artifacts)
- **Main session persistence**: `loadSessions` always injects the main session into the list if the gateway omits it, ensuring "Main Session" is never missing from the dropdown
- **Session auto-naming**: New sessions get an auto-incremented label "Session N" (bilingual regex handles both "Session" and "项目"), persisted to the gateway via `sessions.patch` RPC so it survives refresh

### Code Quality

- **Pure-function loadSessions**: Replaced in-place `serverSessions.unshift()` with immutable spread `[{ key: MAIN_SESSION_KEY }, ...serverSessions]`
- **1061 tests** across 55 test files — 7 test cases updated to match new session behavior

## Upgrade

```bash
# macOS / Linux — run or re-run the install script
curl -fsSL https://wentor.ai/install.sh | bash

# Docker — pull the latest image
docker pull ghcr.io/wentorai/research-claw:0.4.2
```

Existing installations: re-run the install script. It detects and upgrades in-place.

## Links

- Website: https://wentor.ai
- GitHub: https://github.com/wentorai/Research-Claw
- Research Plugins: https://www.npmjs.com/package/@wentorai/research-plugins
- Previous: [RELEASE_v0.3.0.md](RELEASE_v0.3.0.md)
