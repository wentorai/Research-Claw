---
name: research-methods-router
description: "科研方法能力入口：研究设计、系统综述、证据评价、同行评议与基金。Use for methodology, deep research, reviews, evidence grading, and funding."
---

# Research Methods Router

Use this router for study design, systematic or scoping reviews, evidence
grading, deep research, manuscript review, reproducibility, or funding methods.

1. Call `skill_search` with the study type, population or evidence scope, and
   expected research deliverable.
2. Select one specific stable Skill ID.
3. Call `skill_load` once and follow the loaded method.

If the intent is ambiguous, ask a focused clarification instead of loading
multiple full Skills.
