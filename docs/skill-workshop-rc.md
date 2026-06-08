# Skill Workshop in Research-Claw

Research-Claw uses OpenClaw 2026.6.1 **Skill Workshop** for governed skill creation and updates.

## Where to use it

1. **Dashboard → Extensions → 技能工坊 / Skill Workshop** — list proposals, inspect `PROPOSAL.md`, revise, apply, reject, quarantine, or hand off to chat.
2. **Chat** — ask the assistant to create or update skills; it should call the built-in `skill_workshop` tool (not raw `write`/`edit` on `SKILL.md`).
3. **CLI** — `openclaw skills workshop list|inspect|apply|...`

## Paths

| Location | Purpose |
|----------|---------|
| `./skills` | Repo-shipped research skills (extraDirs) |
| `./workspace/skills` | User/agent skills applied via Workshop |

Both directories are loaded via `skills.load.extraDirs` (set by `scripts/ensure-config.cjs`).

## Skill names

Skill names may be **Chinese or English**. Applied skills are stored under
`workspace/skills/<name>/` (Unicode directory names supported). Proposal IDs
remain ASCII internally (`skill-<hash>-…` for pure-Chinese names).

See [OpenClaw Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop). Defaults in RC:

- `autonomous.enabled: false` — no auto-proposals after every turn
- `approvalPolicy: pending` — agent apply/reject/quarantine may require approval in OC Control UI; RC dashboard calls gateway RPC directly as operator

## After apply

Refresh **Extensions → Skills** to see the new workspace skill. Use `skill_search` in chat to discover skill content.
