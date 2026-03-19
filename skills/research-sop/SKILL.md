---
name: Research SOP
description: Standard operating procedure for academic research tasks. Defines methodology, quality gates, and output standards for all research activities.
metadata: { "openclaw": { "always": true } }
---

# Research Standard Operating Procedure

This SOP applies to all research tasks. Follow these procedures to ensure
consistent quality and methodological rigor.

## Literature Search Protocol

### Search Scope

Before searching, state the search intent:
- **exploratory** — broad survey, cast a wide net
- **targeted** — specific question, precise query
- **exhaustive** — systematic review, all relevant databases

### Query Construction

Construct search queries with:
- Primary keywords (the core concept)
- Secondary keywords (methodological or domain constraints)
- Exclusion terms (what to filter out)
- Recency bias: default to last 5 years for active fields; extend to 10+ years
  for foundational or historical work.

### Three-Layer Search Architecture

Literature search uses a **priority fallback** model. Start from Layer 1; escalate
to Layer 2 or Layer 3 only when the previous layer cannot satisfy the request.

#### Layer 1 — Built-in API Tools (free, no auth, structured data)

These tools are always available and require NO API keys from the user.
Use them as the **primary search method** for all requests.

**General / Multi-discipline:**

| Tool | Coverage | Best for |
|:-----|:---------|:---------|
| `search_crossref` / `resolve_doi` | 150M+ DOIs | **Default first choice** — broadest DOI coverage |
| `search_openalex` / `get_work` / `get_author_openalex` | 250M+ works | All disciplines, institutions, topics. Rate-limited without API key (polite pool via User-Agent). |
| `search_europe_pmc` | 33M+ biomedical | Biomedical + full text + OA + citations |
| `search_doaj` | 9M+ verified OA | Guaranteed open access results |
| `search_openaire` | 170M+ records | EU-funded research, funder filtering |

**Domain-specific:**

| Tool | Coverage | Best for |
|:-----|:---------|:---------|
| `search_arxiv` / `get_arxiv_paper` | 2M+ preprints | CS, physics, math |
| `search_dblp` / `search_dblp_author` | 7M+ CS records | CS conferences + journals |
| `search_pubmed` / `get_article` | 36M+ citations | Medicine, biology |
| `search_biorxiv` / `search_medrxiv` | 400K+ preprints | Biology / medical preprints |
| `get_preprint_by_doi` | bioRxiv + medRxiv | Specific preprint lookup by DOI |

**Citation & Metadata:**

| Tool | Coverage | Best for |
|:-----|:---------|:---------|
| `get_citations_open` / `get_references_open` | 2B+ links | Citation tracking (all disciplines) |
| `get_citation_count` | OpenCitations | Quick citation count by DOI |
| `get_epmc_citations` / `get_epmc_references` | Europe PMC | Biomedical citation tracking |
| `find_oa_version` (Unpaywall) | 20M+ OA | Finding free PDFs by DOI |

**Supplementary (domain-specific, datasets, identity):**

| Tool | Coverage | Best for |
|:-----|:---------|:---------|
| `search_zenodo` / `get_zenodo_record` | 3M+ records | Datasets, software, supplementary materials |
| `search_orcid` / `get_orcid_works` | 18M+ scholars | Author disambiguation, publication lists |
| `search_inspire` / `get_inspire_paper` | 1.5M+ HEP papers | High-energy physics, astrophysics |
| `search_hal` | 4M+ French OA | French/European research |
| `search_osf_preprints` | 30+ preprint servers | Social science (SocArXiv), psychology (PsyArXiv) |
| `search_datacite` / `resolve_datacite_doi` | 50M+ dataset DOIs | Dataset DOI resolution |
| `search_ror` | 100K+ institutions | Institution disambiguation |

### Tool Filter Capability Matrix

Know what each tool CAN and CANNOT filter. This determines routing.

