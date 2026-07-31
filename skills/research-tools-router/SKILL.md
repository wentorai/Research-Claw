---
name: research-tools-router
description: "科研工具能力入口：文档解析、OCR、知识图谱、代码执行与数据采集。Use for research software, diagrams, scraping, notebooks, OCR, and graphs."
---

# Research Tools Router

Use this router when a task needs a specialized research application or
technical workflow: document parsing, OCR/translation, diagrams, knowledge
graphs, code execution, notebooks, or ethical data collection.

1. Call `skill_search` with the artifact format, intended operation, and named
   tool when one is requested.
2. Select one stable Skill ID from the metadata candidates.
3. Call `skill_load` for exactly that ID.

Loading a Skill does not bypass normal tool permissions or user confirmation.
