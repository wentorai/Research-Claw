# Research-Claw v0.1.0

> AI-powered local academic research assistant | 科研龙虾

First public release. Research-Claw runs entirely on your machine — no data leaves your device.

## One-Click Install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/wentorai/research-claw/main/scripts/install.sh | bash
```

Windows: [Manual Install Guide](WINDOWS_INSTALL.md) | Recommended: use WSL2

## What's Included

### Literature Management
- Local paper library with full-text search (SQLite + FTS5)
- 13 academic API integrations: Semantic Scholar, arXiv, OpenAlex, CrossRef, PubMed, Unpaywall
- BibTeX / RIS / CSV import and export
- Citation graph queries, reading session tracking, annotation notes
- Collections, tags, smart groups, duplicate detection

### Task Management
- Tasks with deadlines, priorities (urgent/high/medium/low), and status tracking
- Link tasks to papers, add timestamped notes
- Proactive deadline alerts (48h warning) and overdue notifications
- Cron presets for recurring tasks

### Research Radar
- Monitor keywords, authors, journals across arXiv and Semantic Scholar
- Dashboard visualization of new papers matching your interests
- Persistent configuration in database

### Workspace
- Git-tracked file operations within a sandboxed workspace
- File diff, history, and restore from past versions
- Path traversal protection for security

### Dashboard
- React 18 + Ant Design 5, dark cyberpunk theme
- 6 panels: Chat, Library, Tasks, Workspace, Radar, Settings
- 21 card types for structured information display
- Setup Wizard for first-run configuration
- Bilingual: English + 中文 (245 i18n keys)
- Responsive layout (desktop/tablet/overlay modes)
- Notification system with bell icon

### Skills Ecosystem
- 431 academic skills via `@wentorai/research-plugins`
- 6 agent tools for 6 academic databases
- 150 MCP configurations for external tool integration
- 6 curated skill lists by research category

## Architecture

Built as an [OpenClaw](https://openclaw.ai) satellite — uses OpenClaw as npm dependency, not a fork.

| Layer | What | Scope |
|-------|------|-------|
| L0 | Bootstrap files (SOUL, AGENTS, TOOLS, etc.) | Agent behavior |
| L1 | research-claw-core plugin | 28 tools, 52 RPC, 13 tables |
| L2 | Dashboard (React + Vite) | WebSocket RPC v3 |
| L3 | pnpm patch | ~20 lines branding |

- **Port**: 28789 (offset from OpenClaw 18789)
- **Database**: SQLite with WAL mode, 13 tables + FTS5
- **Tests**: 318+ unit tests, E2E test suite, zero TypeScript errors

## Requirements

- Node.js >= 22.12 (auto-installed by install script)
- macOS (Intel/Apple Silicon) or Linux (Ubuntu/Debian)
- An LLM API key (Anthropic Claude recommended, or OpenAI)

## License

[BSL 1.1](LICENSE) — Free for personal and academic research use.
Commercial use requires a separate license. Converts to Apache 2.0 on 2030-03-12.

## Links

- Website: https://wentor.ai
- User Guide: [Research-Claw-Guide.md](../Research-Claw-Guide.md)
- Windows Install: [WINDOWS_INSTALL.md](WINDOWS_INSTALL.md)
