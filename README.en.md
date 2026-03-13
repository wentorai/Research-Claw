<div align="center">

<img src="assets/logo.png" width="200" alt="Research-Claw · 科研龙虾" />

# Research-Claw · 科研龙虾

**In the AI era, why can't everyone be a PI?**

You define the question. Research-Claw runs the lab. 24/7 on your machine. Every output, yours alone.

[![Version](https://img.shields.io/badge/version-v0.1.0-EF4444?style=flat-square&logo=github)](https://github.com/wentorai/Research-Claw/releases)
[![License](https://img.shields.io/badge/license-BSL_1.1-3B82F6?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Linux_%7C_Windows-lightgrey?style=flat-square)](#)
[![Skills](https://img.shields.io/badge/skills-487-EF4444?style=flat-square)](https://www.npmjs.com/package/@wentorai/research-plugins)

[🌐 wentor.ai](https://wentor.ai) · [🇨🇳 中文](README.md) · [📖 Docs](docs/00-reference-map.md) · [🪲 Issues](https://github.com/wentorai/Research-Claw/issues)

</div>

---

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

> **One command: Install · Update · Restart**
> Windows → [Docker deploy](#docker-windows-recommended) (recommended) or [WSL2 manual install](docs/WINDOWS_INSTALL.md)

---

## What is this?

The researchers who will define the next century shouldn't be spending this one formatting bibliographies. A graduate student working alone at 2 a.m. deserves the same research infrastructure as a fully funded lab.

Research-Claw runs entirely on your local machine. It reads papers so you don't have to skim. It monitors arXiv while you sleep. It drafts methodology sections, designs experiments, manages citations, generates figures, and writes in your voice — not its own.

**Your papers, notes, and research data never leave your device. No account required. Works offline. No cloud services to trust.**

---

## Six Scenarios

### Your Zotero Library, AI-Managed

> You: My Zotero "Unfiled" has 200+ papers. Sort by topic, add a one-line summary to each.
> Claw: Read 217 papers, clustering… Suggest 6 groups: LLM Reasoning (43) · Agent (38) · RAG (31) · Multimodal (28) · Eval (19) · Others (58). OK?
> You: Yes, split Others if any sub-topic has 10+ papers.
> Claw: ✓ Sorted into 8 Collections · Summaries added · Synced to Zotero

Bidirectional Zotero / EndNote sync: auto-classify, annotate, export BibTeX — all through conversation.

<img src="assets/screenshots/zotero-import.jpg" alt="Zotero import in action" width="100%" />

---

### Weekly Meeting Slides, Automated

Every Friday at 8 AM, Research-Claw compiles your week's progress into presentation materials and delivers them to your **Telegram / Feishu / QQ / DingTalk**. They're waiting when you wake up.

---

### Paper Writing: From Blank Page to Draft

> You: Write "Multi-Agent Debate for Factual Reasoning" — outline first, then Related Work.
> Claw: Generated from proposal + experiment notes: 1. Intro · 2. Related Work · 3. Method · 4. Experiments · 5. Conclusion. OK?
> You: Change 2.3 to "Multi-Agent Collaboration & Consensus"
> Claw: ✓ Related Work done (2,800 words · 47 citations) · Saved to ~/research/paper/02_related.md · BibTeX synced to references.bib

---

### 24/7 Research Radar × IM Alerts

Configure keyword, author, and journal tracking. Research-Claw continuously scans arXiv and Semantic Scholar. Important updates are pushed to your **Telegram / Feishu / QQ / DingTalk** — you won't miss anything, even away from your desk.

<img src="assets/screenshots/telegram.jpg" alt="Telegram connected × Research Radar" width="100%" />

---

### Email: Say It, Send It

> You: Email Yann LeCun — we're replicating his XXX paper, hit a problem, want to ask… keep it formal but not stiff.
> Claw: [Draft ready, confirm to send]

Draft, confirm, send — all inside the conversation. Tone adjustable on the fly.

---

### Local GPU, Auto-Reproduce Papers

> You: Run the experiments from arxiv:2406.12345
> Claw: Cloning repo, setting up conda env… CUDA version mismatch, switching automatically, retrying… ✓ Done, results saved to results/

Hits a wall? It debugs itself. Still stuck? It emails the authors.

---

## Dashboard

Most local AI agents give you a chat box and a few buttons. Research-Claw doesn't.

We built a purpose-designed Dashboard for academic workflows — the most complete interface of any local research AI. Supports both warm Paper theme and dark Terminal theme.

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/library.jpg" alt="Library panel" /></td>
    <td width="50%"><img src="assets/screenshots/tasks.jpg" alt="Task management panel" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Library — search, cite, open PDF</sub></td>
    <td align="center"><sub>Tasks — Agent / Human task layers, deadlines</sub></td>
  </tr>
</table>

| Panel | Features |
|:--|:--|
| **Chat** | Conversation interface with 21 structured card types — no more walls of text |
| **Library** | Full-text search · Tags · Annotations · Citation graph · Reading stats |
| **Tasks** | Agent / Human task layers · 4-level priority · 48h deadline alerts |
| **Workspace** | File ops with version history, every change Git-tracked |
| **Radar** | Keyword / author / journal tracking · Automation tasks · IM push |
| **Settings** | Setup Wizard · All config in the browser, no file editing needed |

Tech: React 18 + Vite 6 + Ant Design 5 + Zustand 5 · Bilingual EN/ZH-CN (245 i18n keys) · 318+ unit tests · TypeScript zero errors · Responsive desktop / tablet / overlay layout.

---

## Skills & Integrations

```bash
openclaw plugins install @wentorai/research-plugins
```

One command to install **487 academic skills** covering the full research workflow:

| Category | Count | Capabilities |
|:--|:--|:--|
| Literature | 87 | Multi-database search · Full-text retrieval · Tracking |
| Methodology | 79 | DID · RDD · IV · Meta-analysis · Systematic review |
| Data Analysis | 68 | Python · R · STATA · Visualization · Panel data |
| Writing | 74 | Paper sections · LaTeX · Rebuttal generation |
| Domains | 93 | 16 disciplines: CS to Law to Biology |
| Tools | 51 | Terminal · Jupyter · Document processing |
| Integrations | 35 | Zotero · GitHub · Slack · arXiv |

**13 Agent tools** connecting directly to academic databases: Semantic Scholar · arXiv · OpenAlex · CrossRef · PubMed · Unpaywall

**150 MCP configurations** plug-and-play:
- **Reference managers**: Zotero · EndNote · Mendeley
- **IM push**: Telegram · Feishu · QQ · DingTalk · Slack (get research alerts in your preferred IM)
- **Dev tools**: GitHub · Jupyter · VSCode
- **AI services**: OpenAI · Claude · domestic Chinese model APIs

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
| **Satellite, not fork** | OpenClaw as npm dependency — upstream upgrades are absorbed cleanly; coupling surface is ~20 lines of pnpm patch |
| **4-tier coupling** | L0 filesystem → L1 plugin SDK → L2 WS RPC → L3 patch; each tier is independently replaceable |
| **Local-first** | SQLite + WAL mode, no database server, fully functional offline |
| **Skills over raw prompts** | 487 SKILL.md files encode domain knowledge structurally; installable/removable per research field |
| **Port offset from upstream** | 28789 (Research-Claw) vs 18789 (OpenClaw default) — both can run simultaneously |
| **Browser-configured** | No config file editing; all settings via Setup Wizard at first launch |

### Security Model

Four layers of defense-in-depth. The first three are hard constraints enforced in code:

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
│      block: rm -rf / · dd of=/dev/ · fork    │
│      allow: python · git · npm · single rm   │
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

| Platform | Method | Prerequisites |
|:--|:--|:--|
| macOS / Linux | One-click script | Git · Node.js 22 (auto-installed) |
| Windows | Docker Desktop | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Windows | WSL2 manual | WSL2 Ubuntu · Git · Node.js 22 |

All platforms require an LLM API key (Anthropic Claude / OpenAI recommended).

### Install

```bash
# Option 1: One-click (macOS / Linux, recommended)
curl -fsSL https://wentor.ai/install.sh | bash

# Option 2: Manual
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw
pnpm install && pnpm build
pnpm start
```

After install, your browser opens `http://127.0.0.1:28789`. Follow the **Setup Wizard** to configure your LLM provider and API key — no config file editing needed.

### Docker (Windows recommended)

No WSL2 or Node.js required — just [Docker Desktop](https://www.docker.com/products/docker-desktop/). Also works on macOS / Linux.

**Option A: Build locally** (recommended for China mainland users)

```bash
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw
docker compose up -d --build
```

> The Dockerfile uses Chinese mirrors (TUNA apt + npmmirror) by default. If you need a proxy for GitHub, uncomment the `HTTP_PROXY` lines in `docker-compose.yml`.

**Option B: Pull pre-built image** (fast outside China)

```bash
docker pull ghcr.io/wentorai/research-claw:latest

docker run -d --name research-claw \
  -p 28789:28789 \
  -v rc-config:/app/config \
  -v rc-data:/root/.research-claw \
  -v rc-workspace:/app/workspace \
  ghcr.io/wentorai/research-claw:latest
```

Visit `http://127.0.0.1:28789` → Setup Wizard → enter your API key.

> **Persistence**: database, config, and workspace are stored in named volumes — data survives container restarts and removal.
>
> **Proxy**: If your LLM API (e.g. OpenAI) requires a proxy, uncomment the `environment` section in `docker-compose.yml` and set your proxy address (`host.docker.internal` routes to the host machine).

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
curl -fsSL https://wentor.ai/install.sh | bash
```

---

## Project Structure

```
research-claw/
├── config/           # OpenClaw config overlay
├── dashboard/        # React + Vite Dashboard
│   └── src/
│       ├── components/   # TopBar, LeftNav, ChatView, panels, cards
│       ├── gateway/      # WS RPC v3 client + hooks
│       ├── i18n/         # en.json + zh-CN.json
│       ├── stores/       # Zustand stores × 7
│       └── types/        # 21 Card type definitions
├── extensions/
│   └── research-claw-core/   # 28 tools · 52 RPC · 13 tables
├── patches/          # pnpm patch (~20 lines, 7 files)
├── scripts/          # install / health / backup / sync
├── skills/           # Custom SKILL.md files
└── workspace/        # Bootstrap files (SOUL.md, AGENTS.md …)
```

---

## Community

<div align="center">

Join our community on Xiaohongshu (小红书)

<img src="assets/community-qr.jpg" width="260" alt="Xiaohongshu community QR code" />

[wentor.ai](https://wentor.ai) · [GitHub Issues](https://github.com/wentorai/Research-Claw/issues)

</div>

---

## License

[BSL 1.1](LICENSE) — Free for personal and academic research use. Commercial use requires a separate license from [Wentor AI](https://wentor.ai) (help@wentor.ai). Converts to Apache 2.0 on 2030-03-12.

---

<div align="center">
<sub>Built with ❤️ by <a href="https://wentor.ai">Wentor AI</a></sub>
</div>