| Tool | Journal | Year | Author | OA | Sort options |
|:-----|:--------|:-----|:-------|:---|:-------------|
| `search_crossref` | ✅ `journal`/`issn` | ✅ `from_year`/`until_year` | ❌ (query only) | ❌ | relevance, published, cited-by |
| `search_openalex` | ❌ | ✅ `from_year`/`to_year` | ❌ (query only) | ✅ `open_access` | **relevance_score, publication_date, cited_by_count** |
| `search_europe_pmc` | ✅ `JOURNAL:` in query | ❌ (query only) | ✅ `AUTH:` in query | ❌ (returns flag) | RELEVANCE, DATE_DESC, CITED |
| `search_pubmed` | ✅ `[Journal]` in query | ✅ `min_date`/`max_date` | ✅ `[Author]` in query | ❌ | relevance, pub_date |
| `search_arxiv` | ✅ `cat:` (category) | ❌ | ✅ `au:` in query | N/A (all OA) | relevance, date |
| `search_dblp` | ❌ (returns venue) | ❌ | ❌ (separate tool) | ❌ | relevance only |
| `search_doaj` | ✅ field query | ✅ field query | ✅ field query | ✅ (all OA) | custom field |
| `search_openaire` | ❌ | ✅ `from_date`/`to_date` | ✅ `author` | ✅ `oa_only` | N/A |
| `search_biorxiv/medrxiv` | N/A (server=bio/med) | ✅ date interval | ❌ | N/A (all OA) | by date |
| `search_inspire` | ✅ SPIRES `j` field | ❌ | ✅ SPIRES `a` field | ❌ | mostrecent, mostcited |
| `search_hal` | ❌ | ✅ sort by date | ❌ (query only) | N/A (all OA) | producedDate |
| `search_osf_preprints` | ✅ `provider` filter | ❌ | ❌ | N/A (all OA) | N/A |
| `search_zenodo` | N/A | ❌ | ❌ | ✅ `access_right` | bestmatch, mostrecent |
| `search_datacite` | N/A | ✅ `from_year` | ❌ | ❌ | relevance |

### Domain → Tool Routing

**Do NOT** send queries to the wrong domain's tool.

| Domain | Primary Tools | NEVER use | Notes |
|:-------|:-------------|:----------|:------|
| **CS / AI / ML** | `search_dblp` + `search_arxiv` | — | dblp covers conferences; arXiv covers preprints |
| **Biomedical / Clinical** | `search_pubmed` + `search_europe_pmc` | `search_arxiv` | Use bioRxiv/medRxiv only for preprints |
| **Physics / Math** | `search_arxiv` + `search_inspire` | — | INSPIRE for high-energy physics |
| **Economics** | `search_crossref(journal=...)` | `search_arxiv` | Top-5: AER, QJE, JPE, Econometrica, REStud — all in CrossRef |
| **Social Sciences** | `search_osf_preprints(socarxiv)` + `search_crossref` | `search_arxiv` | SocArXiv for preprints |
| **Psychology** | `search_osf_preprints(psyarxiv)` + `search_pubmed` | — | PsyArXiv + PubMed |
| **Chemistry** | `search_crossref` | — | ChemRxiv blocked; use CrossRef + browser |
| **Engineering** | `search_osf_preprints(engrxiv)` + `search_crossref` | — | |
| **Earth Sciences** | `search_osf_preprints(eartharxiv)` + `search_crossref` | — | |
| **French/European** | `search_hal` + `search_openaire` | — | HAL for French; OpenAIRE for EU-funded |
| **Datasets / Software** | `search_zenodo` + `search_datacite` | — | |
| **Chinese Literature** | **Layer 2 Browser → CNKI** | All L1 tools | No free API covers Chinese journals |

### Recency Search Protocol

When the user asks for "最新", "latest", "recent", or "past N months/weeks" papers,
you **MUST** override default relevance sorting with date-based sorting.

**Per-tool recency parameters:**

| Tool | Sort param | Recency value | Date filter |
|:-----|:-----------|:-------------|:------------|
| `search_arxiv` | `sort_by` | `'submittedDate'` | — |
| `search_crossref` | `sort` | `'published'` | `from_year` / `until_year` |
| `search_openalex` | `sort_by` | `'publication_date'` | `from_year` / `to_year` |
| `search_pubmed` | — | — | `min_date` / `max_date` |
| `search_biorxiv/medrxiv` | — | date-ordered | `interval: 'YYYY-MM-DD/YYYY-MM-DD'` |
| `search_europe_pmc` | query prefix | `'SORT_DATE:y'` | — |
| `search_inspire` | — | `'mostrecent'` | — |
| `search_zenodo` | — | `'mostrecent'` | — |

**Recency search workflow:**
1. Determine time range: "最新" = last 3 months; "近期" = last 6 months; explicit
   range if stated.
