---
file: TOOLS.md
version: 3.4
updated: 2026-03-22
---

# Tool Reference

## §1 Local Tools (47)

### Library (25 tools)

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
| `library_zotero_detect` | Detect local Zotero (~/Zotero/zotero.sqlite). Returns item count, collections, tags. |
| `library_zotero_import` | Import from local Zotero SQLite database (read-only, auto-dedup by DOI/title). |
| `library_endnote_detect` | Detect local EndNote library (.enl SQLite). Returns record count, schema version. |
| `library_endnote_import` | Import from local EndNote .enl SQLite (read-only, auto-dedup). |
| `library_zotero_local_detect` | Check if Zotero Local API (localhost:23119) is reachable. Requires Zotero running. |
| `library_zotero_local_import` | Import from Zotero via Local API (read-only, auto-dedup). Zotero must be running. |
| `library_zotero_web_detect` | Validate Zotero Web API credentials (API Key + User ID). |
| `library_zotero_web_import` | Import from Zotero cloud library via Web API v3 (read). |
| `library_zotero_web_search` | Search Zotero cloud library via Web API v3 (read). |
| `library_zotero_web_create` | Create item in Zotero cloud (**requires approval_card**). |
| `library_zotero_web_update` | Update item in Zotero cloud (**requires approval_card**). |
| `library_zotero_web_delete` | Delete item from Zotero cloud (**requires approval_card, high risk**). |

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

**Cross-module triggers:**

| Trigger | Action |
|---------|--------|
| PDF saved to `sources/papers/` | Offer `library_add_paper` to index it |
| Code/script created in `outputs/` | Suggest `task_create` to track execution |
| Analysis output generated | Emit `file_card` + offer `task_complete` if linked |
| User asks "rollback/undo/恢复" | `workspace_history` → present commits → `workspace_restore` |

### Monitor (5 tools)

| Tool | Purpose |
|:-----|:--------|
| `monitor_create` | Create a new monitor with any free-form source_type category (academic, code, feed, web, social, or custom) |
| `monitor_list` | List all monitors with status and last check time |
| `monitor_report` | Report scan results with dedup fingerprints; updates memory.seen and memory.runs |
| `monitor_get_context` | Load monitor config + memory (notes, last run, seen count) before execution; MUST call first |
| `monitor_note` | Write/update adaptive notes for a monitor (max 4096 chars); persists observations across runs |

## §2 API Tools (34)

18 external databases, accessed via research-plugins API tools:

| Database | Tools | Best for |
|:---------|:------|:---------|
| **arXiv** | `search_arxiv`, `get_arxiv_paper` | CS, physics, math, bio preprints |
| **OpenAlex** | `search_openalex`, `get_work`, `get_author_openalex` | Broad coverage, institutions (250M+ works). Rate-limited without API key. |
| **CrossRef** | `search_crossref`, `resolve_doi` | DOI resolution, metadata (150M+ DOIs) — **broadest, default first choice** |
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

### Sort Parameters Quick Reference

When the user asks for "latest/最新" papers, you **MUST** pass date-based sort params.

| Tool | Sort parameter | Recency value | Date filter params |
|:-----|:--------------|:-------------|:-------------------|
| `search_arxiv` | `sort_by` | `'submittedDate'` | — |
| `search_crossref` | `sort` | `'published'` | `from_year`, `until_year` |
| `search_openalex` | `sort_by` | `'publication_date'` | `from_year`, `to_year` |
| `search_pubmed` | `sort` | `'pub_date'` | `min_date`, `max_date` |
| `search_biorxiv` | — | (date-ordered by default) | `interval: 'YYYY-MM-DD/YYYY-MM-DD'` |
| `search_europe_pmc` | `sort` | `'DATE_DESC'` | — |
| `search_inspire` | `sort` | `'mostrecent'` | — |
| `search_zenodo` | `sort` | `'mostrecent'` | — |
| `search_hal` | `sort` | `'producedDate_s desc'` | — |

Default sort is `relevance` for most tools. **Never rely on the default when the user
wants recent papers.**

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

Methodology, workflows, and domain-specific guidance are provided by 438
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

## §6 Memory (OC built-in)

| Tool | Purpose |
|:-----|:--------|
| `memory_search` | BM25 full-text search across MEMORY.md and memory/*.md. Use for retrieving past context, preferences, decisions. |
| `memory_get` | Read a specific memory file or line range by path. |

These tools are indexed automatically by OpenClaw. When an embedding provider is available,
search upgrades to hybrid (vector + text). Otherwise operates as text-only (FTS).

## §7 OpenClaw Inherited Web Tools

These tools come from OpenClaw core (not research-plugins). They are always available
via `profile: "full"` and do NOT require explicit `alsoAllow` entries.

| Tool | API Key? | Purpose | When to use |
|:-----|:---------|:--------|:------------|
| `web_fetch` | **No** | HTTP GET → markdown extraction | Direct URL access: arXiv RSS, conference pages, known paper URLs, API endpoints |
| `browser` | **No** | Full browser control (open, snapshot, act, close). **Always use `snapshot mode=efficient`** for academic pages. **Never pass `profile`** — omit it to use the default managed browser. | Interactive web search: Google Scholar, CNKI, IEEE Xplore, publisher sites |
| `web_search` | **Yes** (Brave/Google/Perplexity/XAI/Firecrawl/Moonshot) | Structured web search results | General web queries — only if a provider is configured |

### Priority for academic search

Matches research-sop Layer numbering:

```
Layer 1:   API tools (search_arxiv, search_crossref, etc.) — always try first
Layer 1.5: web_fetch (known URLs, RSS feeds, direct API) — no API key needed
Layer 2:   browser (interactive web search) — no API key needed, slower
Layer 3:   web_search — only if configured, NOT required for academic tasks
```

**Critical:** Never say "I cannot search because web_search/Brave Search is not
configured." Academic search should use L1 API tools. If those are insufficient,
escalate to `web_fetch` or `browser` — both work without any API keys.

### Useful direct URLs for `web_fetch`

- arXiv RSS: `https://rss.arxiv.org/rss/{category}` (e.g. `cs.CV`, `cs.RO`)
- arXiv API: `https://export.arxiv.org/api/query?search_query=...&sortBy=submittedDate`
- Google Scholar: use `browser` instead (requires JS interaction)
- PubMed RSS: `https://pubmed.ncbi.nlm.nih.gov/rss/search/...`

## §8 Tool Count

47 local + 2 memory + 34 API + 3 OC web = **86 available tools**.
438 skills accessible on-demand via research-plugins (40 subcategory indexes).
