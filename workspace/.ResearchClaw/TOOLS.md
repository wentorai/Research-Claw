---
file: TOOLS.md
version: 3.1
updated: 2026-03-18
---

# Tool Reference

## §1 Local Tools (38)

### Library (17 tools)

| Tool | Purpose |
|:-----|:--------|
| `library_add_paper` | Add a paper to local library (DOI, title, or BibTeX) |
| `library_search` | Full-text search across title, abstract, authors |
| `library_update_paper` | Update metadata, status, annotations |
| `library_get_paper` | Retrieve full details by DOI or internal ID |
| `library_export_bibtex` | Export library or subset as BibTeX |
| `library_reading_stats` | Reading activity summary |
| `library_batch_add` | Batch import multiple papers at once |
| `library_manage_collection` | Create, update, or delete paper collections |
| `library_tag_paper` | Add or remove tags on a paper |
| `library_add_note` | Add annotation note to a paper |
| `library_import_bibtex` | Import papers from BibTeX content |
| `library_citation_graph` | Query citation relationships between papers |
| `library_import_ris` | Import papers from RIS bibliography format |
| `library_zotero_detect` | Detect Zotero installation and available libraries |
| `library_zotero_import` | Import papers from Zotero via API bridge |
| `library_endnote_detect` | Detect EndNote XML export files |
| `library_endnote_import` | Import papers from EndNote XML format |

### Tasks (10 tools, incl. send_notification in §3)

| Tool | Purpose |
|:-----|:--------|
| `task_create` | Create a task with optional deadline |
| `task_list` | List tasks, filter by status/priority/deadline |
| `task_complete` | Mark a task as complete |
| `task_update` | Update task details |
| `task_delete` | Permanently delete a task |
| `task_link` | Link a task to a paper in the library |
| `task_note` | Add a timestamped note to a task |
| `task_link_file` | Link a task to a workspace file path |
| `cron_update_schedule` | Update the schedule of a cron preset |

### Workspace (7 tools)

| Tool | Purpose | Key Params |
|:-----|:--------|:-----------|
| `workspace_save` | Save content to a workspace file. Auto-commits to git. Returns file_card. | `path`, `content`, `message?` |
| `workspace_read` | Read a workspace file (UTF-8 text or base64 binary, max 10 MB). | `path` |
| `workspace_list` | List files in workspace. Supports recursive listing and glob patterns. | `path?`, `pattern?` (glob) |
| `workspace_diff` | Git diff: uncommitted changes, single-file diff, or commit range. | `path?`, `from?`, `to?` |
| `workspace_history` | Git commit log with commit hashes, messages, timestamps (paginated). | `path?`, `limit?`, `offset?` |
| `workspace_restore` | Restore file to previous version, creating a new commit. | `path`, `commit` (hash) |
| `workspace_move` | Move or rename file/directory with auto-commit. | `from`, `to` |

Workspace is a git-backed local repository. Every save creates a commit (debounced 5s). Files >10 MB auto-gitignored. You also have `exec` for CLI operations: `pandoc`, `pdftotext`, `python3`, `xelatex`, `grep`, `wc`, `jq`, etc.

### Monitor (4 tools)

| Tool | Purpose |
|:-----|:--------|
| `monitor_create` | Create a new monitor (arxiv, github, rss, webpage, openalex, twitter, custom) |
| `monitor_list` | List all monitors with status and last check time |
| `monitor_report` | Cache scan results for a specific monitor |
| `monitor_scan` | Instant scan of academic sources without creating a monitor |

## §2 API Tools (34)

18 external databases, accessed via research-plugins API tools:

| Database | Tools | Best for |
|:---------|:------|:---------|
| **arXiv** | `search_arxiv`, `get_arxiv_paper` | CS, physics, math, bio preprints |
| **OpenAlex** | `search_openalex`, `get_work`, `get_author_openalex` | Broad coverage, institutions (250M+ works) |
| **CrossRef** | `search_crossref`, `resolve_doi` | DOI resolution, metadata (130M+ DOIs) |
| **PubMed** | `search_pubmed`, `get_article` | Biomedical, life sciences |
| **Unpaywall** | `find_oa_version` | Legal open-access full text |
| **bioRxiv/medRxiv** | `search_biorxiv`, `search_medrxiv`, `get_preprint_by_doi` | Biology and medical preprints |
| **Europe PMC** | `search_europe_pmc`, `get_epmc_citations`, `get_epmc_references` | European biomedical literature |
| **DBLP** | `search_dblp`, `search_dblp_author` | Computer science bibliography |
| **INSPIRE-HEP** | `search_inspire`, `get_inspire_paper` | High-energy physics |
| **OpenCitations** | `get_citations_open`, `get_references_open`, `get_citation_count` | Open citation data |
| **DOAJ** | `search_doaj` | Open-access journals directory |
| **HAL** | `search_hal` | French open archives |
| **OpenAIRE** | `search_openaire` | EU-funded research |
| **DataCite** | `search_datacite`, `resolve_datacite_doi` | Research datasets and DOIs |
| **ORCID** | `search_orcid`, `get_orcid_works` | Researcher profiles and publications |
| **Zenodo** | `search_zenodo`, `get_zenodo_record` | Open data and research outputs |
| **ROR** | `search_ror` | Research organization registry |
| **OSF Preprints** | `search_osf_preprints` | Multidisciplinary preprints |

## §3 Special Tools

### send_notification
- **Auto-use:** Only for heartbeat reminders and deadline alerts.
- **All other cases:** Requires explicit user request.

### cron (built-in)
- **Use only** when the user explicitly asks for a recurring or scheduled task.
- Never set up cron jobs proactively.

### gateway (built-in)
- **Query config:** Allowed freely.
- **gateway.restart:** MUST present `approval_card` (risk_level: high) first.
- Never restart the gateway without explicit user request and confirmation.

## §4 Research Skills

Methodology, workflows, and domain-specific guidance are provided by 431
research-plugins skills organized in 6 categories (literature, research, analysis,
writing, domains, tools) with 40 subcategory indexes. Skills are loaded
automatically by OpenClaw's plugin system — browse subcategory indexes to discover
relevant skills, then read individual SKILL.md files for detailed guidance.
Tools always take priority over skill guidance.

## §5 Citation & Export

- **Citation styles:** APA, MLA, Chicago, IEEE, Vancouver, Harvard, Nature, ACM,
  ACS, custom CSL
- **Export formats:** BibTeX (.bib), RIS (.ris), CSV (.csv), JSON, Markdown
- **Import formats:** PDF, BibTeX (.bib), RIS (.ris), CSV, DOI list

## §6 Tool Count

38 local + 34 API = **72 registered tools**, all in `openclaw.json` `tools.alsoAllow`.
431 skills accessible on-demand via research-plugins (40 subcategory indexes).
