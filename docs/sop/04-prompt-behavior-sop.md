# S4 — Prompt & Behavior Development SOP

> **HISTORICAL** (pre-redesign). Superseded by `docs/research-claw/PROMPT-ARCHITECTURE-REDESIGN.md`
> Development standards and operation log for bootstrap files, agent prompts, and behavior tuning
> Covers: 04 (Prompt Design Framework) + workspace/ bootstrap files

---

## 1. Scope

This SOP governs all development on the **bootstrap file system** — the 8 markdown files loaded into agent context at session start that define Research-Claw's personality, capabilities, and research workflow.

**Owner track:** Prompt/behavior team / agent
**Source files:** `workspace/` directory (8 .md files) + `skills/`
**Design doc:** `docs/04-prompt-design-framework.md`

---

## 2. Bootstrap File System

### 2.1 File Inventory

| File | Chars | Purpose | Load Priority |
|------|------:|---------|--------------|
| `SOUL.md` | 4,059 | Research persona, core principles, red lines (mock data exception) | Always |
| `AGENTS.md` | 18,861 | Session workflow, SOP, HiL protocol, card JSON examples, discipline workflows | Always |
| `HEARTBEAT.md` | 3,879 | Periodic checks: deadlines, digest, reading reminders, group meeting prep | Cron only (lightweight mode) |
| `BOOTSTRAP.md` | 11,341 | First-run onboarding: IM, workspace, group meeting, honey demo (self-renames to .done) | First run only |
| `IDENTITY.md` | 723 | Product identity, persona | Always |
| `USER.md` | 969 | User profile template (incl. group meeting) | Always |
| `TOOLS.md` | 5,234 | API reference, 31 local tools | Always |
| `MEMORY.md` | 4,606 | Persistent memory template (v1.1) | Always |
| **Total** | **49,672** | | |

**Limits:** 150,000 chars total, 20,000 chars per file.

### 2.2 Loading Mechanism

OpenClaw loads bootstrap files from the agent workspace directory:
- Default: `~/.openclaw/agents/main/`
- Research-Claw: `./workspace/` (via agent config)
- Files are loaded by `src/agents/bootstrap-files.ts`
- Truncation: head 70% + tail 20% + warning in middle
- Lightweight heartbeat mode: only loads `HEARTBEAT.md`

### 2.3 Always-Loaded Skill

`skills/research-sop/SKILL.md` — loaded in every session regardless of relevance matching. Contains research methodology SOP that supplements AGENTS.md.

Additionally, `skills/wentor-api/SKILL.md` provides platform API documentation.

---

## 3. Core Design Decisions (FINALIZED)

### 3.1 Persona

**Name:** Research-Claw (科研龙虾)
**Character:** Academic research assistant — professional, meticulous, helpful, nerdy
**Built by:** Wentor AI
**Platform:** OpenClaw satellite (local, privacy-respecting)
**Avatar concept:** Lobster with mortarboard

### 3.2 Red Lines (6 Absolute Boundaries)

These MUST NOT be weakened or removed:

1. **No fabricated citations** — Every citation must be verifiable
2. **No invented DOIs** — DOIs must resolve to real papers
3. **No plagiarism assistance** — Will not help copy without attribution
4. **No fabricated data** — Will not generate fake experimental results
5. **No submissions without approval** — Human-in-Loop for all external submissions
6. **No bypassing HiL for irreversible actions** — Destructive operations always need human approval

### 3.3 Research Workflow (4-Phase SOP in AGENTS.md)

1. **Literature Review** — search APIs + `library_add_paper`
2. **Deep Reading** — extract insights, update paper status, add notes
3. **Analysis & Writing** — synthesis, drafting, tables, figures
4. **Task Management** — create tasks with deadlines, link to papers

### 3.4 Human-in-Loop Protocol

Agent emits `approval_card` for:
- File deletions
- External API calls (submissions, emails)
- Database modifications affecting >10 records
- Any action marked `reversible: false`

Dashboard renders approval dialog, user confirms/rejects.

### 3.5 Heartbeat Routines (HEARTBEAT.md)

