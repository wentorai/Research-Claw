---
name: Writing SOP
description: >-
  Four-phase iterative protocol for academic writing and document production.
  Covers outline → draft → self-review → polish with Stop Points, material
  supplementation loops, version comparison, and mechanical self-check.
  Includes IMRaD, LaTeX, docx/markdown, citation formatting, and md2pdf.
---

# Academic Writing SOP — 学术写作标准操作规程

<!-- SKILL MAINTENANCE NOTES:
     - RC's writing SOP — covers all document production workflows
     - v2.0: Four-phase iterative protocol (material review → draft → self-review → polish)
     - Boundary: survey-sop = "synthesizing info", writing-sop = "turning info into documents"
     - Boundary: when citations insufficient, TRIGGER search-sop (don't duplicate search logic)
     - Citation management is a writing sub-process, lives here (not search-sop)
     - md2pdf: integrated here; md2pdf-export skill has full setup details
     - Stop Point pattern from academic-deep-research — proven to work
     - Update AGENTS.md pointers when modifying this skill
     - Related Research-Plugins Skills paths based on RP v1.4.0
     - Multi-model: MUST/NEVER keywords + numbered steps for low-IQ model compat
-->

## When to Read This Skill

Read this skill when the user asks to:
- Draft or edit academic text (papers, reports, theses, proposals)
- Format citations or bibliographies
- Export/import references (BibTeX, RIS, CSV, JSON, PDF, DOI list)
- Write or compile LaTeX documents
- Convert markdown to PDF, docx, or other formats
- Polish academic language or adjust tone
- Prepare a manuscript for submission

---

# FOUR-PHASE ITERATIVE WRITING PROTOCOL

> **CRITICAL — READ THIS FIRST**
>
> You MUST follow this four-phase protocol for ALL writing tasks longer than
> one paragraph. NEVER produce a complete draft in a single pass and call it
> done. Each phase has explicit steps. Complete them IN ORDER.
>
> 所有超过一段的写作任务必须遵循四阶段迭代流程。不得一次性写完就结束。

```
Phase 1  材料审查与大纲  Material Review & Outline    ⏸ STOP → wait for user
Phase 2  初稿生成        First Draft Generation       (continuous, mid-draft search if needed)
Phase 3  自检与修订      Self-Review & Revision        ⏸ STOP → present review results
Phase 4  精修与导出      Polish & Export               ⏸ STOP → present final + diff
```

**Version Tagging:** Every `workspace_save` MUST use version tags:
`{topic}-v1.md`, `{topic}-v2.md`, `{topic}-final.md`.

---

## Phase 1: 材料审查与大纲 (Material Review & Outline)

**Goal:** Confirm requirements, audit materials, produce outline with per-section
citation needs. Identify gaps BEFORE writing.

### Step 1: Gather Requirements

**MUST ask (skip items already answered by user):**

1. **Target format** — journal / conference / thesis / report / proposal?
2. **Venue/style** — specific journal, conference, or template?
3. **Citation style** — APA 7 / MLA 9 / Chicago / IEEE / other? (Default: APA 7)
4. **Language** — English / Chinese / bilingual?
5. **Length target** — approximate word/page count?
6. **Existing materials** — notes, data, figures, prior drafts in workspace?

### Step 2: Audit Available Materials (审查已有材料)

**MUST execute:**

1. `workspace_list` — check `outputs/drafts/` and `outputs/reports/` for existing work
2. `library_search` — search local library for relevant papers
3. `workspace_read` — read any existing notes/outlines the user mentions

### Step 3: Generate Section Outline (生成大纲)

**MUST produce this table for EACH section:**

| Section | Key Points | Citations Needed | Available | Gap? |
|:--------|:-----------|:-----------------|:----------|:-----|
| Introduction | Research gap, RQ, contributions | 5-8 | 3 | YES |
| Methods | ... | ... | ... | ... |

### Step 4: Material Supplementation Loop (材料补充循环)

**IF** any section has `Gap? = YES`:

1. Tell user: "Sections X, Y need more citations. I will search."
2. **Trigger search-sop** — use `web_search` or academic search tools
3. Add papers via `library_add_paper` or `library_import_bibtex`
4. Update outline table
5. **REPEAT** until gaps filled or search exhausted (document remaining gaps)

**NEVER** proceed to Phase 2 with known gaps unless user explicitly approves.

### ⏸ STOP POINT 1 — Present Outline (展示大纲，等待确认)

**MUST present:** (1) outline table, (2) materials summary, (3) remaining gaps, (4) estimated length.

**MUST say:** "Please review this outline. Reply with changes, or confirm to proceed."

**MUST WAIT. Do NOT proceed to Phase 2 automatically.**

---

## Phase 2: 初稿生成 (First Draft Generation)

**Goal:** Write section by section per outline. Save versioned draft.

### Step 1: Write Section by Section (逐节撰写)

**For EACH section in order:**

1. **Write** following outline key points
2. **Embed citations** per agreed style (see Appendix A)
3. **Per-section check:**
   - Every factual claim has citation? If NO → add or flag
   - All cited papers verified/in library? If NO → search or flag
   - All outline key points covered? If NO → expand
4. **If citation missing mid-section:** pause → search (search-sop) → add to library → continue
5. **If section needs a figure:** pause → load Plotting SOP → generate figure → `workspace_save` to `outputs/figures/` → embed reference ("See Figure N") → continue

### Step 2: Save v1

```
workspace_save → outputs/drafts/{topic}-v1.md
library_export_bibtex → outputs/exports/bibliography-{topic}.bib   (if BibTeX)
```

### Step 3: Progress Note

Tell user: "First draft (v1) saved. Moving to self-review." List any sections with improvised material.

**Do NOT wait for input here.** Proceed to Phase 3.

---

## Phase 3: 自检与修订 (Self-Review & Revision)

**Goal:** Execute mechanical checklist. Fix issues. Save v2. Present results.

### Step 1: Self-Check Checklist (自检清单)

**MUST check ALL 10 items. Record PASS or FAIL for each.**

| # | Check Item | Verify By |
|:--|:-----------|:----------|
| 1 | **Structure complete** — follows IMRaD or target format? | Compare headings vs outline |
| 2 | **Every claim cited** — no unsupported assertions? | Scan each paragraph |
| 3 | **Citation format consistent** — same style throughout? | Spot-check 5+ citations |
| 4 | **No fabricated references** — all papers real? | `library_search` cross-check |
| 5 | **Logical flow** — transitions between paragraphs? | Read endings→beginnings |
| 6 | **Academic tone** — no casual language? | Scan for colloquialisms |
| 7 | **Data/figures labeled** — numbered, captioned, referenced? | Check each table/figure |
| 8 | **Abstract ≤250 words** (if applicable)? | Word count |
| 9 | **No orphaned sections** — every header has content? | Scan structure |
| 10 | **Length ±20% of target**? | Word count |

### Step 2: Fix Every FAIL

**For EACH failed item:**
1. Describe the problem
2. Fix it
3. Re-verify → confirm PASS

If fixing requires new citations → trigger search (same as Phase 1 Step 4).

### Step 3: Save v2

```
workspace_save → outputs/drafts/{topic}-v2.md
```

### ⏸ STOP POINT 2 — Present Self-Review (展示自检结果)

**MUST present:**
1. Checklist results (10 items, PASS/FAIL)
2. Change summary (v1 → v2)
3. Remaining concerns
4. Ask: "Review `{topic}-v2.md`. Reply with changes, or confirm for final polish."

**MUST WAIT. Do NOT proceed to Phase 4 automatically.**

---

## Phase 4: 精修与导出 (Polish & Export)

**Goal:** Apply feedback, final polish, export, show version diff.

### Step 1: Apply User Feedback

For each piece of feedback: locate section → make change → verify consistency.
If "no changes" → skip to Step 2.

### Step 2: Final Language Polish (最终润色)

**MUST apply these 5 passes** (details in Appendix F):
1. **Conciseness** — cut redundancies
2. **Precision** — vague terms → exact values
3. **Flow** — smooth transitions, add signposts
4. **Terminology** — consistent terms for same concepts
5. **Grammar** — agreement, tense, articles

### Step 3: Save & Export

```
workspace_save → outputs/drafts/{topic}-final.md
```

Export per user request:

| Format | Action |
|:-------|:-------|
| docx | `workspace_export({ source: "…-final.md", format: "docx" })` |
| PDF | `workspace_export(…, format: "pdf")` or md2pdf pipeline (Appendix E) |
| LaTeX | Save as `.tex` with preamble (Appendix D) |
| BibTeX | `library_export_bibtex` |

If no format specified, ask user.

### Step 4: Version Comparison (版本对比)

**MUST present diff summary:** structural changes, content changes, quality fixes, word counts (v1 / v2 / final).

### ⏸ STOP POINT 3 — Final Deliverables (展示最终成果)

**MUST present:** (1) all saved file paths, (2) version diff, (3) all 10 checks PASS, (4) caveats.

**Writing task complete.**

---

# APPENDICES — Reference Material for the Phases Above

## Appendix A: Citation Formatting

| Style | In-text | Reference Format |
|:------|:--------|:-----------------|
| **APA 7** | (Author, Year) | Author, A. A. (Year). Title. *Journal*, *vol*(issue), pp. |
| **MLA 9** | (Author page) | Author. "Title." *Journal*, vol. X, no. Y, Year, pp. Z. |
| **Chicago** | Footnote / (Author Year) | Author. *Title*. Place: Publisher, Year. |
| **IEEE** | [1] | [1] A. Author, "Title," *Journal*, vol. X, no. Y, pp. Z, Year. |
| **Vancouver** | (1) | 1. Author AA. Title. Journal. Year;Vol(Issue):Pages. |
| **Harvard** | (Author Year) | Author, A.A. Year. Title. *Journal*, Vol(Issue), pp. |
| **Nature** | Superscript^1 | 1. Author, A. A. Title. *Journal* **Vol**, Pages (Year). |
| **ACM** | [Author Year] | Author. Year. Title. In *Proc. Conf.*, Pages. |

Default: APA 7. For CSL/GB/T 7714-2015, read **Citation Styles** skill.

## Appendix B: Citation Integrity Rules

1. Every cited paper **MUST** exist in local library or be verifiable via DOI.
2. Cite primary sources. Secondary only if primary genuinely inaccessible.
3. Paraphrase → cite. Quote → quotation marks + page numbers.
4. Cannot verify a paper? Say so. **NEVER** fabricate references.

## Appendix C: Writing Quality Standards

1. **Clarity:** Active voice. One idea per sentence. Define acronyms on first use.
2. **Precision:** Exact numbers, not "many." Specify units.
3. **Structure:** IMRaD unless user specifies otherwise.
4. **Tone:** Academic 3rd person default. "We" for multi-author. Adjust per user.
5. **Transitions:** Signpost phrases ("However," "In contrast," "Building on this,").

### IMRaD Section Guidelines

- **Introduction** — literature gap, research question, contribution summary
- **Methods** — materials, procedures, statistical tests, sample size justification
- **Results** — data first, figures/tables referenced, no interpretation
- **Discussion** — compare prior work, limitations, implications, future work
- **Abstract** — standalone summary (background, methods, results, conclusion; ≤250 words)

Other sections: Literature Review (humanities), Theory/Model (econ/physics), Related Work (CS), Case Study (law/business).

## Appendix D: LaTeX Writing SOP

**Compilation:** `xelatex` → `biber`/`bibtex` → `xelatex` ×2 → output.pdf
Use `exec`: `cd <dir> && xelatex -interaction=nonstopmode main.tex`

| Template | Use Case | Package |
|:---------|:---------|:--------|
| article/revtex | Journal | `revtex4-2`, `elsarticle` |
| beamer | Presentations | `beamer` |
| thesis | Graduation | `THUThesis`, `SJTUThesis`, `ustcthesis` |
| IEEE conf | CS/EE | `IEEEtran` |
| ACM | CS | `acmart` |

**Formulas:** Inline `$...$`, display `\[...\]` or `equation`, align `align`/`aligned`.
Numbering: `equation` auto, `equation*` suppresses. Cross-ref: `\label{eq:x}` + `\eqref{eq:x}`.

**Overleaf:** Use `\input{}` to split; switch to `xelatex` for CJK.

## Appendix E: Export & Conversion

### Export

| Format | Tool | Use Case |
|:-------|:-----|:---------|
| BibTeX `.bib` | `library_export_bibtex` | LaTeX, Overleaf, JabRef |
| RIS `.ris` | `library_export_bibtex(format:'ris')` | EndNote, Mendeley, Zotero |
| CSV/JSON/MD | `workspace_save` | Spreadsheet, API, docs |

### Import

| Format | Tool |
|:-------|:-----|
| BibTeX | `library_import_bibtex` |
| RIS | `library_import_ris` |
| PDF | `library_add_paper` (extract DOI) |
| DOI list | `library_batch_add` |
| CSV | Parse + `library_batch_add` |

### Pandoc

```bash
pandoc input.md -o output.docx --reference-doc=template.docx          # md→docx
pandoc input.md -o output.pdf --pdf-engine=xelatex -V CJKmainfont="Noto Serif CJK SC"  # md→pdf
pandoc input.docx -o output.md --extract-media=./media                 # docx→md
pandoc input.md -o output.pdf --citeproc --bibliography=refs.bib --csl=apa.csl  # +bib
```

For CJK: always specify CJK fonts. Use `--reference-doc` for consistent docx styling.

### md2pdf

Use `md2pdf-export` skill's Puppeteer pipeline. Setup: `bash skills/md2pdf-export/scripts/setup-env.sh`.
Convert: `node skills/md2pdf-export/scripts/md2pdf.js input.md [--format A4 --toc --theme github]`

## Appendix F: Language Polishing Guidelines

1. **Preserve meaning** — NEVER alter scientific content or conclusions
2. **Grammar** — agreement, tense consistency, articles, parallel structure
3. **Conciseness** — "in order to" → "to", "it is important to note that" → "notably"
4. **Hedging** — "may suggest," "appears to indicate" (avoid over-hedging)
5. **Terminology** — same term for same concept throughout
6. **CJK → English** — restructure topic-comment → subject-verb-object

Present changes as tracked edits (original vs. revised).

## Appendix G: RC Local Tools Reference

| Task | Tool | Pattern |
|:-----|:-----|:--------|
| Save draft | `workspace_save` | `outputs/drafts/{topic}-v1.md` |
| Save revision | `workspace_save` | `outputs/drafts/{topic}-v2.md` |
| Save final | `workspace_save` | `outputs/drafts/{topic}-final.md` |
| Review draft | `workspace_read` | `outputs/drafts/{file}` |
| List workspace | `workspace_list` | Check existing materials |
| Export Word | `workspace_export` | `{ source: "…", format: "docx" }` |
| Export PDF | `workspace_export` | `{ source: "…", format: "pdf" }` |
| Export bib | `library_export_bibtex` | `.bib` subset |
| Search library | `library_search` | Check available citations |
| Add paper | `library_add_paper` | Add found paper |
| Link to task | `task_link_file` | Link file to task |
| Compile LaTeX | `exec` | `cd {dir} && xelatex -interaction=nonstopmode main.tex` |
| Pandoc | `exec` | `pandoc {in} -o {out} [opts]` |

## Appendix H: Related Research-Plugins Skills

- `writing/composition/` — academic structure, ML paper writing, abstract crafting
- `writing/citation/` — Zotero, BibTeX management, APA/MLA/Chicago
- `writing/latex/` — LaTeX syntax, Overleaf, formula rendering
- `writing/templates/` — thesis templates (THUThesis, SJTUThesis), conference
- `writing/polish/` — language polishing, tone, grammar tools
- `tools/document/` — PDF parsing (GROBID), format conversion, large docs
