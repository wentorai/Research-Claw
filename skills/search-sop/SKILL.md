---
name: Search SOP
description: >-
  Standard operating procedure for academic literature search.
  Covers local library search, 18 academic database APIs (L1),
  web_fetch direct access (L1.5), browser RPA for CNKI/Google Scholar (L2),
  and optional API services (L3). Includes domain routing, recency protocol,
  and Zotero/EndNote import bridges.
---

# Search SOP — 文献搜索标准操作规程

<!-- SKILL MAINTENANCE NOTES:
     - 此 skill 是 RC 的搜索方法论核心，替代原 research-sop 中的搜索部分
     - 内容来源：原 research-sop + TOOLS.md §2/§7 + AGENTS.md §3
     - 更新时注意：AGENTS.md 中有一行指针引用此 skill 的 name 字段
     - Related Research-Plugins Skills 路径基于 RP v1.4.0 taxonomy
     - 不要在此文件中重复 AGENTS.md 中的红线或 HiL 规则
     - 不要在此文件中包含 Output Card JSON schemas
     - 不要在此文件中包含写作质量标准、引用格式、工作区架构
-->

## 适用场景

Read this skill when the user's request involves any of:
- Searching for academic papers, preprints, or datasets
- Importing references from Zotero, EndNote, BibTeX, or RIS
- Importing a local PDF into the library
- Asking for "最新/latest/recent" papers (recency search)
- Requesting literature from a specific database (CNKI, Google Scholar, WoS, etc.)
- Multi-concept intersection queries (e.g., "PFAS + machine learning")
- Understanding which API tool to use for a specific academic domain

---

## 1. Three-Layer Search Architecture

Literature search uses a **priority fallback** model. Start from Layer 0 for local
imports; Layer 1 for search; escalate to Layer 2/3 when the previous layer cannot
satisfy the request.

### Layer 0 — Local Reference Manager Import (not search)

One-time or periodic import from user's existing reference manager.
These are **NOT search tools** — they read local databases directly.

