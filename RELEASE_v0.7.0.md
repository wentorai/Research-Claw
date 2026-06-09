# Research-Claw v0.7.0

> 科研龙虾 v0.7.0 — built as an OpenClaw satellite.
> OpenClaw base: `2026.6.1` · Protocol v3 · Date: 2026-06-08

## What's New

### Major features
- **Memory panel & subsystem** — a dedicated Memory panel backed by the new
  `rc_memories` store in `research-claw-core` (FTS-indexed long-term memory).
- **Paper Review** — end-to-end paper-review workflow (review panel, discipline
  detection, staged review prompts, cron-driven review sessions).
- **Skill Workshop** — author/apply skills from the dashboard, aligned with
  OpenClaw 2026.6.1 Skill Workshop (applied skills load from `workspace/skills`).
- **Staged Writing & Task Flow** — timeline UIs that visualize multi-stage
  writing and task execution as structured, inspectable runs.
- **Custom API profiles** — manage multiple model/provider API profiles from
  Settings, with a configurable panel dock layout.

### Platform
- **OpenClaw upgraded `2026.3.13` → `2026.6.1`** (pnpm patch migrated to
  `patches/openclaw@2026.6.1.patch`).
- Config self-healing (`ensure-config.cjs`) extended with OC 2026.6.1 migrations
  (legacy model APIs, bundled discovery, telegram streaming, DMS hooks).

### Fixes & hardening
- Supervisor robustness: DB graceful degradation, dbPath persistence, Docker
  research-plugins volume shadowing fix.
- Respect user-customized gateway auth tokens (#59).
- Update script GitHub fallback + SkillSearch catalog path fix.
- Example-config cleanup of OC-incompatible keys.

### Housekeeping
- Removed scratch test harnesses; ignore `config/` runtime data (browser cookies,
  media, npm, plugin-skills, `*.last-good`).
- `init-memory-demo.sh` now targets the correct `~/.research-claw/library.db`.
- `docker-entrypoint.sh` `IMAGE_VERSION` aligned to `0.7.0`.

### Post-release fixes (2026-06-09)
- **ppt-master 对齐上游 v2.9.0**(`57dc7e5 → 8ac18bb3`):Python 基线提升至 **3.10+**
  (上游用 PEP 604 `X | None`,3.9 导入即崩);导出改传 `-o` 显式输出路径,屏蔽上游默认
  输出目录变更;`pdf_to_md.py` 移除经核实对 RC 零影响。
- **ppt-master 集成路径解析修复**:dashboard「检查状态」此前始终报「集成路径不完整」——
  `api.resolvePath()` 是插件目录相对,而 ppt-master 子模块装在仓库根,两者从不重合。改为
  经 `findGitRoot()` 按仓库根优先、插件目录兜底解析。详见
  `docs/postmortem/ppt-master-v290-upgrade-and-path-resolution.md`。

## Quality gates
- Dashboard tests: **1338 pass**.
- 插件 tests: **566 pass**;`tsc --noEmit`: green。
- `pnpm build`: green (extensions + dashboard).

## Upgrade

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

Docker:

```bash
curl -fsSL https://wentor.ai/docker-install.sh | bash
```
