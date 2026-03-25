<div align="center">

<img src="assets/logo.png" width="200" alt="Research-Claw · 科研龙虾" />

# Research-Claw · 科研龙虾

**In the AI era, why can't everyone be a PI?**

You define the question. Research-Claw runs the lab. 24/7 on your machine. Every output, yours alone.

[![Version](https://img.shields.io/badge/version-v0.5.10-EF4444?style=flat-square&logo=github)](https://github.com/wentorai/Research-Claw/releases)
[![License](https://img.shields.io/badge/license-BSL_1.1-3B82F6?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS_%7C_Windows-lightgrey?style=flat-square)](#)
[![Skills](https://img.shields.io/badge/skills-438-EF4444?style=flat-square)](https://www.npmjs.com/package/@wentorai/research-plugins)

[🌐 wentor.ai](https://wentor.ai) · [🇨🇳 中文](README.md) · [📖 Docs](docs/00-reference-map.md) · [🪲 Issues](https://github.com/wentorai/Research-Claw/issues)

</div>

---

> Windows → [Docker One-Click Deploy](#docker-one-click-macos--linux--windows) (recommended) or [WSL2 manual install](WINDOWS_INSTALL.md)

---

> macOS and Linux (Ubuntu) only:
>
> **One command: Install · Update · Restart**

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```



---

## What is this?

The researchers who will define the next century shouldn't be spending this one formatting bibliographies. A graduate student working alone at 2 a.m. deserves the same research infrastructure as a fully funded lab.

Research-Claw runs entirely on your local machine. It reads papers so you don't have to skim. It monitors arXiv while you sleep. It drafts methodology sections, designs experiments, manages citations, generates figures, and writes in your voice — not its own.

**Your papers, notes, and research data stay on your machine. The only external dependency is the LLM API you choose.**

<div align="center">

Join our **Research-Claw · WentorOS** WeChat group

<img src="assets/community-qr.jpg" width="260" alt="WeChat community QR code" />

</div>

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

Configure keyword, author, and journal tracking. Research-Claw continuously scans arXiv, OpenAlex, and other academic databases. Important updates are pushed to your **Telegram / Feishu / QQ / DingTalk** — you won't miss anything, even away from your desk.

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
| **Monitor** | Keyword / author / journal tracking · Automation tasks · IM push |
| **Settings** | Setup Wizard · All config in the browser, no file editing needed |

Tech: React 18 + Vite 6 + Ant Design 5 + Zustand 5 · Bilingual EN/ZH-CN (469 i18n keys) · 1084 unit tests · TypeScript zero errors · Responsive desktop / tablet / overlay layout.

---

## Skills & Integrations

Research-Claw comes with **438 academic skills** built-in (auto-configured during install — no manual setup needed), covering the full research workflow:

| Category | Count | Capabilities |
|:--|:--|:--|
| Literature | 87 | Multi-database search · Full-text retrieval · Tracking |
| Methodology | 79 | DID · RDD · IV · Meta-analysis · Systematic review |
| Data Analysis | 68 | Python · R · STATA · Visualization · Panel data |
| Writing | 74 | Paper sections · LaTeX · Rebuttal generation |
| Domains | 93 | 16 disciplines: CS to Law to Biology |
| Tools | 51 | Terminal · Jupyter · Document processing |
| Integrations | 35 | Zotero · GitHub · Slack · arXiv |

**34 Agent tools** connecting directly to academic databases: arXiv · OpenAlex · CrossRef · PubMed · Unpaywall · Europe PMC · DBLP · DOAJ and more

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
│       └─ (8 bootstrap files)          469 i18n keys (EN + ZH-CN)    │
│                                             │                       │
│   L1  extensions/                           │ ws://127.0.0.1:28789  │
│       └─ research-claw-core                 │                       │
│          ├─ 38 tools                        │                       │
│          ├─ 79 WS RPC interfaces            │                       │
│          └─ 16 SQLite tables + FTS5         ▼                       │
│       ╔═══════════════════════════════════════════════════╗         │
│       ║           OpenClaw  (npm dependency)              ║         │
│       ║         Gateway · WS RPC v3 · Port 28789          ║         │
│       ╚═══════════════════════════════════════════════════╝         │
│                              │                                      │
│   L3  patches/               ▼                                      │
│       ~20 lines · 7 files    @wentorai/research-plugins             │
│                              438 skills · 34 tools        │
└─────────────────────────────────────────────────────────────────────┘
```

### Design Decisions

| Decision | Rationale |
|:--|:--|
| **Satellite, not fork** | OpenClaw as bundled npm dependency (no separate install needed) — upstream upgrades are absorbed cleanly; coupling surface is ~20 lines of pnpm patch |
| **4-tier coupling** | L0 filesystem → L1 plugin SDK → L2 WS RPC → L3 patch; each tier is independently replaceable |
| **Local-first** | SQLite + WAL mode, no database server; all data stays local, only external dependency is the LLM API |
| **Skills over raw prompts** | 438 SKILL.md files encode domain knowledge structurally; installable/removable per research field |
| **Port offset from upstream** | 28789 (Research-Claw) vs 18789 (OpenClaw default) — both can run simultaneously |
| **Browser-configured** | No config file editing; all settings via Setup Wizard at first launch |

### Security Model

Four layers of defense-in-depth. The first three are hard constraints enforced in code:

```
┌──────────────────────────────────────────────
│  L1  Network Isolation
│      loopback only · no remote port exposed
│      no telemetry · no cloud callbacks
├──────────────────────────────────────────────
│  L2  Workspace Sandbox
│      native write/edit tools denied by config
│      plugin writes = path-validated only (rejects ../)
│      native read = unrestricted (papers/code)
├──────────────────────────────────────────────
│  L3  Exec Guard  (before_tool_call hook)
│      block: rm -rf / · dd of=/dev/ · fork bomb
│      allow: python · git · npm · single-file rm
├──────────────────────────────────────────────
│  L4  Git Versioning
│      auto-commit all workspace changes (5s debounce)
│      local only · no push · full history rollback
├──────────────────────────────────────────────
│  L+  Prompt-level Protocol  (soft)
│      SOUL.md: no fabricated citations/data
│      AGENTS.md: irreversible ops need Human-in-Loop
└──────────────────────────────────────────────
```

---

## Getting Started

### Requirements

| Platform | Method | Prerequisites |
|:--|:--|:--|
| macOS / Linux | One-click script (recommended) | Git · Node.js 22 (auto-installed) |
| macOS / Linux | Manual install (source) | Git · Node.js 22+ · [pnpm](https://pnpm.io/installation) 9 |
| macOS / Linux / Windows | Docker one-click | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |

All platforms require an LLM API key (Anthropic Claude / OpenAI recommended).

> **You do NOT need to install OpenClaw separately.** Research-Claw bundles OpenClaw and all academic skill plugins — the install script / Docker handles everything automatically. If you already have a standalone OpenClaw installation, you can install just the skills plugin: `openclaw plugins install @wentorai/research-plugins`, but a full install is recommended for the Dashboard and complete feature set.

### Install

**macOS / Linux — source one-click (recommended):**

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

#### Docker one-click (macOS / Linux / Windows)

Install [Docker Desktop](https://docs.docker.com/desktop/) first, make sure it shows Running, then:

```bash
# macOS / Linux
curl -fsSL https://wentor.ai/docker-install.sh | bash
```

```powershell
# Windows PowerShell
irm https://wentor.ai/docker-install.ps1 | iex
```

> The script automatically: checks Docker → stops/removes old container → pulls latest image → starts → opens browser.
> Re-run anytime to update. Data persists in Docker named volumes.

After install, the browser opens `http://127.0.0.1:28789` automatically. Follow the **Setup Wizard** to configure your API key — no config file editing needed.

<details>
<summary><b>Manual install / China network / Troubleshooting</b></summary>

#### Manual install (source)

> Requires Git, Node.js 22+, and [pnpm](https://pnpm.io/installation) 9. The one-click script installs these automatically; for manual install you need them pre-installed.

```bash
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw          # ⚠️ You must be inside the project directory, or pnpm install will fail
pnpm install && pnpm build
cp config/openclaw.example.json config/openclaw.json
pnpm serve
```

#### Local Docker build (China mainland alternative)

GHCR (`ghcr.io`) is blocked in mainland China. Build from source instead — the Dockerfile uses Chinese mirrors (TUNA apt + npmmirror):

```bash
git clone https://github.com/wentorai/Research-Claw.git
cd Research-Claw
docker compose up -d --build
```

Or configure a proxy in Docker Desktop → Settings → Resources → Proxies, then use the one-click script.

#### Can't connect?

1. **Verify port**: `curl http://127.0.0.1:28789/healthz` — returns `{"ok":true}` if working
2. **Use `127.0.0.1`**: On Windows, `localhost` may resolve to IPv6, causing failures
3. **Check Docker**: Confirm Docker Desktop shows Running, container is green
4. **Restart**: `docker restart research-claw`

#### Docker details

> **Token auth**: Docker uses token auth (browser device-pairing is not available inside containers). The default token `research-claw` is built into the Dashboard — just visit `http://127.0.0.1:28789/`, no token in the URL needed. To customize the token, remove the old container and start manually:
> ```bash
> docker stop research-claw && docker rm research-claw
> docker run -d --name research-claw -p 127.0.0.1:28789:28789 \
>   -e OPENCLAW_GATEWAY_TOKEN=your-token \
>   -v rc-config:/app/config -v rc-data:/app/.research-claw -v rc-workspace:/app/workspace -v rc-state:/root/.openclaw \
>   ghcr.io/wentorai/research-claw:latest
> ```
>
> **Persistence**: Config, database, workspace in named volumes (`rc-config`, `rc-data`, `rc-workspace`) — survives container removal.
>
> **Proxy for LLM API**: If your LLM API (e.g. OpenAI) requires a proxy, configure it in Docker Desktop → Settings → Resources → Proxies. Local-build users can also uncomment `HTTP_PROXY` / `HTTPS_PROXY` in `docker-compose.yml`.

</details>

### Commands

```bash
pnpm serve          # Start (auto-restart on config change)
pnpm start          # Single run (no auto-restart)
pnpm dev            # Dev mode (Dashboard: localhost:5175)
pnpm test           # Run unit tests
pnpm health         # Health check
pnpm backup         # Backup database
```

> `pnpm serve` is the recommended way to run. When you change API key / model in the browser, the gateway restarts automatically — no manual intervention needed.

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

## Uninstall

### Existing OpenClaw Users: Restoring Original OpenClaw

If you notice any of these issues after installing Research-Claw, the install script's global settings are affecting your existing OpenClaw:

- `openclaw` command launches Research-Claw instead of original OpenClaw
- Port is locked to 28789, preventing original OpenClaw from starting
- `openclaw config` reads/writes Research-Claw's config instead of `~/.openclaw/openclaw.json`

**Fix** (two steps — no need to uninstall Research-Claw):

```bash
# 1. Remove the CLI wrapper (the install script created a launcher at ~/.local/bin/ pointing to Research-Claw)
rm -f ~/.local/bin/openclaw

# 2. Remove the environment variable override from your shell config
#    Check which files were modified:
grep -n "OPENCLAW_CONFIG_PATH\|# Research-Claw\|\.local/bin.*Research-Claw" ~/.zshrc ~/.bashrc ~/.bash_profile 2>/dev/null
#    Find the lines with "Research-Claw" comments and delete them.
```

After cleanup, **open a new terminal** — the `openclaw` command will resolve to your original installation. Research-Claw is unaffected — launch it via `cd ~/research-claw && pnpm serve`; `run.sh` sets the correct config path internally. Both can coexist.

> **Why does this conflict happen?** The install script creates a wrapper at `~/.local/bin/openclaw` and writes `OPENCLAW_CONFIG_PATH` to your shell profile, so that `openclaw` commands in any terminal point to Research-Claw's config (port 28789, etc.). This is convenient for Research-Claw-only users but overrides an existing OpenClaw installation.

### macOS / Linux (Source Install)

```bash
# 1. Stop the running process
pkill -f "openclaw.*gateway" 2>/dev/null

# 2. Remove the project directory
rm -rf ~/research-claw

# 3. Remove local data (database, config, memory)
rm -rf ~/.research-claw

# 4. (Optional) Remove OpenClaw global config
rm -rf ~/.openclaw

# 5. Remove CLI wrapper and shell environment variables
rm -f ~/.local/bin/openclaw
# Edit ~/.zshrc or ~/.bashrc, remove the lines containing OPENCLAW_CONFIG_PATH
# and "Research-Claw" comments (usually 2-3 lines), then open a new terminal

# 6. (Optional) Clean pnpm global cache
pnpm store prune
```

### Docker (macOS / Linux / Windows)

```bash
# 1. Stop and remove the container
docker stop research-claw && docker rm research-claw

# 2. Remove the image
docker rmi ghcr.io/wentorai/research-claw:latest

# 3. (Optional) Remove persistent data (config, database, workspace)
docker volume rm rc-config rc-data rc-workspace rc-state
```

On Windows, run the same commands in PowerShell.

> **Warning**: Step 3 permanently deletes all data (paper library, tasks, workspace files, session history). Skip this step if you want to keep your data.
>
> Docker installs do not modify host shell config or CLI wrappers — no additional cleanup needed.

### WSL2 (Windows Manual Install)

```powershell
# 1. Stop and remove inside WSL2 (same as Linux steps)
wsl -e bash -c "pkill -f 'openclaw.*gateway' 2>/dev/null; rm -rf ~/research-claw ~/.research-claw ~/.openclaw ~/.local/bin/openclaw"

# 2. Clean up shell environment variables (in WSL2 Ubuntu terminal)
wsl -e bash -c "sed -i '/OPENCLAW_CONFIG_PATH/d;/Research-Claw/d' ~/.bashrc 2>/dev/null"

# 3. (Optional) If WSL2 was only used for Research-Claw, unregister the distro entirely
wsl --unregister Ubuntu
```

> Unregistering a WSL distro deletes **all data** within it. Make sure you have no other use for it before proceeding.

---

## License

[BSL 1.1](LICENSE) — Free for personal and academic research use. Commercial use requires a separate license from [Wentor AI](https://wentor.ai) (help@wentor.ai). Converts to Apache 2.0 on 2030-03-12.

---

<div align="center">
<sub>Built with ❤️ by <a href="https://wentor.ai">Wentor AI</a></sub>
</div>