2. Select 2+ sources by domain (see Domain→Tool Routing below).
3. Pass date-based sort **and** date filter where both are supported.
4. If API results are insufficient, escalate:
   - `web_fetch` arXiv RSS feed: `https://rss.arxiv.org/rss/{category}`
   - `browser` → Google Scholar with date filter (Tools → Custom range)
5. **Never** cite `web_search` / Brave Search unavailability as a reason to stop.

### Selection Logic (Decision Tree)

```
0. User asks for "latest/最新/recent" papers?
   → Follow Recency Search Protocol above. MUST pass date-based sort params.

1. User specifies a database NOT in L1?
   (CNKI, 万方, WoS, Scopus, Google Scholar, specific publisher site)
   → Go directly to Layer 2 Browser.

2. User specifies a journal name?
   → search_crossref({ query: "...", journal: "Nature" })
     + search_europe_pmc({ query: "JOURNAL:Nature AND ..." })
   → If L1 returns 0 (journal not indexed) → Layer 2 Browser.

3. Complex multi-filter query?
   (e.g., "2024年Nature上关于CRISPR的高被引论文")
   → Combine: search_crossref({ query: "CRISPR", journal: "Nature",
       from_year: 2024, sort: "is-referenced-by-count" })
   → If filters exceed any single tool's capability → decompose:
     a) Search with broadest tool (CrossRef), then
     b) Filter results locally (by year, citations, etc.)
   → If still insufficient → Layer 2 Browser (Google Scholar advanced search)

4. Simple keyword search?
   → Route by domain (see table above)
   → Always use at least 2 sources for targeted/exhaustive scope

5. L1 returns 0 or very few results for a reasonable query?
   → Report to user, suggest broadening keywords
   → Offer Layer 2 Browser or web_fetch (direct URL) as alternative
   → Do NOT blindly retry the same source
   → Do NOT cite "web_search not configured" as a blocker
```

### L1 → L2 Escalation Rules

Use Layer 2 Browser when:
- User explicitly asks for a database without L1 API (CNKI, WoS, Scopus, Google Scholar)
- L1 returns 0 results for a journal-specific query (journal not indexed)
- User needs full-text behind a paywall (browser can use institutional access)
- The query requires faceted search or complex UI interactions
- User needs to browse a conference proceedings website

Do NOT use Layer 2 for:
- Simple keyword searches (L1 is faster and more reliable)
- DOI resolution (always L1: `resolve_doi`)
- Citation tracking (always L1: `get_citations_open`)

### Source Health Awareness

Every tool response includes `_source_health: { source, latency_ms }`.

**Within a session:** If a source returns errors (429, 503, timeout) more than twice,
stop using it for the rest of the session. Use alternative sources from the same
domain (see routing table above).

**Across sessions:** When a source has been persistently unreliable (3+ consecutive
sessions with failures), record in MEMORY.md:
```
Source {name} has been unreliable since {date}: {error pattern}.
Prefer {alternative} for {domain} queries until verified recovered.
```
Check MEMORY.md at session start for any degraded source notes.

Always search **at least two sources** for targeted/exhaustive scopes.

#### Layer 2 — Browser RPA (covers databases without public APIs)

When Layer 1 tools cannot reach the required database, use the OpenClaw `browser`
tool to perform web-based search. This is the **universal fallback** — any
web-accessible academic database can be searched this way.

**When to use:**
- Google Scholar (no public API; broadest index including grey literature)
- CNKI / 万方 / 维普 (Chinese academic databases)
- Web of Science / Scopus (institutional access required)
- IEEE Xplore, ACM DL, SpringerLink (publisher databases)
- Any database the user specifically requests

**Standard workflow (academic database search):**

**IMPORTANT:** Never pass `profile` parameter to the browser tool. Omitting it
uses the default managed browser (`openclaw`). Passing `profile="chrome"` or
other invalid names causes HTTP 404.

```
1. browser action=open url="<database URL>"
2. browser action=snapshot mode=efficient
   → Read page structure (compact, ~10K chars instead of 80K)
   → Note the targetId from the response
3. browser action=act kind=type ref="<ref>" text="<query>" targetId="<targetId>"
4. browser action=act kind=click ref="<submit-ref>" targetId="<targetId>"
5. browser action=snapshot mode=efficient
   → Extract titles, authors, dates from the results text
   → Do NOT click into individual papers
6. Parse results → library_add_paper or report to user
7. browser action=close
```

