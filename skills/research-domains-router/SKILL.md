---
name: research-domains-router
description: "科研学科能力入口：医学、生命科学、理工、社科与人文。Use for domain-specific databases, methods, terminology, compliance, and research workflows."
---

# Research Domains Router

Use this router when the request needs discipline-specific guidance in
biomedicine, AI/ML, chemistry, physics, mathematics, geoscience, economics,
finance, law, education, social science, humanities, or related fields.

1. Call `skill_search` with both the discipline and the concrete research task.
2. Select the most specific stable Skill ID from the compact candidates.
3. Call `skill_load` once for that ID.

Prefer a task-specific leaf over a broad domain overview. Candidate matches do
not count as used Skills.
