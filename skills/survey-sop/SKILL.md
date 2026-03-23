---
name: Survey SOP
description: >-
  Standard operating procedure for research survey and project execution.
  Covers deep reading methodology, information synthesis, paper evaluation,
  citation integrity, cross-module coordination (Library↔Tasks↔Workspace↔Monitor),
  and research project lifecycle (Phase 2-4).
---

<!-- MAINTENANCE NOTES:
     This is RC's core research execution skill, covering the entire workflow
     AFTER papers have been found (search-sop handles finding papers).

     Boundary with search-sop: search-sop = "find papers", survey-sop = "read,
     synthesize, and manage the project lifecycle".
     Boundary with writing-sop: survey-sop = "integrate information",
     writing-sop = "turn information into polished documents".

     Content sources:
       - AGENTS.md §8 Research Workflow Phase 2-4 (expanded)
       - AGENTS.md §6 Cross-Module Handoff (detailed)
       - research-sop: Paper Evaluation, Citation Integrity, Workspace Integration
     Last synced: 2026-03-23 (AGENTS.md v3.7)
-->

## Scope

Covers Phase 2-4 of the research workflow (after papers are found).
Does NOT cover: literature search (Phase 1, see **Search SOP**), writing standards
or document production (see **Writing SOP**), data analysis/coding (see **Coding SOP**).

## Phase 2 -- Deep Reading

Systematic reading extracts structured knowledge from each paper.

### Reading Workflow

1. **Select papers** from library with `library_search`.
   Prioritize by: deadline proximity > user request > relevance score > recency.
2. **Set read status** to "reading" via `library_update_paper(id, read_status: "reading")`.
3. **Read systematically** -- for each paper, extract:
   - **Core findings**: key results, quantitative outcomes, effect sizes
   - **Methodology**: study design, data sources, analytical approach, sample size
   - **Limitations**: stated limitations + unstated weaknesses you identify
   - **Key citations**: papers referenced that may warrant Phase 1 follow-up
4. **Save reading notes** to workspace:
   `workspace_save("outputs/notes/{paper-short-title}-notes.md", content)`
5. **Update paper metadata**: `library_update_paper(id, read_status: "read", notes: "...")`
6. **Flag gaps**: if the paper cites important work not in your library, note it
   for a targeted Phase 1 search. Do not silently skip missing references.

### Reading Depth Levels

- **Skim** (triage, large batch): title, abstract, conclusion, figures
- **Focused** (relevant to current question): methods + results + key citations
- **Deep** (core project paper): full extraction, reproduce key calculations

### Comparative Reading

When reading multiple papers on the same topic, build a comparison matrix
(method, dataset, results, limitations). Note contradictions and consensus.
Save via `workspace_save("outputs/notes/comparison-{topic}.md", ...)`

## Phase 3 -- Analysis and Synthesis

Transform extracted knowledge into coherent research outputs.

### Synthesis Workflow

1. **Organize findings** by theme, not by paper. Group related results across
   multiple papers to identify patterns, contradictions, and gaps.
2. **Draft the synthesis** following the user's preferred structure and citation
   style. Default to thematic organization with APA citations.
3. **Save drafts** to workspace:
   `workspace_save("outputs/drafts/{topic}-{type}.md", content)`
   Types: `literature-review`, `summary`, `analysis`, `report`
4. **Generate bibliography**: `library_export_bibtex(paper_ids: [...])` or
   `library_export_bibtex(paper_ids: [...], format: 'ris')`. Save to:
   `workspace_save("outputs/exports/bibliography-{project}.bib", bibtex)`
5. **Link output to task** if one exists (see Phase 4 Task-File Linking).

### Synthesis Quality Gates

Before presenting a synthesis to the user:
- Every claim has a citation traced to a paper in the library
- Contradictory findings are explicitly noted, not silently omitted
- Gaps in the literature are identified and flagged
- Quantitative claims use exact numbers from the source papers

## Phase 4 -- Task Management

Structure research work into trackable tasks with deadlines.

### Task Lifecycle

```
task_create → task_link (papers/files) → task_note (progress)
  → task_complete (with summary)
```

### Creating Tasks

`task_create` params: **title** (action statement), **task_type** ("human" |
"agent" | "mixed"), **priority** ("urgent" | "high" | "medium" | "low"),
**deadline** (ISO 8601).

### Task-File Linking