| Source | Detect → Import | Mechanism | Env |
|:-------|:---------------|:----------|:----|
| Zotero | `library_zotero_detect` → `library_zotero_import` | ~/Zotero/zotero.sqlite (read-only) | Native |
| EndNote | `library_endnote_detect` → `library_endnote_import` | ~/Documents/*.enl (read-only) | Native |
| BibTeX/RIS | `library_import_bibtex` / `library_import_ris` | Parse content string | All |

**Zotero fallback chain** (try in order):
1. **SQLite direct** — fastest, works offline, Zotero need not be running
2. **Local API** (localhost:23119) — Zotero must be running, read-only
3. **Web API v3** (api.zotero.org) — needs API Key + User ID, full CRUD
4. **Format export** — `library_export_bibtex/ris` → guide user to import manually

**EndNote fallback chain**: SQLite direct → Format export (no API available).

**Docker environment**: SQLite and Local API unavailable (host filesystem
isolated). Explain to user: use BibTeX/RIS export from source app, or mount
host Zotero directory as Docker volume.

**Reverse path (RC → Zotero/EndNote)**: If Zotero Web API Key configured →
`library_zotero_web_create` (requires approval_card). Otherwise →
`library_export_bibtex` + guide user to File > Import in their reference manager.

**Other reference managers** (Mendeley, ReadCube, JabRef, Citavi, etc.):
No direct bridge. Guide user to export BibTeX/RIS → `library_import_bibtex`/`library_import_ris`.

**Key behaviors**: `detect` → `available: false` in Docker → explain host isolation,
suggest BibTeX/RIS. Reverse write via Web API → `approval_card` (risk_level: medium).
First detection → record in MEMORY.md `## Global > ### Environment`.

### Layer 1 — Built-in API Tools (free, no auth, structured data)

Always available, require NO API keys. Use as **primary search method**.

| Tool | Coverage | Best for |
|:-----|:---------|:---------|
| `search_crossref` / `resolve_doi` | 150M+ DOIs | **Default first choice** — broadest DOI coverage |
| `search_openalex` / `get_work` / `get_author_openalex` | 250M+ works | All disciplines, institutions, topics |
| `search_europe_pmc` | 33M+ biomedical | Biomedical + full text + OA + citations |
| `search_doaj` | 9M+ verified OA | Guaranteed open access |
| `search_openaire` | 170M+ records | EU-funded research |
| `search_arxiv` / `get_arxiv_paper` | 2M+ preprints | CS, physics, math |
| `search_dblp` / `search_dblp_author` | 7M+ CS records | CS conferences + journals |
| `search_pubmed` / `get_article` | 36M+ citations | Medicine, biology |
| `search_biorxiv` / `search_medrxiv` / `get_preprint_by_doi` | 400K+ preprints | Biology / medical preprints |
| `get_citations_open` / `get_references_open` / `get_citation_count` | 2B+ links | Citation tracking (all disciplines) |
| `get_epmc_citations` / `get_epmc_references` | Europe PMC | Biomedical citation tracking |
| `find_oa_version` (Unpaywall) | 20M+ OA | Finding free PDFs by DOI |
| `search_zenodo` / `get_zenodo_record` | 3M+ records | Datasets, software, supplementary |
| `search_orcid` / `get_orcid_works` | 18M+ scholars | Author disambiguation |
| `search_inspire` / `get_inspire_paper` | 1.5M+ HEP | High-energy physics |
| `search_hal` | 4M+ French OA | French/European research |
| `search_osf_preprints` | 30+ preprint servers | SocArXiv, PsyArXiv, EarthArXiv, etc. |
| `search_datacite` / `resolve_datacite_doi` | 50M+ dataset DOIs | Dataset DOI resolution |
| `search_ror` | 100K+ institutions | Institution disambiguation |

### Layer 1.5 — `web_fetch` Direct Access (no API key, faster than browser)

Between L1 API tools and L2 browser, use `web_fetch` to directly access known URLs.

**Useful direct URLs:**
- **arXiv RSS** (latest by category): `https://rss.arxiv.org/rss/{category}` (e.g. `cs.CV`)
- **arXiv API** (structured): `https://export.arxiv.org/api/query?search_query=ti:transformer&sortBy=submittedDate&sortOrder=descending&max_results=20`
- **PubMed RSS**: subscribe URLs from PubMed search results
- **Conference pages**: known proceedings URLs (NeurIPS, ICML, ACL, etc.)

**When to use `web_fetch`**: You know the exact URL; page is static HTML; extracting content from a specific page.
**When to use `browser` instead**: Form interaction needed; JavaScript rendering required; multi-page navigation.

### Layer 2 — Browser RPA (databases without public APIs)

When Layer 1 tools cannot reach the required database, use the `browser` tool.

**Target databases**: Google Scholar, CNKI / 万方 / 维普, Web of Science / Scopus,
IEEE Xplore, ACM DL, SpringerLink, any user-specified database.

**IMPORTANT:** Never pass `profile` parameter — omit it to use the default managed browser.

**Workflow:** `open url` → `snapshot mode=efficient` (note targetId) → `act kind=type`
(query) → `act kind=click` (submit) → `snapshot mode=efficient` (extract results) →
`library_add_paper` or report → `close`.

**Critical:** Always use `mode=efficient` (~10K chars vs 80K default). Always pass
`targetId` from snapshot into `act` calls.

**Error recovery:** "Element not found" → one fresh snapshot, retry once. "Tab not
found" → `browser action=tabs` for active targetIds. Context overflow → extract
from last snapshot and close.

**Hard rules:** Max 3 snapshots per session. Never paginate. Never click into
individual papers (use `resolve_doi`/`web_fetch` instead). Always close browser.

### Layer 3 — API Key Required (optional, user configures)

Do NOT prompt users to register. Only use when the user has already configured.

| Service | Tools | Best for |
|:--------|:------|:---------|
| **Wentor API** (wentor.ai account) | `wentor_qa`, `wentor_search` | Chinese literature, semantic search |
| **OpenAlex** (optional key) | `search_openalex` etc. | Higher rate limits (works without key at L1) |

Third-party keys (Serper, Tavily, etc.): user installs skill/MCP themselves.
Never ask users to register for third-party API keys.

---

## 2. Domain → Tool Routing

**Do NOT** send queries to the wrong domain's tool.

| Domain | Primary Tools | NEVER use | Notes |
|:-------|:-------------|:----------|:------|
| **CS / AI / ML** | `search_dblp` + `search_arxiv` | — | dblp = conferences; arXiv = preprints |
| **Biomedical / Clinical** | `search_pubmed` + `search_europe_pmc` | `search_arxiv` | bioRxiv/medRxiv for preprints only |
| **Physics / Math** | `search_arxiv` + `search_inspire` | — | INSPIRE for high-energy physics |
| **Economics** | `search_crossref(journal=...)` | `search_arxiv` | Top-5: AER, QJE, JPE, Econometrica, REStud |
| **Social Sciences** | `search_osf_preprints(socarxiv)` + `search_crossref` | `search_arxiv` | SocArXiv for preprints |
| **Psychology** | `search_osf_preprints(psyarxiv)` + `search_pubmed` | — | PsyArXiv + PubMed |
| **Environmental Sci** | `search_crossref` + `search_openalex` | `search_arxiv` | `search_pubmed` for health-effects angle |
| **Chemistry** | `search_crossref` | — | ChemRxiv blocked; CrossRef + browser |
| **Engineering** | `search_osf_preprints(engrxiv)` + `search_crossref` | — | |
| **Earth Sciences** | `search_osf_preprints(eartharxiv)` + `search_crossref` | — | |
| **French/European** | `search_hal` + `search_openaire` | — | HAL for French; OpenAIRE for EU-funded |
| **Datasets / Software** | `search_zenodo` + `search_datacite` | — | |
| **Chinese Literature** | **Layer 2 Browser → CNKI** | All L1 tools | No free API covers Chinese journals |
| **HEP / Astrophysics** | `search_inspire` + `search_arxiv` | — | INSPIRE is authoritative for HEP |

---

## 3. Tool Filter Capability Matrix

What each tool CAN filter — determines routing decisions.

| Tool | Journal | Year | Author | OA | Sort |
|:-----|:--------|:-----|:-------|:---|:-----|
| `search_crossref` | ✅ `journal`/`issn` | ✅ `from_year`/`until_year` | ❌ | ❌ | relevance, published, cited-by |
| `search_openalex` | ❌ | ✅ `from_year`/`to_year` | ❌ | ✅ | relevance_score, publication_date, cited_by_count |
| `search_europe_pmc` | ✅ `JOURNAL:` in query | ❌ | ✅ `AUTH:` | ❌ | RELEVANCE, DATE_DESC, CITED |
| `search_pubmed` | ✅ `[Journal]` in query | ✅ `min_date`/`max_date` | ✅ `[Author]` | ❌ | relevance, pub_date |
| `search_arxiv` | ✅ `cat:` | ❌ | ✅ `au:` | all OA | relevance, date |
| `search_dblp` | ❌ | ❌ | ❌ | ❌ | relevance only |
| `search_doaj` | ✅ field | ✅ field | ✅ field | all OA | custom field |
| `search_openaire` | ❌ | ✅ `from_date`/`to_date` | ✅ `author` | ✅ `oa_only` | N/A |
| `search_biorxiv/medrxiv` | N/A | ✅ date interval | ❌ | all OA | by date |
| `search_inspire` | ✅ SPIRES `j` | ❌ | ✅ SPIRES `a` | ❌ | mostrecent, mostcited |
| `search_hal` | ❌ | ✅ sort | ❌ | all OA | producedDate |
| `search_osf_preprints` | ✅ `provider` | ❌ | ❌ | all OA | N/A |
| `search_zenodo` | N/A | ❌ | ❌ | ✅ | bestmatch, mostrecent |
| `search_datacite` | N/A | ✅ `from_year` | ❌ | ❌ | relevance |

---

## 4. Sort Parameters Quick Reference

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

Default sort is `relevance` for most tools. **Never rely on the default when the
user wants recent papers.**

---

## 5. Trigger Word Table

| Trigger (zh/en) | Primary tool | Fallback |
|:----------------|:------------|:---------|
| 搜论文 / search papers | search_arxiv, search_crossref | search_openalex, browse skills/literature/search/ |
| 最新论文 / latest papers | search_arxiv (按时间排序), search_crossref (按时间排序) | search_openalex, browser |
| 入库 / add paper | library_add_paper | library_batch_add |
| 标签 / tag | library_tag_paper | library_manage_collection |
| 导入 / 添加PDF / import PDF | library_add_paper | Read (built-in) + search_arxiv |
| Zotero 导入 / import Zotero | library_zotero_detect → import | Layer 0 fallback chain |
| 同步到 Zotero / sync to Zotero | library_export_bibtex → guide import | With API Key: library_zotero_web_* |
| EndNote 导入 / import EndNote | library_endnote_detect → import | BibTeX/RIS fallback |
| RIS 导入 / import RIS | library_import_ris | library_import_bibtex |

---

## 6. Recency Search Protocol

When the user asks for "最新", "latest", "recent", or "past N months/weeks" papers,
you **MUST** override default relevance sorting with date-based sorting.

**Recency search workflow:**
1. Determine time range: "最新" = last 3 months; "近期" = last 6 months; explicit range if stated.
2. Select 2+ sources by domain (see §2 Domain→Tool Routing).
3. Pass date-based sort **and** date filter where both are supported (see §4).
4. If API results are insufficient, escalate:
   - `web_fetch` arXiv RSS feed: `https://rss.arxiv.org/rss/{category}`
   - `browser` → Google Scholar with date filter (Tools → Custom range)
5. **Never** cite `web_search` / Brave Search unavailability as a reason to stop.

---

## 7. Selection Logic Decision Tree

```
0. "latest/最新/recent"? → §6 Recency Protocol. MUST pass date sort.
1. Database NOT in L1 (CNKI, WoS, Scopus, GScholar)? → Layer 2 Browser.
2. Journal name specified? → search_crossref(journal=...) + search_europe_pmc(JOURNAL:...).
   Returns 0? → Layer 2 Browser.
3. Complex multi-filter? → Combine broadest tool + local filtering.
   Still insufficient? → Layer 2 Browser.
4. Simple keyword? → Route by domain (§2). Use 2+ sources for targeted/exhaustive.
5. L1 returns 0? → Suggest broadening keywords + offer L2/web_fetch.
   Do NOT retry same source. Do NOT cite "web_search not configured."
6. Multi-concept intersection? → §8 Decomposition.
```

---

## 8. Multi-Concept Query Decomposition

When the user's topic spans **multiple distinct concepts** (e.g., "PFAS / microplastics /
EDCs + machine learning"), a single combined query returns noisy results because
text-based search engines match ANY keyword, not the intersection.

**Decomposition strategy:**
1. **Identify the anchor concept** — the methodological or thematic constant (e.g., "machine learning").
2. **Split domain-specific concepts** into separate sub-queries, each paired with the anchor.
3. **Run each sub-query independently** on the appropriate L1 tool(s) for the domain.
4. **Merge and deduplicate** results by DOI / title before presenting.
5. **Use filters** (`from_year`, `has_abstract: true`, `sort: "published"`) on each sub-query.

**Anti-patterns:**
- Concatenating all keywords into one query string
- Using arXiv for non-CS/physics/math domains just because "machine learning" appears
- Reporting noisy results without filtering — always rate relevance before presenting

---

## 9. L1 → L2 Escalation Rules

**Use L2 when:** user asks for CNKI/WoS/Scopus/Google Scholar, L1 returns 0 for
journal query, need paywall fulltext, need faceted search or conference proceedings.

**Do NOT use L2 for:** simple keyword search (L1 faster), DOI resolution
(`resolve_doi`), citation tracking (`get_citations_open`).

---

## 10. Source Health Awareness

Tool responses include `_source_health: { source, latency_ms }`.

- **Within session:** 2+ errors (429/503/timeout) from a source → stop using it, switch to alternative (§2).
- **Across sessions:** 3+ consecutive sessions with failures → record in MEMORY.md:
  `Source {name} unreliable since {date}: {pattern}. Prefer {alt}.`
- Always use **at least two sources** for targeted/exhaustive scopes.

---

## 11. Dynamic Tool Priority

User-configured API keys **override** defaults by elevating that service to L1:

- Record in MEMORY.md `## Global > ### Environment`: `"Wentor API: configured"`, etc.
- **MUST-USE rule**: User-configured API → call FIRST, then supplement with standard L1.
  Example: Wentor API configured → `wentor_search` FIRST, then arXiv/CrossRef.
- Brave API Key → `web_search` at L1. Zotero API Key → `library_zotero_web_*`.
- **Never store actual API key values** — only "configured" status.

---

## 12. PDF Import Protocol

"导入PDF / import PDF" workflow:
1. Read the PDF (extract metadata: title, authors, DOI, abstract).
2. Verify via `resolve_doi` / `search_arxiv` (match title or DOI).
3. Dedup with `library_search` (check if already in library).
4. `library_add_paper` with `source: "local_import"` + `pdf_path`.
5. Never fabricate metadata — if extraction fails, ask the user.

---

## 13. Post-Search Processing

1. **Deduplicate** — check DOI / arXiv ID against local library before adding.
2. **Rate relevance** — high / medium / low. Only add high + medium to library.
3. **Batch import** — use `library_batch_add` for 3+ papers.
4. **Tag immediately** — apply topic tags at import time for future retrieval.

---

## 14. Paper Evaluation Criteria

Rate each paper **high / medium / low** based on: venue quality, citation count
(adjusted for age), methodology soundness, reproducibility, and relevance to the
user's question. Only add high + medium papers to the library unless user requests
otherwise.

---

## RC Local Tools Reference

### library_* Call Patterns

| Scenario | Tool chain |
|:---------|:-----------|
| Single paper found via API | `library_search` (dedup check) → `library_add_paper` → `library_tag_paper` |
| Batch import (3+ papers) | `library_batch_add` (auto-dedup by DOI) → `library_tag_paper` per paper |
| Zotero import | `library_zotero_detect` → `library_zotero_import` (auto-dedup) |
| EndNote import | `library_endnote_detect` → `library_endnote_import` (auto-dedup) |
| BibTeX file import | `library_import_bibtex` (parse content) |
| RIS file import | `library_import_ris` (parse content) |
| PDF file import | Read (metadata) → `resolve_doi` (verify) → `library_search` (dedup) → `library_add_paper` |
| Citation tracking | `get_citations_open` / `get_references_open` → filter → `library_batch_add` |
| Dedup before adding | `library_search` with DOI or exact title — if found, skip |
| Export to Zotero | Without API key: `library_export_bibtex` → guide import. With key: `library_zotero_web_create` |

### search_* → library_* Integration

After search: present `paper_card` per result → user selects → `library_add_paper`
or `library_batch_add` → auto `task_link` if active project → tag with search topic.

---

## Related Research-Plugins Skills

Browse these subcategory indexes for fine-grained methodology skills:

- `literature/search/` — Boolean search, arXiv API, Semantic Scholar, citation chains
- `literature/metadata/` — DOI resolution, OpenCitations, impact factors
- `literature/fulltext/` — Unpaywall, OA strategies, preprint access
- `literature/discovery/` — paper recommendation, trend monitoring
- `tools/knowledge-graph/` — citation networks, knowledge graph construction
- `tools/scraping/` — web scraping for academic sources
- `tools/ocr-translate/` — OCR for scanned PDFs, multilingual translation
- `domains/` — 16 discipline-specific subcategories (ai-ml, biomedical, chemistry,
  cs, ecology, economics, education, finance, geoscience, humanities, law, math,
  pharma, physics, social-science, business). Browse `domains/{discipline}/` for
  domain-specific search strategies and database guides
