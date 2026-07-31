---
name: research-writing-router
description: "科研写作能力入口：论文结构、润色、引用、LaTeX 与投稿模板。Use for academic composition, editing, citation styles, typesetting, and venues."
---

# Research Writing Router

Use this router for a specialized writing, editing, citation-management,
LaTeX, venue-template, or submission-formatting method.

1. Call `skill_search` with the document section, target venue or style, and
   requested transformation.
2. Choose one stable Skill ID from the compact results.
3. Call `skill_load` once before applying the instructions.

Use Research-Claw's Writing SOP for the overall production lifecycle; this
router supplies one specialized method within that workflow.