When a task produces output: (1) `workspace_save` the file, (2)
`task_link_file(task_id, file_path)`, (3) `task_complete(id, notes: "Output: ...")`.
For papers: `task_link(task_id, paper_id)`.

### Task Progress Tracking

Use `task_note(task_id, note)` for progress updates. Set `status: "blocked"` with
blocker note when stuck. On completion, emit a `progress_card`.

## Paper Evaluation Criteria

Evaluate five dimensions: **Venue quality** (reputable, peer reviewed?),
**Citation count** (citations-per-year, not raw count), **Methodology** (sound
approach, adequate sample, controls?), **Reproducibility** (sufficient detail?),
**Relevance** (addresses user's question?).

Rate: **high** / **medium** / **low**. Only add high + medium to library.

## Citation Integrity

Full citation rules (4 non-negotiable rules) are in the **Writing SOP** skill.
Key rule for survey phase: before citing any paper, call `library_search` to
confirm it exists locally. If not found, add it first (Cross-Module Rule 6).

## Cross-Module Coordination

Six handoff rules keep data consistent across modules:

1. **monitor_report -> library**: Present `paper_card` per finding. User selects
   which to add -> `library_add_paper`. Emit `monitor_digest`. Save digest to
   `outputs/monitor/monitor-scan-{date}.md`.
2. **monitor -> cron**: After `monitor_create`, suggest `cron` scheduling.
   Each tick: `monitor_get_context` -> scan -> `monitor_report` -> `monitor_note`.
3. **library_add_paper + active project**: Auto-call `task_link(task_id, paper_id)`.
   Reversible, no confirmation needed.
4. **task_complete -> progress_card**: Output `progress_card` with papers read,
   added, tasks completed, highlights.
5. **Phase transitions**: After Phase 1 -> `progress_card` + suggest Phase 2.
   After Phase 2 -> summarize findings + suggest Phase 3.
6. **Cite -> verify**: Before citing, `library_search` to confirm paper exists.
   If missing, `library_add_paper` first. Never cite unverified papers.

## Workspace Integration

All research outputs MUST be persisted to workspace -- never only in chat.

### Output File Naming

- `outputs/drafts/literature-review-{topic}.md` -- literature reviews
- `outputs/notes/{paper-short-title}-notes.md` -- reading notes
- `outputs/notes/comparison-{topic}.md` -- comparison matrices
- `outputs/reports/analysis-{dataset}.md` -- analysis reports
- `outputs/monitor/monitor-scan-{date}.md` -- monitor digests
- `outputs/reports/weekly-report-{date}.md` -- progress reports
- `outputs/exports/bibliography-{project}.bib` -- BibTeX exports

### Session Continuity

When resuming work, check: `workspace_history` (recent changes),
`workspace_list` (current files), `task_list` (active tasks).
Combine with MEMORY.md to reconstruct where the user left off.

## RC Local Tools Reference

Key tool call chains for survey and project execution:

### Deep Reading Chain
```
library_search -> library_update_paper(read_status:"reading")
  -> [read & extract] -> workspace_save(notes)
  -> library_update_paper(read_status:"read", notes)
```

### Synthesis Chain
```
library_search(tags/collection) -> [organize by theme]
  -> workspace_save(draft) -> library_export_bibtex(paper_ids)
  -> workspace_save(bibliography)
```

### Task Management Chain
```
task_create(title, deadline, priority) -> task_link(paper_id)
  -> task_note(progress) -> workspace_save(output)
  -> task_link_file(file_path) -> task_complete(notes)
```

### Monitor Integration Chain
```
monitor_create -> cron(schedule) -> monitor_get_context
  -> [scan] -> monitor_report -> monitor_note
  -> library_add_paper (user-selected) -> task_link
  -> workspace_save(digest)
```

## Related Research-Plugins Skills

For methodology and domain guidance beyond this SOP, browse these RP subcategories:

- `research/methodology/` -- research design, experimental design, grounded theory, mixed methods
- `research/deep-research/` -- systematic review (PRISMA), scoping review, meta-synthesis
- `research/paper-review/` -- paper summarization, peer review, quality assessment
- `research/funding/` -- grant writing (NSF/NIH), data sharing plans
- `research/automation/` -- end-to-end research pipelines, automated workflows
- `domains/` -- 16 discipline-specific subcategories (biomedical, cs, economics,
  law, humanities, etc.). Browse `domains/{discipline}/` for domain-specific
  research methodology, data sources, and evaluation standards
