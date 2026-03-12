<div align="center">

<img src="assets/logo.png" width="200" alt="Research-Claw" />

# Research-Claw · 科研龙虾

**Your local AI research assistant — data stays on your machine**

[![Version](https://img.shields.io/badge/version-v0.1.0-EF4444?style=flat-square&logo=github)](https://github.com/wentorai/Research-Claw/releases)
[![License](https://img.shields.io/badge/license-BSL_1.1-3B82F6?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux-lightgrey?style=flat-square)](#)
[![Skills](https://img.shields.io/badge/skills-487-EF4444?style=flat-square)](https://www.npmjs.com/package/@wentorai/research-plugins)

[🌐 wentor.ai](https://wentor.ai) · [🇨🇳 中文](README.md) · [📖 Docs](docs/00-reference-map.md) · [🪲 Issues](https://github.com/wentorai/Research-Claw/issues)

</div>

---

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

> **One command. Three modes: Install · Update · Start**
> First run: clone → install deps → build → register skills → open browser
> Subsequent runs: `git pull` → rebuild → restart (kills old process via `--force`)
>
> Windows → [Manual Install Guide](docs/WINDOWS_INSTALL.md) (WSL2 recommended)

---

## What is this?

Research-Claw is an AI-powered academic research assistant that runs entirely on your local machine. It connects to major academic databases, manages your literature library, tracks research tasks, and assists with writing — all driven by natural language conversation.

**Your papers, notes, and research data never leave your device. No account required. Works offline.**

---

## Capabilities

| Module | Features |
|:--|:--|
| **Literature** | Full-text search (SQLite + FTS5) · BibTeX / RIS / CSV import/export · Citation graph · Reading stats |
| **Search** | Semantic Scholar · arXiv · OpenAlex · CrossRef · PubMed · Unpaywall (13 APIs) |
| **Tasks** | Deadline tracking · 4-level priority · 48h deadline alerts · Task–paper linking |
| **Radar** | Keyword / author / journal monitoring · Scheduled scans · Dashboard feed |
| **Workspace** | Git-tracked file ops · Version history · Sandboxed path isolation |
| **Skills** | 487 academic skills · 13 agent tools · 150 MCP configurations |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Research-Claw                               │
│                                                                     │
│   L0  workspace/                  L2  dashboard/                    │
│       ├─ SOUL.md                      React 18 + Vite 6             │
│       ├─ AGENTS.md                    Ant Design 5 + Zustand 5      │
│       ├─ TOOLS.md                     21 card types · 6 panels      │
│       ├─ HEARTBEAT.md                 WebSocket RPC v3 client       │
│       └─ (8 bootstrap files)          245 i18n keys (EN + ZH-CN)    │
│                                             │                       │
│   L1  extensions/                           │ ws://127.0.0.1:28789  │
│       └─ research-claw-core                 │                       │
│          ├─ 28 tools                        │                       │
│          ├─ 52 WS RPC interfaces            │                       │
│          └─ 13 SQLite tables + FTS5         ▼                       │
│       ╔═══════════════════════════════════════════════════╗         │
│       ║           OpenClaw  (npm dependency)              ║         │
│       ║         Gateway · WS RPC v3 · Port 28789          ║         │
│       ╚═══════════════════════════════════════════════════╝         │
│                              │                                      │
│   L3  patches/               ▼                                      │
│       ~20 lines · 7 files    @wentorai/research-plugins             │
│                              487 skills · 13 tools · 150 MCP        │
└─────────────────────────────────────────────────────────────────────┘
```

### Design Decisions

| Decision | Rationale |
|:--|:--|
| **Satellite, not fork** | OpenClaw is an npm dependency — upstream upgrades are absorbed cleanly; coupling surface is ~20 lines of pnpm patch |
| **4-tier coupling** | L0 filesystem → L1 plugin SDK → L2 WS RPC → L3 patch; each tier is independently replaceable |
| **Local-first** | SQLite + WAL mode, no database server, fully functional offline |
| **Skills over raw prompts** | 487 SKILL.md files encode domain knowledge structurally; installable/removable per research field |
| **Port offset from upstream** | 28789 (Research-Claw) vs 18789 (OpenClaw default) — both can run simultaneously |
| **Browser-configured** | No config file editing needed; all settings via Setup Wizard at first launch |

### Security Model

Research-Claw uses four layers of defense-in-depth. The first three are hard constraints enforced in code:

```
┌──────────────────────────────────────────────┐
│  L1  Network Isolation                       │
│      loopback only · no remote port exposed  │
│      no telemetry · no cloud callbacks       │
├──────────────────────────────────────────────┤
│  L2  Workspace Sandbox                       │
│      native write/edit tools denied by config│
│      plugin writes = path-validated only     │
│      native read = unrestricted (papers/code)│
├──────────────────────────────────────────────┤
│  L3  Exec Guard  (before_tool_call hook)     │
│      block: rm -rf / · dd of=/dev/ · fork   │
│      allow: python · git · npm · single rm  │
├──────────────────────────────────────────────┤
│  L4  Git Versioning                          │
│      auto-commit all workspace changes       │
│      local only · no push · full rollback    │
├──────────────────────────────────────────────┤
│  L+  Prompt-level Protocol  (soft)           │
│      SOUL.md: no fabricated citations/data   │
│      AGENTS.md: irreversible ops need HiL    │
└──────────────────────────────────────────────┘
```

---

## Getting Started

### Requirements

- macOS (Intel / Apple Silicon) or Linux
- Git (auto-installed by script)
- Node.js >= 22 (auto-installed via fnm)
- An LLM API key (Anthropic Claude or OpenAI recommended)

### Install & Start

```bash
# Option 1: One-click (recommended)
curl -fsSL https://wentor.ai/install.sh | bash

# Option 2: Manual
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw
pnpm install && pnpm build
pnpm start
```

After install, your browser opens `http://127.0.0.1:28789`. Follow the **Setup Wizard** to configure your LLM provider and API key.

### Commands

```bash
pnpm start          # Start (no update)
pnpm dev            # Dev mode (Dashboard: localhost:5175)
pnpm test           # Run unit tests
pnpm health         # Health check
pnpm backup         # Backup database
```

### Update

```bash
# Re-run the install script — it will git pull and rebuild
curl -fsSL https://wentor.ai/install.sh | bash
```

---

## Project Structure

```
research-claw/
├── config/           # OpenClaw config overlay
│   ├── openclaw.example.json
│   └── openclaw.json          (gitignored)
├── dashboard/        # React + Vite Dashboard
│   └── src/
│       ├── components/        # TopBar, LeftNav, ChatView, panels, cards
│       ├── gateway/           # WS RPC v3 client + hooks
│       ├── i18n/              # en.json + zh-CN.json
│       ├── stores/            # Zustand stores × 7
│       └── types/             # 21 Card type definitions
├── extensions/
│   └── research-claw-core/    # 28 tools · 52 RPC · 13 tables
├── patches/                   # pnpm patch (~20 lines, 7 files)
├── scripts/                   # install / health / backup / sync
├── skills/                    # Custom SKILL.md files
└── workspace/                 # Bootstrap files (SOUL.md, AGENTS.md …)
```

---

## Community

<div align="center">

Join our community on Xiaohongshu (小红书)

<img src="assets/community-qr.jpg" width="260" alt="Xiaohongshu community QR" />

[wentor.ai](https://wentor.ai) · [GitHub Issues](https://github.com/wentorai/Research-Claw/issues)

</div>

---

## License

[BSL 1.1](LICENSE) — Free for personal and academic research use. Commercial use requires a separate license from [Wentor AI](https://wentor.ai) (team@wentor.ai). Converts to Apache 2.0 on 2030-03-12.

---

<div align="center">
<sub>Built with ❤️ by <a href="https://wentor.ai">Wentor AI</a></sub>
</div>
