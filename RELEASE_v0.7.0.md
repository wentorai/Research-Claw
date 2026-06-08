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

## Quality gates
- Dashboard tests: **1338 pass**.
- `pnpm build`: green (extensions + dashboard).

## Upgrade

```bash
curl -fsSL https://wentor.ai/install.sh | bash
```

Docker:

```bash
curl -fsSL https://wentor.ai/docker-install.sh | bash
```
