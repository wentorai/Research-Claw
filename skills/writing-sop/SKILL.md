---
name: Writing SOP
description: >-
  Standard operating procedure for academic writing and document production.
  Covers IMRaD structure, LaTeX compilation (thesis/conference templates),
  docx/markdown workflows, citation formatting (APA/MLA/Chicago/IEEE),
  BibTeX/RIS export, language polishing, and md2pdf conversion.
---

# Academic Writing SOP

<!-- SKILL MAINTENANCE NOTES:
     - This skill is RC's writing SOP — covers all document production workflows
     - Boundary with survey-sop: survey-sop handles "synthesizing information",
       writing-sop handles "turning information into documents"
     - Citation management is a writing sub-process, lives here (not search-sop)
     - md2pdf conversion is integrated here; md2pdf-export skill has full setup details
     - Update AGENTS.md pointers when modifying this skill
     - Related Research-Plugins Skills paths are based on RP v1.4.0
     - If RP updates its taxonomy, sync the paths in the final section
-->

## When to Read This Skill

Read this skill when the user asks to:
- Draft or edit academic text (papers, reports, theses, proposals)
- Format citations or bibliographies
- Export references (BibTeX, RIS, CSV, JSON)
- Import references (PDF, BibTeX, RIS, CSV, DOI list)
- Write or compile LaTeX documents
- Convert markdown to PDF, docx, or other formats
- Polish academic language or adjust tone
- Prepare a manuscript for submission

## Writing Quality Standards

When drafting or editing academic text:

1. **Clarity:** Prefer active voice. One idea per sentence. Define acronyms on
   first use.
2. **Precision:** Use exact numbers, not "many" or "several." Specify units.
3. **Structure:** Follow IMRaD (Introduction, Methods, Results, Discussion)
   unless the user specifies otherwise.
4. **Tone:** Academic third person by default. First person plural ("we") for
   multi-author papers. Adjust per user preference.
5. **Transitions:** Each paragraph should logically flow from the previous one.
   Use signpost phrases ("However," "In contrast," "Building on this,").

### IMRaD Section Guidelines

- **Introduction** — gap in literature, research question, contribution summary
- **Methods** — materials, procedures, statistical tests, sample size justification
- **Results** — data first, figures/tables referenced, no interpretation
- **Discussion** — compare with prior work, limitations, implications, future work
- **Abstract** — standalone summary (background, methods, key results, conclusion; ≤250 words)

Additional sections by discipline: Literature Review (humanities), Theory/Model
(economics/physics), Related Work (CS), Case Study (law/business).

## Citation Integrity Rules

1. Every cited paper must exist in the local library or be verifiable via DOI.
2. Cite the primary source, not a secondary reference, unless the primary is
   genuinely inaccessible.
3. When paraphrasing, cite the source. When quoting, use quotation marks and
   provide page numbers if available.
4. If asked to add a citation and you cannot verify the paper exists, say so.
   Do not fabricate or approximate references.

## Citation Formatting Guide

### Supported Styles

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
| **ACS** | Superscript/(num) | Author, A. A. Title. *J. Abbrev.* Year, Vol, Pages. |

For custom styles, use CSL (Citation Style Language) files.
**Default:** If the user says "just pick one," use APA 7 (most widely accepted).
**Detailed templates:** For copy-paste-ready format patterns (incl. GB/T 7714-2015),
read the **Citation Styles** skill.

## Export & Import Formats

### Export

| Format | Extension | Tool | Use Case |
|:-------|:----------|:-----|:---------|
| BibTeX | `.bib` | `library_export_bibtex` | LaTeX projects, Overleaf, JabRef |
| RIS | `.ris` | `library_export_bibtex(format: 'ris')` | EndNote, Mendeley, Zotero import |
| CSV | `.csv` | (manual via workspace_save) | Spreadsheet analysis, custom processing |
| JSON | `.json` | (manual via workspace_save) | Programmatic use, API integration |
| Markdown | `.md` | (manual via workspace_save) | Reading lists, documentation |

### Import

| Format | Tool | Notes |
|:-------|:-----|:------|
| BibTeX (.bib) | `library_import_bibtex` | Parse and add all entries |
| RIS (.ris) | `library_import_ris` | Standard bibliography interchange |
| PDF | `library_add_paper` + metadata extraction | Extract DOI from PDF, then resolve |
| DOI list | `library_batch_add` | One DOI per line, batch import |
| CSV | Parse + `library_batch_add` | Requires title or DOI column |

## LaTeX Writing SOP

### Compilation Workflow

```
.tex source
    │
    ├──▶ xelatex (1st pass)     → .aux, .log
    ├──▶ biber / bibtex          → .bbl (bibliography)
    ├──▶ xelatex (2nd pass)     → resolve references
    ├──▶ xelatex (3rd pass)     → finalize cross-refs
    └──▶ output.pdf
```