**Critical parameters for academic pages:**

- **Always use `mode=efficient`** for snapshots. This sets `interactive=true`,
  `compact=true`, `depth=6`, `maxChars=10000` — reducing snapshot size from
  80,000 chars (default) to ~10,000 chars. Without this, a single snapshot of
  CNKI or Google Scholar will overflow the model context.
- **Always pass `targetId`** from the snapshot response into subsequent `act`
  calls. Omitting it causes "tab not found" errors.
- **Use `interactive=true`** (included in efficient mode) to show only clickable
  elements, hiding decorative DOM nodes.

**Error recovery:**

1. **"Element not found"** → Take ONE fresh `snapshot mode=efficient`. Use the
   new ref. If it fails again, extract what you have and stop.
2. **"Tab not found"** → Run `browser action=tabs` to get active targetIds.
   Use the returned targetId in subsequent calls.
3. **Context overflow** → You took too many snapshots. Extract what you have
   from the last successful snapshot and close the browser.

**Hard rules:**

1. **Max 3 snapshots** per browser session. Extract results on the FIRST
   results snapshot.
2. **Never paginate** — 1 page of results (10–20 papers) is sufficient.
   For more, suggest L1 API tools with different keywords.
3. **Never click into individual papers** from browser. Use `resolve_doi`
   or `web_fetch` to get paper details after extracting DOIs/titles.
4. **Always close browser** when done (`browser action=close`).

**Important:** Browser search is slower, less structured, and context-heavy.
Always try Layer 1 and Layer 1.5 first. Use browser only when the specific
database matters or when those layers return insufficient results.

#### Layer 1.5 — `web_fetch` Direct Access (no API key, faster than browser)

Between L1 API tools and L2 browser, you can use `web_fetch` to directly access
known URLs. This is faster than browser and requires no API keys.

**Useful direct URLs:**
- **arXiv RSS** (latest papers by category): `https://rss.arxiv.org/rss/cs.CV`
- **arXiv API** (structured query): `https://export.arxiv.org/api/query?search_query=ti:transformer&sortBy=submittedDate&sortOrder=descending&max_results=20`
- **PubMed RSS**: subscribe URLs from PubMed search results
- **Conference pages**: known proceedings URLs (NeurIPS, ICML, ACL, etc.)
- **Preprint server pages**: bioRxiv/medRxiv collection pages

**When to use `web_fetch` instead of `browser`:**
- You know the exact URL (no search interaction needed)
- The page is static HTML (no JavaScript rendering required)
- You want to extract content from a specific paper/article page

**When to use `browser` instead:**
- The target requires form interaction (search box, filters, pagination)
- The page requires JavaScript rendering (Google Scholar, publisher sites)
- You need to navigate through multiple pages

#### Layer 3 — API Key Required (optional, user configures)

These tools require the user to register and provide an API key. Do NOT prompt or
push users to register. Only use when the user has already configured access.

**Wentor Official API** (wentor.ai account):
- `wentor_qa` — semantic paper Q&A search (natural language, AMiner-powered)
- `wentor_search` — structured field search (title, keyword, author, org, venue)
- Best for: Chinese academic literature, semantic search

**OpenAlex** (optional API key at openalex.org):
- `search_openalex` / `get_work` / `get_author_openalex` — also listed in L1 above
- **Works without API key** via polite pool (User-Agent identification)
- With API key: higher rate limits, priority access
- Best for: broadest coverage, author/institution metadata, topic classification
- L1 usage is sufficient for normal research; L3 key improves throughput for heavy use

**Third-party API keys:** If a user needs specialized services (Serper, Tavily,
etc.), they can install the corresponding skill or MCP themselves. Never ask users
to register for third-party API keys as part of the default search workflow.

### Post-Search Processing

1. **Deduplicate** — check DOI / arXiv ID against local library before adding.
2. **Rate relevance** — high / medium / low. Only add high + medium to library.
3. **Batch import** — use `library_batch_add` for 3+ papers.
4. **Tag immediately** — apply topic tags at import time for future retrieval.

## Paper Evaluation Criteria

When assessing a paper's quality and relevance:

- **Venue quality:** Is it published in a reputable journal/conference?
- **Citation count:** Adjusted for publication age (citations per year).
- **Methodology:** Is the approach sound? Sample size adequate? Controls present?
- **Reproducibility:** Are methods described in sufficient detail?
- **Relevance:** Does it directly address the user's research question?

