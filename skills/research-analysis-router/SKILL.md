---
name: research-analysis-router
description: "科研分析能力入口：统计、因果推断、数据清洗与可视化。Use for statistics, econometrics, wrangling, causal inference, charts, and publication figures."
---

# Research Analysis Router

Use this router when the task needs statistical analysis, causal inference,
data wrangling, econometrics, visualization, or publication figures.

1. Call `skill_search` with the concrete method, data type, and desired output.
2. Compare the compact candidates and choose one stable Skill ID.
3. Call `skill_load` for that one ID before following its instructions.

Search candidates are not used Skills. Do not load several candidates merely
to compare their full text.
