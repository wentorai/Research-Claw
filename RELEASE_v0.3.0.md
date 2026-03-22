# Research-Claw v0.3.0

> AI-powered local academic research assistant | 科研龙虾

## What's New

### Dashboard — Bug Fixes & UX Improvements

- **Library tag sync**: Tags refresh automatically when papers are deleted; counts stay accurate
- **Tag filter UX**: Filtering by tag no longer shows a false "no papers" empty state; a "Clear filter" button appears instead
- **Library empty state**: Guidance text updated — no longer references non-existent drag-to-add PDF
- **Workspace upload**: Removed redundant header upload button; file tree auto-refreshes after upload with retry for gateway indexing delay
- **Radar guidance**: "No findings" text now points users to the Refresh button
- **Settings save confirmation**: A confirmation dialog warns about gateway restart before saving settings
- **Library tag clear-all**: Bulk tag removal now works correctly across multi-tagged papers

### Dashboard — 16 GAP Implementations

New features implemented across 4 modules (Library, Tasks, Workspace, Radar):

- **Library**: Paper detail expand, tag management panel, export citations, bulk delete, collection support
- **Tasks**: Task detail expand with subtask tree, inline status editing, cron scheduler presets, `send_notification` tool
- **Workspace**: File preview panel, directory tree navigation, upload progress, workspace stats
- **Radar**: Finding detail cards, source tracking, refresh scheduling, finding archival

### Testing Infrastructure

- **1029 tests** across 52 test files (up from 318 tests / 28 files in v0.2.0)
- 13 gateway parity tests validating protocol frame handling against real OpenClaw payloads
- 7 fixture files capturing production gateway data shapes
- Bootstrap consistency test verifying TOOLS.md ↔ code alignment

### Plugin System

- **send_notification bug fix**: Config whitelist now correctly includes `send_notification` tool — previously blocked by OpenClaw's config-sentinel
- **better-sqlite3 native module fix**: Resolved `MODULE_NOT_FOUND` crash on first launch by ensuring native bindings rebuild during install
- **Tool count**: 28 local tools (12 library + 7 tasks incl. send_notification + 6 workspace + 3 radar) + 13 API tools = **41 registered tools**

### Progressive Skill Disclosure (research-plugins v1.3.1)

- **skill-router removed**: Routing now handled by 40 subcategory index SKILL.md files + OpenClaw's native `## Skills (mandatory)` section
- **2-step loading**: 6 category paths → 40 indexes → 431 concrete skills
- **Priority rules merged** into research-sop local skill for unified prompt governance

### Install Script v2.0

- Automatic OpenClaw detection and platform-appropriate install guidance
- Delete-old-install-new plugin update pattern (`rm -rf` → `openclaw plugins install`)
- Version comparison with upgrade messaging
- macOS + Windows (Docker) support

### Infrastructure

- Version bumped from v0.2.0 to v0.3.0 across all packages, plugins, bootstrap files, i18n, and documentation (18 locations)
- Dockerfile updated: skill/tool count comment now reflects `431 skills + 40 indexes + 13 agent tools`

## Upgrade

```bash
# macOS / Linux — run or re-run the install script
curl -fsSL https://wentor.ai/install.sh | bash

# Docker — pull the latest image
docker pull ghcr.io/wentorai/research-claw:v0.3.0
```

Existing installations: re-run the install script. It detects and upgrades in-place.

## Full Changelog

See [docs/CHANGELOG.md](docs/CHANGELOG.md) for the operation log.

## Links

- Website: https://wentor.ai
- GitHub: https://github.com/wentorai/Research-Claw
- Research Plugins: https://www.npmjs.com/package/@wentorai/research-plugins
- v0.2.0 Release Notes: [RELEASE_v0.2.0.md](RELEASE_v0.2.0.md)