| Routine | Interval | Action |
|---------|----------|--------|
| Deadline check | Every heartbeat (30min) | Flag tasks within 48h of deadline |
| Daily digest | Once daily | Summary of papers read, tasks done, upcoming |
| Reading reminders | Once daily | Flag papers in "reading" status >7 days |
| Quiet hours | 23:00-08:00 | Suppress non-urgent output |

All thresholds configurable via `openclaw.json`:
- `heartbeatDeadlineWarningHours: 48`
- Heartbeat interval: `agents.defaults.heartbeat.intervalMinutes: 30`

### 3.6 Memory System (MEMORY.md)

Template structure (v1.1):
```
Global
  +-- Profile (name, field, career stage)
  +-- Environment (detected tools, OS)
  +-- Preferences (citation style, language)
  +-- Key Knowledge (discoveries, papers)
Current Focus: (active project marker)
Projects
  +-- Per-project: stage, deadline, papers, tasks, notes
```

- Agent updates MEMORY.md via `agents.files.set` RPC
- Kept under 20K chars, pruned monthly
- `Current Focus` marker updated when switching projects

### 3.7 Onboarding (BOOTSTRAP.md)

6-step first-run flow (~5 min):
1. Greeting + persona introduction
2. Research field, career stage, institution
3. Existing tools (reference manager, citation style)
4. Current projects (title, deadline, stage)
5. Preferences (language, notification frequency)
6. Environment detection (OS, editors, git, python/R/LaTeX)
   - **Tool Call Failure Protocol**: if a tool call fails, record `(检测失败)` instead
     of `(未检测)`. After 3+ consecutive failures, stop and warn about model compatibility.

Completion: writes MEMORY.md + USER.md, renames BOOTSTRAP.md to BOOTSTRAP.md.done.

---

## 4. Development Standards

### 4.1 Writing Guidelines

- **Language:** English default, bilingual annotations for zh-CN users
- **Tone:** Professional academic, not corporate. Clear and direct.
- **Format:** Markdown with YAML frontmatter where applicable
- **Length:** Each file should stay well under 20K chars (current total: ~50K of 150K budget)
- **Structure:** Use headings, bullet points, tables. Avoid walls of text.

### 4.2 Prompt Engineering Principles

1. **Specificity over generality** — Name exact tools, exact formats, exact limits
2. **Examples over rules** — Show a sample `paper_card`, not just describe it
3. **Negative constraints** — Red lines are more important than positive instructions
4. **Structured output** — Define card formats as fenced code blocks with type tags
5. **Fallback behavior** — Always specify what to do when uncertain
6. **Context efficiency** — Every char counts. Remove fluff, keep actionable content.

### 4.3 Modification Protocol

Before editing any bootstrap file:
1. Read `docs/04-prompt-design-framework.md` for the authoritative spec
2. Verify change doesn't violate Red Lines
3. Check char count stays under 20K per file
4. Test with actual agent session (send a research query, verify behavior)
5. Document change in operation log below

### 4.4 Testing

- **Behavioral testing:** Send research queries to agent, verify:
  - Citation format matches style preference
  - HiL prompts appear for destructive actions
  - Heartbeat produces correct card types
  - Onboarding flow completes properly
- **Regression testing:** After any prompt change, verify Red Lines still hold
- **Token budget:** Monitor total bootstrap token count. Alert if >30K chars.

### 4.5 PR Checklist

- [ ] YAML frontmatter valid (if applicable)
- [ ] Total chars < 20K per file
- [ ] No Red Line violations
- [ ] Card format examples match 03d spec
- [ ] Tool names match 00-reference-map tool list
- [ ] Both EN and ZH-CN content updated (if applicable)
- [ ] Tested with live agent session

---

## 5. File-by-File Modification Guide

### 5.1 SOUL.md

**What to change:** Persona refinements, principle additions, new Red Lines
**What NOT to change:** Core identity (name, character), existing Red Lines (never weaken)
**Coupling:** Referenced by AGENTS.md, IDENTITY.md

### 5.2 AGENTS.md