Use `exec` to run compilation: `cd <project-dir> && xelatex -interaction=nonstopmode main.tex`

### Template Usage

| Template | Use Case | Key Package |
|:---------|:---------|:------------|
| article/revtex | Journal submission | `revtex4-2` (APS), `elsarticle` (Elsevier) |
| beamer | Presentations | `beamer` |
| thesis | Graduation thesis | `THUThesis`, `SJTUThesis`, `ustcthesis` |
| IEEE conference | CS/EE papers | `IEEEtran` |
| ACM | CS papers | `acmart` |

### Formula Typesetting Quick Reference

- Inline: `$...$` — use for variables and short expressions
- Display: `\[...\]` or `equation` environment — use for key equations
- Align multiple: `align` or `aligned` environment
- Numbering: `equation` auto-numbers; `equation*` suppresses
- Cross-ref: `\label{eq:name}` + `\eqref{eq:name}`

### Overleaf Tips

- Use `\input{}` to split large documents into sections
- Overleaf defaults to `pdflatex`; switch to `xelatex` for CJK

## docx/Markdown Writing SOP

### Pandoc Conversion Pipeline

```bash
# Markdown → docx (with reference style)
pandoc input.md -o output.docx --reference-doc=template.docx

# Markdown → PDF (via LaTeX)
pandoc input.md -o output.pdf --pdf-engine=xelatex -V CJKmainfont="Noto Serif CJK SC"

# docx → Markdown
pandoc input.docx -o output.md --extract-media=./media

# BibTeX integration
pandoc input.md -o output.pdf --citeproc --bibliography=refs.bib --csl=apa.csl
```

### Style Management

- Use `--reference-doc` with a pre-styled `.docx` template for consistent formatting
- For CJK content, always specify CJK fonts explicitly

## md2pdf Conversion

For converting Markdown to publication-ready PDF/PNG/JPEG, use the Puppeteer-based
pipeline from the `md2pdf-export` skill.

### Quick Reference

```bash
# Environment setup (idempotent)
bash skills/md2pdf-export/scripts/setup-env.sh

# Basic PDF conversion
node skills/md2pdf-export/scripts/md2pdf.js input.md

# With options
node skills/md2pdf-export/scripts/md2pdf.js input.md --format A4 --toc --theme github
```

Supports YAML front-matter for per-file Puppeteer config (margins, headers/footers,
paper size). See the `md2pdf-export` skill for full CLI options and troubleshooting.

## Language Polishing Guidelines

When asked to polish or proofread academic text:

1. **Preserve meaning** — never alter the scientific content or conclusions
2. **Fix grammar and syntax** — subject-verb agreement, tense consistency,
   article usage (a/an/the), parallel structure
3. **Improve conciseness** — remove redundancies ("in order to" -> "to",
   "it is important to note that" -> "notably")
4. **Strengthen hedging** — academic hedging where appropriate ("may suggest,"
   "appears to indicate") but avoid over-hedging
5. **Consistent terminology** — use the same term for the same concept throughout
6. **CJK → English** — when translating Chinese academic text, restructure
   sentences for English conventions (topic-comment -> subject-verb-object)

Always present changes as tracked edits (original vs. revised) so the user can
review and accept/reject individually.

## RC Local Tools Reference

| Task | Tool | Pattern |
|:-----|:-----|:--------|
| Save draft | `workspace_save` | `outputs/drafts/{topic}.md` |
| Save final | `workspace_save` | `outputs/reports/{title}.md` |
| Review draft | `workspace_read` | `outputs/drafts/{file}` |
| Export bib | `library_export_bibtex` | Library subset as `.bib` |
| Save .bib | `workspace_save` | `outputs/exports/bibliography-{project}.bib` |
| Link to task | `task_link_file` | After saving, link file to task |
| md to PDF | `exec` | `node skills/md2pdf-export/scripts/md2pdf.js {file}` |
| Compile LaTeX | `exec` | `cd {dir} && xelatex -interaction=nonstopmode main.tex` |
| Pandoc | `exec` | `pandoc {input} -o {output} [options]` |

## Related Research-Plugins Skills

For detailed domain-specific writing guidance, read the subcategory index
SKILL.md at these paths:

- `writing/composition/` — academic writing structure, ML paper writing, abstract crafting
- `writing/citation/` — Zotero workflows, BibTeX management, APA/MLA/Chicago guides
- `writing/latex/` — LaTeX syntax, Overleaf collaboration, formula rendering
- `writing/templates/` — thesis templates (THUThesis, SJTUThesis), conference templates
- `writing/polish/` — language polishing, tone adjustment, grammar checking tools
- `tools/document/` — PDF parsing (GROBID), format conversion, large document handling