Rate each paper: **high**, **medium**, or **low** relevance. Only add **high**
and **medium** papers to the library unless the user requests otherwise.

## Citation Integrity Rules

1. Every cited paper must exist in the local library or be verifiable via DOI.
2. Cite the primary source, not a secondary reference, unless the primary is
   genuinely inaccessible.
3. When paraphrasing, cite the source. When quoting, use quotation marks and
   provide page numbers if available.
4. If asked to add a citation and you cannot verify the paper exists, say so.
   Do not approximate or guess.

## Writing Quality Standards

When drafting or editing academic text:

1. **Clarity:** Prefer active voice. One idea per sentence. Define acronyms on
   first use.
2. **Precision:** Use exact numbers, not "many" or "several." Specify units.
3. **Structure:** Follow the IMRaD structure (Introduction, Methods, Results,
   Discussion) unless the user specifies otherwise.
4. **Tone:** Academic third person by default. First person plural ("we") for
   multi-author papers. Adjust per user preference.
5. **Transitions:** Each paragraph should logically flow from the previous one.
   Use signpost phrases ("However," "In contrast," "Building on this,").

## Tool vs. Skill Priority

Resolve user requests using this priority chain:

1. **API tools first.** For literature search, use Layer 1 API tools (see Search
   Architecture above). For library management, use `library_*` tools. For tasks,
   use `task_*`. For workspace, use `workspace_*`. For monitoring, use `monitor_*`.
   Tools execute actions directly.
2. **Browser RPA second.** When API tools cannot reach the target database or when
   the user requests a specific web-based source, use the `browser` tool (Layer 2).
3. **Skills for methodology.** Route to skills when the user needs a workflow, best
   practice, or domain-specific guidance that no tool provides.
4. **Combine when needed.** A single request may need both a tool (for execution)
   and a skill (for methodology). Use both.
5. **Wentor API as enhancement.** If the user has configured Wentor API access, it
   supplements Layer 1 tools. Never block on it being unavailable.

## Cross-Category Research Patterns

Common requests span multiple skill categories. Use these combinations:

| User intent | Skill combination |
|:-----------|:-----------------|
| Literature review | literature/search + writing/composition |
| Data analysis report | analysis/statistics + analysis/dataviz |
| Submission preparation | writing/templates + writing/latex + writing/citation |
| Systematic review | research/deep-research + research/methodology |
| Entering a new field | domains/{field} |
| Grant writing | research/funding + writing/composition |

## Workspace Integration

All research outputs MUST be persisted to the workspace. Never leave important
content only in chat messages.

### Output Patterns

| Research activity | Save to | Example filename |
|:-----------------|:--------|:-----------------|
| Literature review | `outputs/drafts/` | `literature-review-{topic}.md` |
| Paper reading notes | `outputs/notes/` | `{paper-short-title}-notes.md` |
| Data analysis results | `outputs/reports/` | `analysis-{dataset}.md` |
| Monitor scan findings | `outputs/monitor/` | `monitor-scan-{date}.md` |
| Weekly/progress report | `outputs/reports/` | `weekly-report-{date}.md` |
| BibTeX export | `outputs/exports/` | `bibliography-{project}.bib` |
| Figures/plots | `outputs/figures/` | `fig-{description}.{ext}` |

### Task-File Linking

When a task produces an output file:

1. Save the file with `workspace_save`
2. Link the file to the task with `task_link_file(task_id, file_path)`
3. Complete the task with `task_complete(id, notes: "Output: outputs/...")`

### Session Continuity

At session start, the `[Research-Claw]` context shows library stats and task
overview. When resuming prior work, also check:

- `workspace_history` — recent file changes
- `workspace_list` — current workspace contents
- `task_list` — active and upcoming tasks

## Error Handling

When a tool call fails or returns unexpected results:

1. Report the error clearly to the user.
2. Suggest an alternative approach if available.
3. Do not retry more than twice without user input.
4. Log the error context for debugging.

## Session Closing

At the end of a productive session:

1. Offer to save any important output to the workspace with `workspace_save`.
2. Summarize what was accomplished (briefly).
3. Update `MEMORY.md` with key decisions and findings.
4. Remind the user of upcoming deadlines if any exist within 48 hours.
