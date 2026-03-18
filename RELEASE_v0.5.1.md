# Research-Claw v0.5.1

> AI-powered local academic research assistant | 科研龙虾

## What's New

### Bootstrap File Layering (L1/L2/L3)

Three-tier bootstrap architecture ensures user data survives upgrades:

- **L1 System** (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md): force-updated on every upgrade
- **L2 Onboarding** (BOOTSTRAP.md → BOOTSTRAP.md.done): created once on first run, never overwritten
- **L3 User Data** (USER.md, MEMORY.md): initialized from `.example` templates, never touched again

Tracked files migrated to `.example` templates + `.gitignore`, with backup/restore in `install.sh` to protect existing users during the migration.

### Monitor System — MonitorDigest Card

- New `monitor_digest` card type with source-colored badges, finding list, and schedule display
- 16 test cases (8 unit + 8 edge) covering empty state, long names, special characters, unknown sources
- Integrated into notification system with content-based dedup keys

### Tool Schema Compliance (R1–R5)

Automated compliance framework preventing LLM provider HTTP 400 errors:

- R1: `type:"array"` must have `items`
- R2: `type` must be string, not array (nullable → `clearable()` pattern)
- R3: Top-level `parameters` must be `type:"object"`
- R4: `enum` must be non-empty
- R5: `required` fields must exist in `properties`

Task tools refactored: 8 nullable fields now use `clearable()` helper (empty string → null).

### Scripts & Installation

- `install.sh`: backup/restore user data (L2/L3) before `git reset --hard`; persist `OPENCLAW_CONFIG_PATH` in shell profile
- `setup.sh`: write `OPENCLAW_CONFIG_PATH` export to `.zshrc`/`.bashrc`
- `run.sh`: initialize L2/L3 bootstrap files before gateway start
- `docker-entrypoint.sh`: sync L1 system prompts from `/defaults/` on container start

### Dashboard & Cards

- **ApprovalCard**: pulse-glow animation moved to global CSS; informational fallback for cards without gateway
- **PaperCard**: passes `abstract` and `tags` to `library_add_paper`; BibTeX cite key generation
- **ProgressCard**: red border for urgent/overdue highlights
- **FileCard**: error messages now include file path and error detail
- **CodeBlock**: minor rendering improvements
- **config-patch**: updated tool whitelist (removed `search_papers`, added monitor tools)

### Code Quality

- **1097 tests** across 58 test files — all passing
- Bootstrap consistency test updated for 41 agent tools (was 31)
- Tool schema compliance test with static analysis of all 41 tools

## Upgrade

```bash
# macOS / Linux — run or re-run the install script
curl -fsSL https://wentor.ai/install.sh | bash

# Docker — pull the latest image
docker pull ghcr.io/wentorai/research-claw:0.5.1
```

Existing installations: re-run the install script. It detects and upgrades in-place.
User data files (USER.md, MEMORY.md) are automatically preserved during upgrade.

## Links

- Website: https://wentor.ai
- GitHub: https://github.com/wentorai/Research-Claw
- Research Plugins: https://www.npmjs.com/package/@wentorai/research-plugins
- v0.5.0 Release Notes: [RELEASE_v0.5.0.md](RELEASE_v0.5.0.md)