**What to change:** Workflow steps, tool usage patterns, card formatting rules, HiL thresholds
**What NOT to change:** Red Lines, approval_card requirement
**Coupling:** References SOUL.md, TOOLS.md, card types from 03d

### 5.3 HEARTBEAT.md

**What to change:** Routine thresholds, digest format, new periodic checks
**What NOT to change:** Quiet hours concept (users depend on this)
**Coupling:** Config `heartbeatDeadlineWarningHours`, cron system

### 5.4 BOOTSTRAP.md

**What to change:** Onboarding questions, flow order, environment detection
**What NOT to change:** Self-rename mechanism (BOOTSTRAP.md -> .done)
**Coupling:** Writes MEMORY.md + USER.md on completion

### 5.5 IDENTITY.md

**What to change:** Version number, avatar details
**What NOT to change:** Product name (Research-Claw / 科研龙虾), platform (OpenClaw satellite)
**Coupling:** Displayed in dashboard About section

### 5.6 USER.md

**What to change:** Template fields
**What NOT to change:** Basic structure (researcher info + projects + tools + preferences)
**Coupling:** Filled by BOOTSTRAP.md, read by AGENTS.md

### 5.7 TOOLS.md

**What to change:** API descriptions, tool usage tips, new tool entries
**What NOT to change:** Tool names (must match config.tools.alsoAllow — currently 31 RC tools + 9 RP tools)
**Coupling:** Tool names from 00-reference-map SS3.3

### 5.8 MEMORY.md

**What to change:** Template sections, pruning rules
**What NOT to change:** Global/Current Focus/Projects structure (v1.1 finalized)
**Coupling:** Written by BOOTSTRAP.md, updated by agent, read every session

---

## 6. Operation Log

> Append entries as work progresses.

### 6.1 Bootstrap Files

- [2026-03-11] [Claude] Initial 8 bootstrap files created (24.5K chars total)
- [2026-03-11] [Claude] MEMORY.md restructured to v1.1 (Global + Current Focus + Projects)
- [2026-03-12] [Claude] Phase 2C: Complete rewrite of AGENTS.md (v2.0, 17.3K chars) -- JSON card examples, 6 card types (incl. radar_digest), discipline workflows, HiL nuances, cold start protocol
- [2026-03-12] [Claude] Phase 2C: Complete rewrite of BOOTSTRAP.md (v2.0, 6.4K chars) -- IM setup, workspace folder, group meeting, honey feature demo
- [2026-03-12] [Claude] Phase 2C: Complete rewrite of HEARTBEAT.md (v2.0, 3.3K chars) -- JSON output format, group meeting prep check
- [2026-03-12] [Claude] Phase 2C: TOOLS.md updated (v2.0, 4.6K chars) -- 24 tools (was 18), added 6 extended library tools
- [2026-03-12] [Claude] Phase 2C: SOUL.md updated (v2.0) -- added mock data exception to Red Line #4
- [2026-03-12] [Claude] Phase 2C: USER.md updated (v2.0) -- added Group Meeting section
- [2026-03-12] [Claude] Phase 2C: IDENTITY.md and MEMORY.md verified (no changes needed)
- [2026-03-12] [Claude] Phase 2C: Total 38.3K chars across 8 files (budget: 150K) — later grew to ~50K with subsequent updates

### 6.2 Always-Loaded Skill

- [2026-03-11] [Claude] `skills/_always/research-sop/SKILL.md` created

### 6.3 Behavioral Tuning

<!-- Append prompt refinement entries here -->

### 6.4 Issues & Fixes

<!-- Append fixes here -->

---

## 7. Dependencies on Other Tracks

| Dependency | Track | Blocks |
|------------|-------|--------|
| Tool name list | Modules (S2) | TOOLS.md references |
| Card format spec | Modules (S2, 03d) | AGENTS.md card examples |
| Dashboard agent files API | Dashboard (S1) | MEMORY.md editing |
| Config heartbeat settings | — (openclaw.json) | HEARTBEAT.md thresholds |
| research-plugins skill list | Plugin Integration (S3) | TOOLS.md external API list |

---

*Document: S4 | Track: Prompt & Behavior | Created: 2026-03-11*
