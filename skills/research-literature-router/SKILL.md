---
name: research-literature-router
description: "科研文献能力入口：检索、全文、元数据、引文追踪与发现。Use for literature databases, full text, bibliometrics, alerts, and citation networks."
---

# Research Literature Router

Use this router for database-specific literature search, full-text access,
metadata enrichment, bibliometrics, citation traversal, or paper discovery.

1. Call `skill_search` with the database, evidence type, and intended operation.
2. Inspect the bounded metadata results and select one stable Skill ID.
3. Call `skill_load` for the selected ID before executing its workflow.

Use Research-Claw's Search SOP for overall search strategy; use this router to
load one specialized research-plugins method.
