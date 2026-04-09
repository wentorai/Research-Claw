---
name: Workspace SOP
description: >-
  Workspace file management, git versioning, directory conventions,
  and CLI execution safety rules for the Research-Claw workspace.
---

# Workspace Operations SOP

<!-- MAINTENANCE NOTE:
     Source: AGENTS.md §4 (extracted during prompt architecture redesign).
     Boundary: file/version management only. coding-sop covers code execution
     and data analysis. output-cards covers card schemas.
     Keep ≤ 4,000 bytes.
-->

## Architecture

The workspace is a **local Git repository**, auto-initialized on first use.
Every `workspace_save` creates a Git commit (debounced 5s for rapid batches).
Files over 10 MB are auto-added to `.gitignore`. The repo is **local-only** —
it never pushes to any remote.

The dashboard shows file tree, recent commits, and file previews. It does NOT
expose rollback — you are the user's interface for rollback and diff.

## Directory Conventions

```
sources/
  papers/        ← imported PDFs, full-text downloads
  data/          ← datasets, raw data files
  references/    ← BibTeX, RIS, supplementary materials
outputs/
  drafts/        ← manuscript drafts, notes
  figures/       ← generated plots, diagrams
  exports/       ← PDF/DOCX exports, slide decks
  reports/       ← analysis reports, summaries
.ResearchClaw/   ← system files (hidden from dashboard)
```

`sources/` = user inputs. `outputs/` = agent-generated files.

## Commit Message Prefixes

| Prefix | Usage |
|--------|-------|
| `Add:` | New file created |
| `Update:` | Existing file modified |
| `Upload:` | User-uploaded file saved |
| `Restore:` | File restored from history |
| `Delete:` | File removed |
| `Export:` | Binary format converted from text source |

## Tool Chain (11 tools)

| Tool | Purpose |
|------|---------|
| `workspace_save` | Write **text** file + auto-commit → emits `file_card` |
| `workspace_read` | Read file contents |
| `workspace_list` | List files (glob filter + git status) |
| `workspace_diff` | Show changes (no range = uncommitted vs HEAD) |
| `workspace_history` | List commits for a file or path |
| `workspace_restore` | Checkout historical version + commit as Restore: |
| `workspace_move` | Rename/move file + commit |
| `workspace_export` | Convert text → binary format (md→docx/pdf, csv→xlsx) |
| `workspace_delete` | Delete a file + auto-commit (requires confirm=true) → recoverable via `workspace_restore` |
| `workspace_append` | Append content to an existing file (or create) → emits `file_card` |
| `workspace_download` | Download URL → save binary to workspace (PDFs, images) → emits `file_card` |

## Version Control Operations

- **Undo / rollback**: `workspace_history` → present commits → user selects
  → `workspace_restore` → report with `file_card`.
- **Diff**: `workspace_diff` (default: uncommitted vs HEAD).
- **Proactive**: Mention git history after overwrites. Note `workspace_restore`
  on delete.
- **Delete**: `workspace_delete` (requires confirm=true). Always mention
  `workspace_restore` as recovery option.

## Write Discipline

- **Pre-check mandatory**: Before any `workspace_save` (overwrite), you MUST call `workspace_read` or `workspace_list` to verify existence and content to prevent accidental data loss.
- **Append vs. Overwrite**: When the intent is to "add to" a file, read the existing content first and concatenate. **Never** overwrite a multi-section file with only the new snippet.
- **Prefer append**: When adding content to an existing file, use `workspace_append` instead of read + concatenate + save. It prevents accidental overwrites and uses fewer tokens.
- **Root-only Scope**: All `workspace_*` tools operate **strictly** on relative paths within the workspace root. 
- **Out-of-bound (OOB) Rule**: For paths outside the workspace, `workspace_save` will fail or lose versioning. Do NOT attempt to use workspace tools for system-level files; use standard CLI (with `approval_card`) if necessary, but note these have **no Git/History** support.

## Binary Format Exports

`workspace_save` writes **UTF-8 text only**. For Word/Excel/PDF output:

1. Save content as Markdown/CSV: `workspace_save("outputs/drafts/paper.md", content)`
2. Convert: `workspace_export({ source: "outputs/drafts/paper.md", format: "docx" })`

| Source | → Target | Engine |
|--------|----------|--------|
| `.md` `.txt` | `.docx` | pandoc |
| `.md` `.txt` | `.pdf` | pandoc + xelatex (CJK supported) |
| `.csv` `.json` | `.xlsx` | Python pandas + openpyxl |

Output defaults to `outputs/exports/{name}.{format}`. Override with `output` param.

**NEVER** call `workspace_save` with a binary extension (`.docx`, `.xlsx`, `.pdf`,
`.pptx`, etc.) — the tool will reject the write and guide you to `workspace_export`.

### Native Install Dependencies

Docker images ship with all dependencies pre-installed. For **native (non-Docker)**
installs, `workspace_export` requires external tools. If conversion fails with
`ENOENT` or `command not found`, guide the user through installation:

**macOS (Homebrew):**
```bash
# Install Homebrew first if missing:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Then install conversion dependencies:
brew install pandoc            # md → docx
brew install --cask basictex   # md → pdf (xelatex engine)
pip3 install openpyxl          # csv → xlsx (pandas is usually present)
```

**Windows:** Download pandoc installer from https://pandoc.org/installing.html,
install MiKTeX for PDF support.

**Note:** `.pptx` generation is NOT supported by `workspace_export`. PPT creation
goes through the dedicated PPT extension (ExtensionsPanel → PPT Master).

## Download & Import

Use `workspace_download` to save PDFs, images, and other binary files from URLs:

```
workspace_download({ url: "https://arxiv.org/pdf/2301.00001", path: "sources/papers/paper.pdf" })
```

After downloading a PDF to `sources/papers/`, offer `library_add_paper` to index it.

## CLI Execution Safety

**Safe without approval** (no `approval_card` needed):

`wc`, `du`, `grep`, `find`, `pandoc`, `pdftotext`, `python3`, `xelatex`, `jq`

**Requires `approval_card`**:

`pip install`, `brew install`, `curl`, `wget`, any operation outside workspace.

## Cross-Module Triggers

- PDF saved/downloaded to `sources/papers/` → offer `library_add_paper`
- Paper added to library → suggest `workspace_save` BibTeX to `sources/references/refs.bib` via `workspace_append`
- Code file created → suggest `task_create` to track the work
- Analysis output generated → emit `file_card` + `task_complete` if linked

## Related Research-Plugins Skills

- `tools/document/` — PDF parsing, GROBID, format conversion, markdown workflows
- `tools/diagram/` — Mermaid, PlantUML, scientific illustrations for workspace outputs
