---
name: Output Cards
description: >-
  JSON schema reference for 6 structured output card types used by
  the Research-Claw dashboard: paper_card, task_card, progress_card,
  approval_card, file_card, monitor_digest. Read this before outputting
  any structured card for the first time in a session.
---

<!-- SKILL MAINTENANCE NOTES:
     - Dashboard 用 JSON.parse() 解析卡片内容
     - 字段变更必须同步 dashboard/src/components/chat/ 中的渲染组件
     - file_card 必须从 workspace_save / workspace_export 工具输出中复制，绝不可伪造
     - approval_card 必须包含 approval_id（来自 exec.approval.requested）
-->

# Output Cards

Use fenced code blocks with the card type as the language tag. Content MUST be
valid JSON — the dashboard parser uses `JSON.parse()`.

## paper_card

**ONLY for real academic publications** — from API queries, `library_search`, or
user-identified papers. NEVER for concepts, tools, or non-scholarly content.

Required: `type`, `title`, `authors` (string[]).
Optional: `venue`, `year`, `doi`, `url`, `arxiv_id`, `abstract_preview`,
`read_status` ("unread"|"reading"|"read"|"reviewed"), `library_id`, `tags`.

## task_card

Required: `type`, `title`, `task_type` ("human"|"agent"|"mixed"),
`status` ("todo"|"in_progress"|"blocked"|"done"|"cancelled"),
`priority` ("urgent"|"high"|"medium"|"low").
Optional: `id`, `description`, `deadline` (ISO 8601), `related_paper_title`,
`related_file_path`.

## progress_card

Required: `type`, `period`, `papers_read`, `papers_added`, `tasks_completed`,
`tasks_created`. Optional: `writing_words`, `reading_minutes`, `highlights` (max 5).

## approval_card

Required: `type`, `action` (string), `context` (string), `risk_level` ("low"|"medium"|"high").
Required (for exec approvals): `approval_id` from `exec.approval.requested`
— without it, dashboard buttons are non-functional.
Optional: `details` (**must be a JSON object**, not a string — e.g. `{"paper_count": 7}`).

## file_card

**CRITICAL**: ONLY copy the file_card from `workspace_save` or `workspace_export` tool output verbatim.
**NEVER fabricate** — causes "file not found" errors.

## monitor_digest

Required: `type`, `monitor_name`, `source_type` (free-form), `target`,
`total_found`, `findings` (array of `{title, url?, summary?}`, max 10).
Optional: `schedule`.
