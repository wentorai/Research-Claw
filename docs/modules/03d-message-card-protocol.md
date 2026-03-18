# C3d — Message Card Protocol

> **Module**: Dashboard Chat Rendering
> **Status**: Draft v1.0
> **Last Updated**: 2026-03-11
> **Depends On**: C3a (Dashboard Shell), C2a (Agent Core)

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Convention Format](#2-convention-format)
3. [Card Type Registry](#3-card-type-registry)
4. [JSON Schema Definitions](#4-json-schema-definitions)
5. [Parser Implementation](#5-parser-implementation)
6. [Dashboard Renderer Mapping](#6-dashboard-renderer-mapping)
7. [Fallback Behavior](#7-fallback-behavior)
8. [Agent Instructions](#8-agent-instructions)
9. [Extensibility](#9-extensibility)

---

## 1. Design Philosophy

The Message Card Protocol bridges agent output and Dashboard UI without introducing
a proprietary transport layer. It rests on four principles:

**Markdown-native output.** The agent writes standard Markdown. Structured data
lives inside fenced code blocks, exactly where a human reader would expect to find
it. No custom XML tags, no invisible metadata, no binary framing.

**Language tag as card type.** The fenced code block's language identifier doubles
as a card type discriminator. The Dashboard's Markdown renderer checks each code
block's language tag against a known registry. Recognized tags trigger rich card
rendering; everything else passes through to the default syntax-highlighted code
block.

**Readable fallback in plain terminals.** When the agent's output is viewed in a
terminal, VS Code preview, or any Markdown renderer that does not know about
Research-Claw card types, the user sees a labeled JSON block. The language tag
(e.g., `paper_card`) provides context, and the JSON payload is formatted for
human scanning. No information is lost.

**Graceful degradation.** Three failure modes are handled identically — unknown
card type, malformed JSON, and missing required fields — all produce a default
code block with syntax highlighting. The renderer never crashes, never swallows
content, and never shows an empty placeholder where text should be.

### Why Not a Custom Protocol?

Alternatives were considered and rejected:

| Alternative | Rejection Reason |
|---|---|
| HTML `<div data-card="...">` | Stripped by most Markdown renderers; agent models unreliable at generating valid HTML |
| Inline JSON with `<!-- card: ... -->` | Invisible in plain renderers; easy for models to malform |
| Dedicated `/card` API endpoint | Breaks the streaming conversation model; adds latency |
| Custom Markdown directives (`:::`) | Not part of CommonMark; parser support fragmented |

Fenced code blocks with JSON payloads are the most portable, model-friendly, and
debuggable format available.

---

## 2. Convention Format

### Basic Structure

The agent emits a fenced code block where the language tag is the card type and
the body is a single JSON object:

````markdown
Here are the top papers from your monitor scan:

```paper_card
{
  "title": "Attention Is All You Need",
  "authors": ["Vaswani, A.", "Shazeer, N.", "Parmar, N."],
  "venue": "NeurIPS 2017",
  "doi": "10.48550/arXiv.1706.03762",
  "abstract_preview": "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...",
  "read_status": "unread"
}
```

This paper introduced the Transformer architecture that underpins most modern LLMs.
````

### Rules

1. **One JSON object per fenced block.** Arrays are not permitted at the top level.
   To show multiple papers, use multiple `paper_card` blocks.

2. **Valid JSON only.** No trailing commas, no single-quoted strings, no comments.
   The parser uses `JSON.parse()` directly.

3. **Cards supplement prose.** A card block must never be the entire message. The
   agent writes natural-language context before and/or after each card. The card
   is a visual enhancement, not a replacement for explanation.

4. **Language tag must be lowercase, alphanumeric, with underscores.** Pattern:
   `/^[a-z][a-z0-9_]*$/`. Tags that do not match this pattern are treated as
   standard programming language identifiers and rendered with syntax highlighting.

5. **No nesting.** Card blocks cannot contain other fenced code blocks. The JSON
   payload is flat (may contain nested objects/arrays in its own schema, but the
   fenced block itself is not nested).

6. **Whitespace is insignificant.** The JSON may be pretty-printed or minified.
   Pretty-printing is preferred for terminal readability.

### Multiple Cards in One Message

```markdown
I found two relevant papers and created a follow-up task:

```paper_card
{"title": "BERT: Pre-training of Deep Bidirectional Transformers", "authors": ["Devlin, J."], "venue": "NAACL 2019", "doi": "10.18653/v1/N19-1423"}
```

```paper_card
{"title": "RoBERTa: A Robustly Optimized BERT Pretraining Approach", "authors": ["Liu, Y."], "venue": "arXiv 2019", "arxiv_id": "1907.11692"}
```

I've also added a reading task for these:

```task_card
{"title": "Read BERT and RoBERTa papers", "task_type": "human", "status": "todo", "priority": "medium", "deadline": "2026-03-15T23:59:00Z"}
```
```

The Dashboard renders each card inline at its position in the message flow.

---

## 3. Card Type Registry

Six custom card types are defined in v1.0. Each has a TypeScript interface that serves
as the source of truth for both the parser and the renderer.

### 3.1 `paper_card`

Represents a single academic paper. The most frequently used card type.

```typescript
interface PaperCard {
  type: 'paper_card';

  /** Full paper title. Required. */
  title: string;

  /** List of author names, in citation order. Required. */
  authors: string[];

  /** Publication venue (journal, conference, preprint server). */
  venue?: string;

  /** Publication year as a four-digit integer. */
  year?: number;

  /** Digital Object Identifier, without the https://doi.org/ prefix. */
  doi?: string;

  /** Direct URL to the paper (publisher page, PDF, or preprint). */
  url?: string;

  /** arXiv identifier, e.g., "2301.07041" or "2301.07041v2". */
  arxiv_id?: string;

  /** First ~200 characters of the abstract. Truncated with "..." if needed. */
  abstract_preview?: string;

  /** User's reading status for this paper. */
  read_status?: 'unread' | 'reading' | 'read' | 'reviewed';

  /** Internal library ID if the paper is already in the user's library. */
  library_id?: string;

  /** User-assigned or agent-suggested topic tags. */
  tags?: string[];
}
```

**Dashboard Actions:**

| Action | Behavior |
|---|---|
| Add to Library | Calls `library.add` via WS RPC; disabled if `library_id` present |
| Open PDF | Opens `url` or constructs `https://arxiv.org/pdf/{arxiv_id}` in system browser |
| Cite | Copies BibTeX citation to clipboard (constructed from available fields) |
| View Details | Opens paper detail panel in the Dashboard sidebar |

**When to use:** Whenever the agent references a specific paper — search results,
recommendations, citation lookups, monitor digests (as nested items), or reading
list summaries.

---

### 3.2 `task_card`

Represents a research task that may be performed by the human, the agent, or both.

```typescript
interface TaskCard {
  type: 'task_card';

  /** Internal task ID. Omitted when the agent is proposing a new task. */
  id?: string;

  /** Short task title. Required. */
  title: string;

  /** Longer description with context or instructions. */
  description?: string;

  /** Who performs this task. */
  task_type: 'human' | 'agent' | 'mixed';

  /** Current status. Required. */
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

  /** Priority level. Required. */
  priority: 'urgent' | 'high' | 'medium' | 'low';

  /** Deadline in ISO 8601 format. */
  deadline?: string;

  /** Title of a related paper, for cross-referencing. */
  related_paper_title?: string;
}
```

**Dashboard Actions:**

| Action | Behavior |
|---|---|
| View in Panel | Opens the task in the research planner sidebar panel |
| Mark Complete | Sets `status` to `done` via WS RPC and updates the card in place |
| Edit | Opens an inline editor for title, description, priority, and deadline |

**When to use:** Task creation, status updates, daily planning summaries, or when
the agent proposes work that needs human confirmation.

---

### 3.3 `progress_card`

Summarizes research activity over a time period. Typically generated by the
heartbeat cron job or on explicit request ("How did my week go?").

```typescript
interface ProgressCard {
  type: 'progress_card';

  /** Time period this summary covers. Required. */
  period: string;  // "today" | "this_week" | "this_month" | "session" | custom label

  /** Number of papers marked as read (status changed to 'read' or 'reviewed'). */
  papers_read: number;

  /** Number of papers added to the library. */
  papers_added: number;

  /** Number of tasks moved to 'done' status. */
  tasks_completed: number;

  /** Number of new tasks created. */
  tasks_created: number;

  /** Word count written in drafts/notes during the period. */
  writing_words?: number;

  /** Estimated reading time in minutes. */
  reading_minutes?: number;

  /** List of notable achievements or milestones. Max 5 items. */
  highlights?: string[];
}
```

**Dashboard Actions:** None (display-only). The card renders as a compact
stats grid with optional highlight bullets below.

**When to use:** Heartbeat summaries, end-of-session recaps, weekly digests,
or when the user asks for a progress report.

---

### 3.4 `approval_card`

Requests human approval before the agent takes a consequential action. Maps
directly to the `exec.approval.requested` event in the OpenClaw approval system.

```typescript
interface ApprovalCard {
  type: 'approval_card';

  /** Human-readable description of the proposed action. Required. */
  action: string;

  /** Why the agent wants to perform this action. Required. */
  context: string;

  /** Risk assessment. Required. */
  risk_level: 'low' | 'medium' | 'high';

  /** Structured details about the action (command args, file paths, etc.). */
  details?: Record<string, unknown>;

  /**
   * Maps to the exec.approval.requested event ID.
   * When present, Approve/Reject buttons send responses back through
   * the exec-approvals WebSocket.
   */
  approval_id?: string;
}
```

**Dashboard Actions:**

| Action | Behavior |
|---|---|
| Approve | Sends approval via exec-approvals WS; card updates to show "Approved" badge |
| Reject | Sends rejection; card updates to show "Rejected" badge |
| Ask for Details | Appends a follow-up message asking the agent to elaborate |

**Risk Level Rendering:**

| Level | Visual Treatment |
|---|---|
| `low` | Green left border, no icon |
| `medium` | Amber left border, caution icon |
| `high` | Red left border, warning icon, pulsing glow |

**When to use:** Before executing shell commands not in the allowlist, before
modifying files outside the workspace, before sending network requests to
external services, or any action flagged by `exec-approvals`.

---

### 3.5 `monitor_digest`

Summarizes results from an automated literature monitor scan. Produced by the
monitor system or scheduled scan jobs.

```typescript
interface MonitorDigest {
  type: 'monitor_digest';

  /** Data source for the scan. Required. */
  source: string;  // "arxiv" | "semantic_scholar" | "pubmed" | "custom"

  /** The search query or topic that was tracked. Required. */
  query: string;

  /** Time window the scan covered, e.g., "last 24h" or "2026-03-01 to 2026-03-07". */
  period: string;

  /** Total number of new papers found matching the query. */
  total_found: number;

  /** Top papers selected by relevance. Max 10 items recommended. */
  notable_papers: NotablePaper[];
}

interface NotablePaper {
  /** Paper title. Required. */
  title: string;

  /** Author list. Required. */
  authors: string[];

  /** Why the agent considers this paper notable for the user. */
  relevance_note: string;
}
```

**Dashboard Actions:** The digest card itself has no actions, but each
`notable_paper` entry renders a mini row with an "Expand" button that creates
a full `paper_card` in the chat.

**When to use:** Automated monitor results, topic-tracking digests, or when the
user asks "What's new in [topic]?"

---

### 3.6 `file_card`

Represents a file in the research workspace. Used when the agent creates,
modifies, or references a specific file.

```typescript
interface FileCard {
  type: 'file_card';

  /** File name (basename, not full path). Required. */
  name: string;

  /** Path relative to the workspace root. Required. */
  path: string;

  /** File size in bytes. */
  size_bytes?: number;

  /** MIME type, e.g., "application/pdf" or "text/markdown". */
  mime_type?: string;

  /** Creation timestamp in ISO 8601. */
  created_at?: string;

  /** Last modification timestamp in ISO 8601. */
  modified_at?: string;

  /** Git status of the file relative to HEAD. */
  git_status?: 'new' | 'modified' | 'committed';
}
```

**Dashboard Actions:**

| Action | Behavior |
|---|---|
| Open | Opens the file in the system's default application |
| Download | Triggers a browser download (for remote dashboard sessions) |
| View Diff | Opens a git diff view if `git_status` is `modified` |

**When to use:** After creating or modifying files (drafts, analysis scripts,
data exports), when referencing attachments, or in workspace inventory summaries.

---

### 3.7 `code_block` (Passthrough)

This is NOT a custom card type. Standard fenced code blocks with a recognized
programming language identifier (`python`, `typescript`, `bash`, `r`, `julia`,
`latex`, etc.) are rendered with syntax highlighting and enhanced action buttons.

```typescript
// This is standard Markdown — no special interface needed.
// The Dashboard adds action buttons to all syntax-highlighted code blocks:
//
//   [Copy]     — copies code content to clipboard
//   [Save]     — saves to a file (prompts for filename)
//   [Run]      — (if language is in executable set) sends to agent for execution
```

The renderer distinguishes between card types and programming languages using the
card type registry. If the language tag is in the registry, it is treated as a
card. If it matches a known programming language (via a standard list of ~100
language identifiers from Prism.js / highlight.js), it is rendered as a code
block with syntax highlighting. If it matches neither, it is rendered as a plain
code block.

**Priority order:**
1. Card type registry (exact match) -> rich card
2. Programming language list (exact match) -> syntax-highlighted code + actions
3. Unknown tag -> plain code block, no highlighting

---

## 4. JSON Schema Definitions

Formal JSON Schema (draft 2020-12) for validation. These schemas are used by the
parser to validate payloads before attempting to render a card.

### 4.1 `paper_card` Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wentor.ai/schemas/cards/paper_card.json",
  "title": "PaperCard",
  "type": "object",
  "required": ["title", "authors"],
  "properties": {
    "type": {
      "type": "string",
      "const": "paper_card"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "authors": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1,
      "maxItems": 100
    },
    "venue": {
      "type": "string",
      "maxLength": 200
    },
    "year": {
      "type": "integer",
      "minimum": 1900,
      "maximum": 2100
    },
    "doi": {
      "type": "string",
      "pattern": "^10\\..+"
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "arxiv_id": {
      "type": "string",
      "pattern": "^\\d{4}\\.\\d{4,5}(v\\d+)?$"
    },
    "abstract_preview": {
      "type": "string",
      "maxLength": 300
    },
    "read_status": {
      "type": "string",
      "enum": ["unread", "reading", "read", "reviewed"]
    },
    "library_id": {
      "type": "string"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 20
    }
  },
  "additionalProperties": false
}
```

### 4.2 `task_card` Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wentor.ai/schemas/cards/task_card.json",
  "title": "TaskCard",
  "type": "object",
  "required": ["title", "task_type", "status", "priority"],
  "properties": {
    "type": {
      "type": "string",
      "const": "task_card"
    },
    "id": {
      "type": "string"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "task_type": {
      "type": "string",
      "enum": ["human", "agent", "mixed"]
    },
    "status": {
      "type": "string",
      "enum": ["todo", "in_progress", "blocked", "done", "cancelled"]
    },
    "priority": {
      "type": "string",
      "enum": ["urgent", "high", "medium", "low"]
    },
    "deadline": {
      "type": "string",
      "format": "date-time"
    },
    "related_paper_title": {
      "type": "string",
      "maxLength": 500
    }
  },
  "additionalProperties": false
}
```

### 4.3 `progress_card` Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wentor.ai/schemas/cards/progress_card.json",
  "title": "ProgressCard",
  "type": "object",
  "required": ["period", "papers_read", "papers_added", "tasks_completed", "tasks_created"],
  "properties": {
    "type": {
      "type": "string",
      "const": "progress_card"
    },
    "period": {
      "type": "string",
      "minLength": 1,
      "maxLength": 50
    },
    "papers_read": {
      "type": "integer",
      "minimum": 0
    },
    "papers_added": {
      "type": "integer",
      "minimum": 0
    },
    "tasks_completed": {
      "type": "integer",
      "minimum": 0
    },
    "tasks_created": {
      "type": "integer",
      "minimum": 0
    },
    "writing_words": {
      "type": "integer",
      "minimum": 0
    },
    "reading_minutes": {
      "type": "integer",
      "minimum": 0
    },
    "highlights": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 5
    }
  },
  "additionalProperties": false
}
```

### 4.4 `approval_card` Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wentor.ai/schemas/cards/approval_card.json",
  "title": "ApprovalCard",
  "type": "object",
  "required": ["action", "context", "risk_level"],
  "properties": {
    "type": {
      "type": "string",
      "const": "approval_card"
    },
    "action": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "context": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "risk_level": {
      "type": "string",
      "enum": ["low", "medium", "high"]
    },
    "details": {
      "type": "object"
    },
    "approval_id": {
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

### 4.5 `monitor_digest` Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wentor.ai/schemas/cards/monitor_digest.json",
  "title": "MonitorDigest",
  "type": "object",
  "required": ["source", "query", "period", "total_found", "notable_papers"],
  "properties": {
    "type": {
      "type": "string",
      "const": "monitor_digest"
    },
    "source": {
      "type": "string",
      "minLength": 1
    },
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "period": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "total_found": {
      "type": "integer",
      "minimum": 0
    },
    "notable_papers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "authors", "relevance_note"],
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1
          },
          "authors": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1
          },
          "relevance_note": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          }
        },
        "additionalProperties": false
      },
      "maxItems": 10
    }
  },
  "additionalProperties": false
}
```

### 4.6 `file_card` Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://wentor.ai/schemas/cards/file_card.json",
  "title": "FileCard",
  "type": "object",
  "required": ["name", "path"],
  "properties": {
    "type": {
      "type": "string",
      "const": "file_card"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 255
    },
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000
    },
    "size_bytes": {
      "type": "integer",
      "minimum": 0
    },
    "mime_type": {
      "type": "string"
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    },
    "modified_at": {
      "type": "string",
      "format": "date-time"
    },
    "git_status": {
      "type": "string",
      "enum": ["new", "modified", "committed"]
    }
  },
  "additionalProperties": false
}
```

---

## 5. Parser Implementation

### 5.1 Extraction Pipeline

The card parser operates as a custom plugin in the Dashboard's Markdown rendering
pipeline. It runs after the Markdown is parsed into an AST but before React
components are rendered.

```
Agent Message (Markdown string)
  |
  v
Markdown AST (remark/unified)
  |
  v
Walk AST for `code` nodes
  |
  v
For each code node:
  |-- lang tag in CARD_REGISTRY? -------> Parse JSON -> Validate -> Render Card
  |-- lang tag in LANG_LIST? -----------> Syntax highlight + action buttons
  |-- else -----------------------------> Plain code block
```

### 5.2 Card Registry Constant

```typescript
/**
 * Known card types. Used for language tag matching.
 * Order does not matter — lookup is via Set.has().
 */
const CARD_TYPE_REGISTRY = new Set([
  'paper_card',
  'task_card',
  'progress_card',
  'approval_card',
  'monitor_digest',
  'file_card',
] as const);

type CardType = typeof CARD_TYPE_REGISTRY extends Set<infer T> ? T : never;
```

### 5.3 Regex-Based Extraction (Fallback)

For environments where AST-based parsing is not available (e.g., unit tests,
server-side rendering), a regex-based extractor is provided:

```typescript
/**
 * Extracts card blocks from raw Markdown text.
 * Returns an array of { type, json, startIndex, endIndex } objects.
 *
 * Note: This regex handles the common case. Edge cases (nested triple-backticks
 * in JSON string values) are rare enough to accept as a known limitation.
 */
function extractCardBlocks(markdown: string): CardBlockMatch[] {
  const CARD_BLOCK_RE = /^```(\w+)\n([\s\S]*?)^```$/gm;
  const matches: CardBlockMatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = CARD_BLOCK_RE.exec(markdown)) !== null) {
    const langTag = match[1];
    if (!CARD_TYPE_REGISTRY.has(langTag as CardType)) {
      continue;
    }
    matches.push({
      type: langTag as CardType,
      json: match[2].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return matches;
}

interface CardBlockMatch {
  type: CardType;
  json: string;
  startIndex: number;
  endIndex: number;
}
```

### 5.4 JSON Parsing and Validation

```typescript
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Schema imports
import paperCardSchema from '../schemas/paper_card.json';
import taskCardSchema from '../schemas/task_card.json';
import progressCardSchema from '../schemas/progress_card.json';
import approvalCardSchema from '../schemas/approval_card.json';
import monitorDigestSchema from '../schemas/monitor_digest.json';
import fileCardSchema from '../schemas/file_card.json';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validators: Record<CardType, ReturnType<typeof ajv.compile>> = {
  paper_card: ajv.compile(paperCardSchema),
  task_card: ajv.compile(taskCardSchema),
  progress_card: ajv.compile(progressCardSchema),
  approval_card: ajv.compile(approvalCardSchema),
  monitor_digest: ajv.compile(monitorDigestSchema),
  file_card: ajv.compile(fileCardSchema),
};

/**
 * Attempts to parse and validate a card block's JSON payload.
 *
 * Returns the parsed object on success, or null on failure.
 * Failures are logged at debug level but never thrown.
 */
function parseCardPayload(
  type: CardType,
  jsonString: string
): Record<string, unknown> | null {
  // Step 1: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    console.debug(`[card-parser] Invalid JSON in ${type} block:`, err);
    return null;
  }

  // Step 2: Must be a plain object
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.debug(`[card-parser] ${type} block is not a JSON object`);
    return null;
  }

  // Step 3: Validate against schema
  const validate = validators[type];
  if (validate && !validate(parsed)) {
    console.debug(
      `[card-parser] ${type} validation failed:`,
      validate.errors
    );
    return null;
  }

  return parsed as Record<string, unknown>;
}
```

### 5.5 Streaming Considerations

Agent messages arrive as a stream of tokens. The parser must handle partial
fenced blocks during streaming:

1. **During streaming:** Code blocks are buffered until the closing ``` is
   received. While buffering, the Dashboard shows a "loading" skeleton card
   with the type label visible.

2. **On stream completion:** The full block is parsed. If valid, the skeleton
   is replaced with the rendered card. If invalid, the skeleton is replaced
   with a plain code block.

3. **On stream interruption:** If the stream ends without a closing ```, the
   partial content is rendered as a plain code block with a "truncated" badge.

---

## 6. Dashboard Renderer Mapping

### 6.1 Component Registry

| Card Type | React Component | File Path |
|---|---|---|
| `paper_card` | `<PaperCard>` | `dashboard/src/components/chat/cards/PaperCard.tsx` |
| `task_card` | `<TaskCard>` | `dashboard/src/components/chat/cards/TaskCard.tsx` |
| `progress_card` | `<ProgressCard>` | `dashboard/src/components/chat/cards/ProgressCard.tsx` |
| `approval_card` | `<ApprovalCard>` | `dashboard/src/components/chat/cards/ApprovalCard.tsx` |
| `monitor_digest` | `<MonitorDigest>` | `dashboard/src/components/chat/cards/MonitorDigest.tsx` |
| `file_card` | `<FileCard>` | `dashboard/src/components/chat/cards/FileCard.tsx` |

### 6.2 Component Resolver

```typescript
import { lazy, type ComponentType } from 'react';

/**
 * Lazy-loaded component map. Each card component is loaded only when
 * first encountered in a message, keeping the initial bundle small.
 */
const CARD_COMPONENTS: Record<CardType, ComponentType<{ data: any }>> = {
  paper_card: lazy(() => import('./cards/PaperCard')),
  task_card: lazy(() => import('./cards/TaskCard')),
  progress_card: lazy(() => import('./cards/ProgressCard')),
  approval_card: lazy(() => import('./cards/ApprovalCard')),
  monitor_digest: lazy(() => import('./cards/MonitorDigest')),
  file_card: lazy(() => import('./cards/FileCard')),
};

/**
 * Resolves a card type to its React component.
 * Returns null for unknown types (the caller renders a code block instead).
 */
function resolveCardComponent(
  type: string
): ComponentType<{ data: any }> | null {
  if (CARD_TYPE_REGISTRY.has(type as CardType)) {
    return CARD_COMPONENTS[type as CardType];
  }
  return null;
}
```

### 6.3 Integration with Markdown Renderer

The Markdown renderer uses a custom `code` component override:

```tsx
import { Suspense } from 'react';
import { resolveCardComponent } from './cardResolver';
import { parseCardPayload } from './cardParser';
import { CodeBlock } from './CodeBlock';
import { CardSkeleton } from './CardSkeleton';

/**
 * Custom renderer for fenced code blocks in chat messages.
 * Intercepts card-type language tags and renders rich cards.
 */
function ChatCodeBlock({
  className,
  children,
}: {
  className?: string;
  children: string;
}) {
  // Extract language from className (remark convention: "language-xxx")
  const lang = className?.replace('language-', '') ?? '';
  const CardComponent = resolveCardComponent(lang);

  if (!CardComponent) {
    // Not a card type — render as syntax-highlighted code block
    return <CodeBlock language={lang} code={children} />;
  }

  // Attempt to parse and validate the JSON payload
  const data = parseCardPayload(lang as CardType, children);

  if (!data) {
    // Invalid JSON or schema validation failed — fall back to code block
    return <CodeBlock language={lang} code={children} />;
  }

  // Render the card component inside a Suspense boundary
  return (
    <Suspense fallback={<CardSkeleton type={lang} />}>
      <CardComponent data={data} />
    </Suspense>
  );
}
```

### 6.4 Card Visual Design Principles

All card components follow the HashMind dark terminal aesthetic:

- **Background:** `var(--surface-card)` (`#1a1a2e` default dark)
- **Border:** 1px `var(--border-subtle)` with a colored left accent (4px)
- **Left accent colors by type:**
  - `paper_card`: Academic Blue (`#3B82F6`)
  - `task_card`: Amber (`#F59E0B`)
  - `progress_card`: Emerald (`#10B981`)
  - `approval_card`: Varies by `risk_level` (green / amber / red)
  - `monitor_digest`: Purple (`#8B5CF6`)
  - `file_card`: Neutral (`#6B7280`)
- **Typography:** Monospace for metadata fields, sans-serif for titles
- **Actions:** Ghost buttons aligned to bottom-right, visible on hover
- **Max width:** Cards span the full chat message width (max 720px)
- **Spacing:** 12px padding, 8px gap between stacked cards

---

## 7. Fallback Behavior

### 7.1 Failure Modes and Responses

| Failure | Detection | Rendered Output |
|---|---|---|
| Unknown language tag | Tag not in `CARD_TYPE_REGISTRY` and not in programming language list | Plain code block, no highlighting |
| Known card type, invalid JSON | `JSON.parse()` throws | Syntax-highlighted code block with `json` highlighting, yellow "Parse Error" badge |
| Known card type, valid JSON, schema failure | AJV `validate()` returns false | Syntax-highlighted code block with `json` highlighting, orange "Validation Error" badge |
| Known card type, valid JSON, valid schema, component crash | React error boundary catches | Syntax-highlighted code block with `json` highlighting, red "Render Error" badge |
| Partial block (stream interrupted) | Closing ``` never received | Plain code block with "Truncated" badge |

### 7.2 Error Boundary

Each card component is wrapped in a React error boundary:

```tsx
import { Component, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

interface CardErrorBoundaryProps {
  type: string;
  rawJson: string;
  children: ReactNode;
}

interface CardErrorBoundaryState {
  hasError: boolean;
}

class CardErrorBoundary extends Component<
  CardErrorBoundaryProps,
  CardErrorBoundaryState
> {
  state: CardErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CardErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.error(
      `[card-renderer] ${this.props.type} component crashed:`,
      error
    );
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div>
          <span className="card-error-badge">Render Error</span>
          <CodeBlock language="json" code={this.props.rawJson} />
        </div>
      );
    }
    return this.props.children;
  }
}
```

### 7.3 Invariant

**Content must never be hidden.** If the renderer cannot produce a card, the user
must still see the raw JSON payload. This is a hard invariant that applies to
every failure mode. Silent swallowing of content is a bug.

---

## 8. Agent Instructions

### 8.1 Prompt Injection Point

The `before_prompt_build` hook in the Research-Claw bootstrap appends a compact
instruction block to the agent's system prompt. This block is kept under 300
tokens to minimize context window consumption.

### 8.2 Instruction Text

```markdown
## Message Cards

You can embed rich cards in your responses using fenced code blocks.
Available card types: paper_card, task_card, progress_card, approval_card, monitor_digest, file_card.

Format:
```card_type
{valid JSON matching the card schema}
```

Rules:
- JSON must be valid (no trailing commas, no comments, no single quotes).
- One JSON object per block. Use multiple blocks for multiple items.
- Always write prose context around cards. Cards enhance, not replace, explanations.
- Use paper_card for any paper reference (search results, citations, recommendations).
- Use task_card when creating, updating, or listing research tasks.
- Use progress_card for activity summaries (daily, weekly, session).
- Use approval_card when requesting permission for consequential actions.
- Use monitor_digest for literature scan summaries.
- Use file_card when referencing workspace files you created or modified.
- If unsure whether to use a card, prefer plain text. Cards are for structured data.
```

### 8.3 Token Budget

| Component | Tokens (approx.) |
|---|---|
| Instruction header | ~15 |
| Card type list | ~25 |
| Format example | ~30 |
| Rules (8 items) | ~200 |
| **Total** | **~270** |

This fits comfortably under the 300-token budget for the instruction block.
At 270 tokens, it consumes less than 0.2% of a 128k context window.

### 8.4 Few-Shot Examples in SKILL.md

Individual skills can include card usage examples in their `SKILL.md` files.
For instance, the `literature_search` skill might include:

```markdown
## Output Format

Return results as paper_card blocks:

```paper_card
{"title": "Example Paper", "authors": ["Author, A."], "venue": "Example Venue 2025", "year": 2025, "abstract_preview": "This paper presents..."}
```
```

This keeps card knowledge distributed — the core instructions tell the agent
*what* cards exist, while individual skills tell it *when* to use them.

---

## 9. Extensibility

### 9.1 Adding a New Card Type

Adding a new card type requires changes in four locations:

**Step 1: Define the TypeScript interface.**

Create the interface in `dashboard/src/types/cards.ts`:

```typescript
interface ExperimentCard {
  type: 'experiment_card';
  name: string;
  hypothesis: string;
  status: 'planned' | 'running' | 'completed' | 'failed';
  started_at?: string;
  results_summary?: string;
}
```

**Step 2: Create the JSON Schema.**

Add `schemas/experiment_card.json` following the patterns in Section 4.
Required fields, string lengths, and enum values must mirror the TypeScript
interface exactly.

**Step 3: Create the React component.**

Add `dashboard/src/components/chat/cards/ExperimentCard.tsx`:

```tsx
interface ExperimentCardProps {
  data: ExperimentCard;
}

export default function ExperimentCard({ data }: ExperimentCardProps) {
  return (
    <div className="card experiment-card">
      <div className="card-accent card-accent--experiment" />
      <h4>{data.name}</h4>
      <p className="card-meta">Status: {data.status}</p>
      {data.hypothesis && (
        <p className="card-body">{data.hypothesis}</p>
      )}
      {/* Action buttons */}
    </div>
  );
}
```

**Step 4: Register in the card system.**

Update three files:

```typescript
// 1. CARD_TYPE_REGISTRY — add to the Set
const CARD_TYPE_REGISTRY = new Set([
  'paper_card',
  'task_card',
  'progress_card',
  'approval_card',
  'monitor_digest',
  'file_card',
  'experiment_card',  // <-- new
] as const);

// 2. CARD_COMPONENTS — add lazy import
const CARD_COMPONENTS = {
  // ... existing entries ...
  experiment_card: lazy(() => import('./cards/ExperimentCard')),
};

// 3. validators — add schema
validators.experiment_card = ajv.compile(experimentCardSchema);
```

**Step 5: Update agent instructions.**

Add `experiment_card` to the card type list in the `before_prompt_build` hook
and add a one-line usage note to the rules section.

### 9.2 Versioning

Card schemas are versioned implicitly via `additionalProperties: false`. When
a card type needs new optional fields:

1. Add the field to the TypeScript interface (optional).
2. Add the field to the JSON Schema `properties` (without adding to `required`).
3. Update the React component to handle the field's absence.

This is backward-compatible: old payloads (without the new field) still validate,
and old renderers (without the new field handling) still render correctly because
the field is optional.

For breaking changes (renaming a field, changing a required field's type), create
a new card type (e.g., `paper_card_v2`) rather than modifying the existing one.
The old type remains supported until a deprecation cycle completes.

### 9.3 Plugin-Contributed Card Types

Third-party plugins can register custom card types through the plugin API:

```typescript
// In a plugin's index.ts
export default {
  name: 'my-research-plugin',
  cardTypes: [
    {
      type: 'experiment_card',
      schema: experimentCardSchema,
      component: () => import('./ExperimentCard'),
      accentColor: '#EC4899',
    },
  ],
};
```

The Dashboard loads plugin card types at startup and merges them into the
card type registry. Plugin card types have lower priority than built-in types
(a plugin cannot override `paper_card`). Naming convention for plugin cards:
`{plugin_name}_{card_name}`, e.g., `wetlab_experiment_card`.

### 9.4 Testing Card Types

Each card type should have three categories of tests:

```typescript
// 1. Schema validation tests
describe('paper_card schema', () => {
  it('accepts valid minimal payload', () => {
    const valid = { title: 'Test', authors: ['A'] };
    expect(validators.paper_card(valid)).toBe(true);
  });

  it('rejects missing required field', () => {
    const invalid = { title: 'Test' }; // missing authors
    expect(validators.paper_card(invalid)).toBe(false);
  });

  it('rejects extra fields', () => {
    const invalid = { title: 'Test', authors: ['A'], unknown: true };
    expect(validators.paper_card(invalid)).toBe(false);
  });
});

// 2. Parser integration tests
describe('card parser', () => {
  it('extracts paper_card from markdown', () => {
    const md = '```paper_card\n{"title":"T","authors":["A"]}\n```';
    const blocks = extractCardBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paper_card');
  });

  it('ignores unknown card types', () => {
    const md = '```unknown_card\n{"foo":"bar"}\n```';
    const blocks = extractCardBlocks(md);
    expect(blocks).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseCardPayload('paper_card', '{invalid json}');
    expect(result).toBeNull();
  });
});

// 3. Component render tests
describe('<PaperCard>', () => {
  it('renders title and authors', () => {
    const data = { title: 'Test Paper', authors: ['Author A', 'Author B'] };
    render(<PaperCard data={data} />);
    expect(screen.getByText('Test Paper')).toBeInTheDocument();
    expect(screen.getByText('Author A, Author B')).toBeInTheDocument();
  });

  it('shows Add to Library when no library_id', () => {
    const data = { title: 'Test', authors: ['A'] };
    render(<PaperCard data={data} />);
    expect(screen.getByText('Add to Library')).toBeInTheDocument();
  });

  it('hides Add to Library when library_id present', () => {
    const data = { title: 'Test', authors: ['A'], library_id: 'abc' };
    render(<PaperCard data={data} />);
    expect(screen.queryByText('Add to Library')).not.toBeInTheDocument();
  });
});
```

---

## Appendix A: Complete Card Type Summary

| Card Type | Required Fields | Optional Fields | Actions | Typical Source |
|---|---|---|---|---|
| `paper_card` | `title`, `authors` | `venue`, `year`, `doi`, `url`, `arxiv_id`, `abstract_preview`, `read_status`, `library_id`, `tags` | Add to Library, Open PDF, Cite, View Details | `literature_search`, monitor scan, manual |
| `task_card` | `title`, `task_type`, `status`, `priority` | `id`, `description`, `deadline`, `related_paper_title` | View in Panel, Mark Complete, Edit | `research_planner`, heartbeat |
| `progress_card` | `period`, `papers_read`, `papers_added`, `tasks_completed`, `tasks_created` | `writing_words`, `reading_minutes`, `highlights` | (none) | Heartbeat cron, manual |
| `approval_card` | `action`, `context`, `risk_level` | `details`, `approval_id` | Approve, Reject, Ask for Details | `exec-approvals` |
| `monitor_digest` | `source`, `query`, `period`, `total_found`, `notable_papers` | (none) | Expand notable paper | monitor scan |
| `file_card` | `name`, `path` | `size_bytes`, `mime_type`, `created_at`, `modified_at`, `git_status` | Open, Download, View Diff | File operations |

## Appendix B: Full Example Message

Below is a complete agent message demonstrating multiple card types in context:

````markdown
Good morning! Here's your daily research briefing.

## Monitor Scan Results

Your arXiv tracker found 12 new papers on "graph neural networks for molecular property prediction" overnight. Here are the most relevant:

```monitor_digest
{
  "source": "arxiv",
  "query": "graph neural networks molecular property prediction",
  "period": "last 24h",
  "total_found": 12,
  "notable_papers": [
    {
      "title": "Equivariant Graph Transformers for Molecular Energy Prediction",
      "authors": ["Chen, W.", "Liu, Y.", "Zhang, H."],
      "relevance_note": "Directly addresses your energy prediction benchmark. Claims 15% improvement over SchNet."
    },
    {
      "title": "Scalable Message Passing for Large Molecular Graphs",
      "authors": ["Park, J.", "Kim, S."],
      "relevance_note": "Proposes a subgraph sampling technique that could help with your OOM issues on protein complexes."
    }
  ]
}
```

The first paper looks particularly relevant to your current benchmark. I've pulled the details:

```paper_card
{
  "title": "Equivariant Graph Transformers for Molecular Energy Prediction",
  "authors": ["Chen, W.", "Liu, Y.", "Zhang, H."],
  "venue": "arXiv preprint",
  "year": 2026,
  "arxiv_id": "2603.04521",
  "abstract_preview": "We propose EquiGT, an equivariant graph transformer architecture that combines SE(3)-equivariant message passing with global attention for molecular energy prediction. On the QM9 and MD17 benchmarks...",
  "read_status": "unread",
  "tags": ["GNN", "molecular-properties", "transformers"]
}
```

## Yesterday's Progress

```progress_card
{
  "period": "yesterday",
  "papers_read": 3,
  "papers_added": 5,
  "tasks_completed": 2,
  "tasks_created": 1,
  "writing_words": 850,
  "highlights": [
    "Finished reviewing SchNet ablation study",
    "Draft of Section 3.2 (methodology) reached 850 words"
  ]
}
```

## Pending Task

You still have an open task from last week:

```task_card
{
  "id": "task_2026_03_04_001",
  "title": "Reproduce Table 3 results from DimeNet++ paper",
  "task_type": "mixed",
  "status": "in_progress",
  "priority": "high",
  "deadline": "2026-03-14T23:59:00Z",
  "related_paper_title": "DimeNet++: Fast Directional Interatomic Potentials"
}
```

Would you like me to prioritize reading the EquiGT paper, or should I focus on helping with the DimeNet++ reproduction first?
````

---

*End of document C3d — Message Card Protocol*
