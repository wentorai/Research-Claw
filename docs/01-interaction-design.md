# C1 -- Global UI/UX Design Spec: Research-Claw Dashboard

> **Status:** Draft v1.0
> **Date:** 2026-03-11
> **Cross-refs:** `02-tech-stack.md` (tech choices), `03d-card-protocol.md` (structured card wire format), `03e-components.md` (React component implementation)
> **Target runtime:** React 18 SPA served by OpenClaw gateway at `http://127.0.0.1:28789`

---

## Table of Contents

1.  [Design Philosophy](#1-design-philosophy)
2.  [Three-Column Layout](#2-three-column-layout)
3.  [Responsive Breakpoints](#3-responsive-breakpoints)
4.  [Top Bar](#4-top-bar)
5.  [Left Navigation](#5-left-navigation)
6.  [Center Chat Area](#6-center-chat-area)
7.  [Right Panel -- 5 Tabs](#7-right-panel----5-tabs)
8.  [Panel Operation Routing](#8-panel-operation-routing)
9.  [Setup Wizard](#9-setup-wizard)
10. [Status Bar](#10-status-bar)
11. [Notification System](#11-notification-system)
12. [Message Card Visual Specs](#12-message-card-visual-specs)
13. [Theme Tokens](#13-theme-tokens)
14. [Internationalization (i18n)](#14-internationalization-i18n)
15. [Component Hierarchy](#15-component-hierarchy)

---

## 1. Design Philosophy

### 1.1 "Chat is the OS"

Research-Claw follows an **agent-centric** interaction model. The chat window is
not a sidebar feature -- it is the primary interface through which the researcher
operates. Every complex action ultimately routes through a conversation turn with
the agent.

**Core principles:**

| # | Principle | Implication |
|---|-----------|-------------|
| 1 | **Conversation-first** | Complex operations (literature search, task planning, writing) always route through the chat. Panels are read-heavy views; chat is the write path. |
| 2 | **Agent as search engine** | There is no `Cmd+K` palette. If the user wants to find something, they ask the agent. The agent searches memory, literature, workspace, and the web. |
| 3 | **Panels are projections** | The five right-panel tabs are live views of agent-managed state. Users can perform simple CRUD directly (toggle a checkbox, star a paper), but anything requiring judgement goes to chat. |
| 4 | **Minimal chrome, maximum content** | Dark terminal aesthetic with restrained decoration. No gradients on surfaces. Accent color used sparingly for interactive elements and status indicators. |
| 5 | **Human-in-the-Loop preserved** | The agent cannot execute destructive or high-cost actions without explicit user approval via `approval_card` in chat. |
| 6 | **Local-first, private** | All data lives on the researcher's machine. No telemetry. No cloud sync unless the user explicitly configures it. |

### 1.2 Design Language

**HashMind Dark Cyberpunk Terminal Aesthetic** -- matte dark surfaces, monospace
accents, subtle border glows, minimal iconography. The UI should feel like a
research terminal, not a consumer SaaS product.

- Primary accent: **Lobster Red** `#EF4444` -- interactive elements, brand marks
- Secondary accent: **Academic Blue** `#3B82F6` -- links, informational badges
- Success/Warning/Error follow standard semantic colors (see Section 13)
- Typography: Inter (UI), JetBrains Mono (code, token counts, status bar)
- Border radius: 6px (cards), 4px (buttons, inputs), 2px (badges)
- Elevation: no drop shadows; use 1px borders with `rgba(255,255,255,0.06)`

### 1.3 Interaction Routing Rule

Every user-facing operation falls into one of two categories:

| Category | Routing | Examples |
|----------|---------|----------|
| **Simple** | Direct Plugin RPC call | Toggle read status, star paper, check off task, reorder list |
| **Complex** | Open chat with pre-filled message | Add paper by DOI, create task with context, start writing session, configure radar |

The routing table per panel is specified exhaustively in Section 8.

---

## 2. Three-Column Layout

### 2.1 Column Dimensions

| Column | Width | Behavior |
|--------|-------|----------|
| Left nav | 240px fixed | Collapsible to 56px icon rail on `<1440px` or user toggle |
| Center chat | `flex: 1 1 auto` | Always visible. Minimum effective width: 480px |
| Right panel | 320-480px | Resizable via drag handle. Collapsible. Default 380px |

### 2.2 ASCII Wireframe -- Desktop (>= 1440px)

```
+------------------------------------------------------------------+
|  [LOGO] Research-Claw          [Bell 3]  [*] Agent  [Theme] [Av] |  <- Top Bar (48px)
+--------+---------------------------+-----------------------------+
|        |                           |                             |
| [Proj] |  +----- Chat Area ------+ |  [Lit] [Work] [Task] [Rad] |
| v Proj |  |                      | |  [Set]                     |
| -----  |  | Agent: Welcome back. | |  +-------------------------+
|        |  | Here are 3 new       | |  |                         |
| [Book] |  | papers matching your | |  |  Pending Review (12)    |
|        |  | radar keywords...    | |  |  +-----------+-------+  |
| [Fldr] |  |                      | |  |  | Paper Ti. | Venue |  |
|        |  | [paper_card]         | |  |  | Author... | 2026  |  |
| [Chck] |  | [paper_card]         | |  |  +-----------+-------+  |
|        |  | [paper_card]         | |  |  | Paper Ti. | Venue |  |
| [Sat]  |  |                      | |  |  | Author... | 2025  |  |
|        |  |                      | |  |  +-----------+-------+  |
| [Gear] |  |                      | |  |  | ...                |  |
|        |  +----------------------+ |  |  +--------------------+  |
|        |  +----------------------+ |  |                         |
|        |  | /  Type a message... | |  |  Saved (47)            |
|        |  | [Attach] [Send >>>]  | |  |  ...                   |
|        |  +----------------------+ |  +-------------------------+
+--------+---------------------------+-----------------------------+
|  Status: claude-sonnet-4-5 | In: 12.4k  Out: 3.1k | HB: 14m | v0.1.0  |
+------------------------------------------------------------------+
```

### 2.3 Column Interaction

- Clicking a left-nav icon opens the corresponding right-panel tab
- Clicking the same icon again toggles the right panel closed
- The right panel can also be closed via a `X` button in its header
- Drag handle on the left edge of the right panel allows resize (320-480px)
- Double-clicking the drag handle resets width to 380px default

---

## 3. Responsive Breakpoints

### 3.1 Breakpoint Table

| Breakpoint | Label | Layout | Left Nav | Right Panel |
|------------|-------|--------|----------|-------------|
| >= 1440px | `xl` | 3-column | Full 240px sidebar | Inline, persistent |
| 1024-1439px | `lg` | 2-column | Collapsed 56px icon rail | Overlay from right (320px), backdrop blur |
| 768-1023px | `md` | 1-column | Hidden, hamburger menu | Full-width modal sheet |
| < 768px | `sm` | 1-column | Hidden, hamburger menu | Full-width modal sheet |

### 3.2 Transition Behavior

```
xl (>= 1440px)                 lg (1024-1439px)
+------+----------+------+     +----+----------+
| 240  |   flex   | 380  |     | 56 |   flex   |  <-- right panel is overlay
| nav  |   chat   | panel|     |rail|   chat   |
+------+----------+------+     +----+----------+
                                         |  [overlay 320px] -->

md/sm (< 1024px)
+------------------------+
|    hamburger + topbar  |
+------------------------+
|                        |
|       chat (full)      |
|                        |
+------------------------+
  ^ panels = bottom sheet modals
  ^ left nav = drawer from left
```

### 3.3 Mobile Considerations (< 768px)

- Top bar collapses: logo becomes icon-only, status bar hidden
- Chat input bar sticks to bottom with safe-area insets
- Structured cards stack vertically, images constrained to 100% width
- Panel modals are full-screen with swipe-down-to-dismiss

---

## 4. Top Bar

### 4.1 Specification

| Property | Value |
|----------|-------|
| Height | 48px |
| Background | `var(--bg-secondary)` |
| Border | Bottom 1px `var(--border-default)` |
| Position | Fixed top, `z-index: 100` |
| Padding | 0 16px |

### 4.2 Elements (Left to Right)

```
[Logo] [Brand Text]                    [Bell] [Agent Status] [Theme] [Avatar]
```

| Element | Spec | Interaction |
|---------|------|-------------|
| **Logo** | 24x24px Research-Claw icon (lobster claw silhouette) | Click -> scroll chat to top |
| **Brand text** | "Research-Claw" in Inter SemiBold 15px, `var(--text-primary)` | -- |
| **Spacer** | `flex: 1` | -- |
| **Notification bell** | 20x20px icon. Badge: 16px red circle, white count (max "99+") | Click -> notification dropdown (Section 11) |
| **Agent status** | 8px circle dot. Green = idle/ready, Amber = processing, Red = error/disconnected | Hover -> tooltip with status detail |
| **Theme toggle** | Sun/Moon icon, 20x20px | Click -> toggle dark/light theme |
| **Avatar** | 28px circle. User initial or profile image | Click -> dropdown: profile, logout |

### 4.3 Agent Status Indicator

| State | Color | Tooltip | Dot Animation |
|-------|-------|---------|---------------|
| `idle` | `#22C55E` (green) | "Agent ready" | Static |
| `thinking` | `#F59E0B` (amber) | "Agent is thinking..." | Pulse animation (1s ease-in-out) |
| `tool_running` | `#F59E0B` (amber) | "Running: {tool_name}" | Pulse animation |
| `streaming` | `#3B82F6` (blue) | "Agent is responding..." | Pulse animation |
| `error` | `#EF4444` (red) | "Error: {error_message}" | Static |
| `disconnected` | `#6B7280` (gray) | "Gateway disconnected" | Static |

### 4.4 Excluded Elements

- **No `Cmd+K` search palette.** The agent is the search engine. Users type
  queries into the chat input. This is a deliberate design decision, not an
  omission.

---

## 5. Left Navigation

### 5.1 Structure

```
+------------------+
|  [ v ] Project   |  <- Project switcher dropdown
|       Switcher   |
+------------------+
|                  |
|  [Book]  Lit     |  <- Literature
|                  |
|  [Fldr]  Work    |  <- Workspace
|                  |
|  [Chck]  Tasks   |  <- Tasks
|                  |
|  [Sat]   Radar   |  <- Radar
|                  |
|        ...       |
|                  |
|  [Gear]  Settings|  <- Settings (bottom-pinned)
|                  |
+------------------+
```

### 5.2 Dimensions

| Property | Full (xl) | Collapsed (lg) |
|----------|-----------|----------------|
| Width | 240px | 56px |
| Background | `var(--bg-primary)` | `var(--bg-primary)` |
| Border | Right 1px `var(--border-default)` | Right 1px `var(--border-default)` |
| Item height | 40px | 40px |
| Item padding | 0 16px | centered |
| Icon size | 20x20px | 20x20px |
| Label | Visible, Inter Regular 14px | Hidden (tooltip on hover) |
| Active indicator | Left 3px bar, `var(--accent-red)` | Left 3px bar, `var(--accent-red)` |

### 5.3 Session Switcher

Sessions in Research-Claw are **independent conversation threads** backed by
OpenClaw's session system. Each session has its own chat history and runs on a
separate command lane — different sessions execute **in parallel** without
blocking each other (up to `agents.defaults.maxConcurrent`, default 4).

A help tooltip (ⓘ icon) next to the session label explains the concept on hover.

| Property | Spec |
|----------|------|
| Trigger | Dropdown button, full width of nav sidebar |
| Display | Session name (label / derivedTitle) |
| Dropdown items | List of sessions + "New Session..." at bottom |
| New session | Creates `project-{uuid}` key with label `Session N` |
| Active session | Bold text + accent indicator |
| Max visible | 30 items, then scroll |

### 5.4 Function Rail Icons

| Icon | Label | Key | Right Panel Tab | Description |
|------|-------|-----|-----------------|-------------|
| Book (open) | Literature | `Alt+1` | Literature | Paper library, reading queue |
| Folder | Workspace | `Alt+2` | Workspace | File tree, uploads, outputs |
| Checkbox | Tasks | `Alt+3` | Tasks | Deadline-sorted task list |
| Satellite dish | Radar | `Alt+4` | Radar | Keyword/author monitoring |
| Gear | Settings | `Alt+5` | Settings | Configuration sub-tabs |

- Icons use Lucide icon set, 20x20px, stroke width 1.5
- Inactive: `var(--text-tertiary)` | Hover: `var(--text-secondary)` | Active: `var(--accent-red)`
- Active state also shows a 3px left border bar in `var(--accent-red)`
- Badge counts appear as small superscript numbers (e.g., unread papers count on Literature icon)

---

## 6. Center Chat Area

### 6.1 Layout

```
+---------------------------------------------+
|              Chat Message Area               |
|         (scrollable, flex: 1 1 auto)         |
|                                              |
|  [message]                                   |
|  [message]                                   |
|  [structured_card]                           |
|  [message]                                   |
|                                              |
|  [scroll-to-bottom FAB if scrolled up]       |
+---------------------------------------------+
|              Input Bar (fixed)               |
|  [ / ] [ Type a message...        ] [Send]  |
|  [Attach]                                    |
+---------------------------------------------+
```

### 6.2 Message Types

| Type | Sender | Rendering |
|------|--------|-----------|
| `user_text` | User | Right-aligned bubble, `var(--bg-surface)`, Inter 14px |
| `assistant_text` | Agent | Left-aligned, no bubble (full-width), Markdown rendered |
| `paper_card` | Agent | Structured card (see Section 12.1) |
| `task_card` | Agent | Structured card (see Section 12.2) |
| `progress_card` | Agent | Structured card (see Section 12.3) |
| `approval_card` | Agent | Structured card (see Section 12.4) |
| `radar_digest` | Agent | Structured card (see Section 12.5) |
| `file_card` | Agent | Structured card (see Section 12.6) |
| `code_block` | Agent | Syntax-highlighted block (see Section 12.7) |
| `system` | System | Centered, muted text, small font |

### 6.3 Message Rendering

- **Markdown**: Full CommonMark + GFM tables + LaTeX math (`$inline$`, `$$block$$`)
- **Streaming**: Delta accumulation with cursor blink at insertion point
- **Code blocks**: Syntax highlighting via Shiki, dark theme matching terminal aesthetic
- **Images**: Inline rendering with lightbox on click, max-width 100%
- **Citations**: Rendered as `[n]` superscript links, hover shows paper title tooltip

### 6.4 User Message Bubbles

| Property | Value |
|----------|-------|
| Background | `var(--bg-surface)` |
| Border | 1px `var(--border-default)` |
| Border radius | 12px top-left, 12px top-right, 4px bottom-right, 12px bottom-left |
| Max width | 75% of chat area |
| Padding | 10px 14px |
| Font | Inter Regular 14px, `var(--text-primary)` |

### 6.5 Agent Message Area

| Property | Value |
|----------|-------|
| Background | none (transparent) |
| Max width | 100% of chat area (up to 720px for readability) |
| Padding | 10px 0 |
| Font | Inter Regular 14px, `var(--text-primary)` |
| Line height | 1.65 |

### 6.6 Slash Command Menu

Triggered when the user types `/` at the start of the input or after a space.

```
+----------------------------------+
| / Commands                       |
+----------------------------------+
| /paper   Search & add papers     |
| /task    Create a new task       |
| /write   Start a writing session |
| /radar   Configure radar watch   |
| /review  Start paper review      |
| /cite    Insert citation         |
| /export  Export document          |
| /project Project management      |
| /help    Show all commands       |
+----------------------------------+
```

| Property | Value |
|----------|-------|
| Position | Above input bar, anchored to left edge of input |
| Background | `var(--bg-surface)` |
| Border | 1px `var(--border-default)` |
| Border radius | 8px |
| Shadow | `0 4px 12px rgba(0,0,0,0.3)` |
| Max height | 320px, scrollable |
| Item height | 36px |
| Selected item | `var(--bg-hover)` background |
| Navigation | Arrow keys + Enter to select, Esc to dismiss |
| Filtering | Items filter as user types after `/` |

Slash commands pre-fill the chat input with structured text. They do **not**
execute directly -- the user always presses Send to confirm.

### 6.7 Input Bar

```
+-----------------------------------------------------+
| [/] | Type a message...                   | [^] [>>]|
+-----------------------------------------------------+
  ^      ^                                     ^    ^
  |      |                                     |    Send button
  |      Text area (auto-grow, max 6 lines)    |
  |                                            Attachment button
  Slash command trigger
```

| Property | Value |
|----------|-------|
| Position | Sticky bottom of chat area |
| Background | `var(--bg-secondary)` |
| Border | Top 1px `var(--border-default)`, outer 1px `var(--border-default)` rounded |
| Border radius | 12px |
| Padding | 8px 12px |
| Min height | 44px |
| Max height | 160px (approx 6 lines), then scroll |
| Text area font | Inter Regular 14px |
| Send button | 32x32px circle, `var(--accent-red)` bg when input non-empty, gray when empty |
| Attachment button | 32x32px, `var(--text-tertiary)`, opens file picker. Also accepts drag-and-drop. |
| Keyboard shortcut | `Enter` to send, `Shift+Enter` for newline |

### 6.8 Drag-and-Drop File Upload

- Drop zone: entire chat area highlights with dashed border + overlay text "Drop files here"
- Accepted types: PDF, images (png/jpg/gif/webp), text files, CSV, JSON, BibTeX (.bib)
- Files appear as `file_card` attachments in the message before sending
- Max file size: 50MB (configurable in settings)

### 6.9 Scroll-to-Bottom FAB

| Property | Value |
|----------|-------|
| Visibility | Shown when user has scrolled up > 200px from bottom |
| Position | Fixed, bottom-right of chat area, 16px from edges |
| Shape | 36px circle |
| Background | `var(--bg-surface)` |
| Border | 1px `var(--border-default)` |
| Icon | Chevron down, 16px, `var(--text-secondary)` |
| Badge | Unread message count if new messages arrived while scrolled up |
| Interaction | Click -> smooth scroll to bottom |

---

## 7. Right Panel -- 5 Tabs

### 7.1 Panel Chrome

```
+----------------------------------------------+
| [Lit] [Work] [Task] [Rad] [Set]     [<>] [X] |  <- Tab bar + resize + close
+----------------------------------------------+
|                                              |
|             Tab Content Area                 |
|             (scrollable)                     |
|                                              |
+----------------------------------------------+
```

| Property | Value |
|----------|-------|
| Width | 320-480px, resizable. Default 380px |
| Background | `var(--bg-primary)` |
| Border | Left 1px `var(--border-default)` |
| Tab bar height | 40px |
| Tab bar background | `var(--bg-secondary)` |
| Active tab | Text `var(--accent-red)`, bottom 2px border `var(--accent-red)` |
| Inactive tab | Text `var(--text-tertiary)` |
| Close button | 20px `X` icon, `var(--text-tertiary)`, top-right |
| Resize handle | 4px invisible drag zone on left edge, cursor `col-resize` |

### 7.2 Tab 1: Literature

The Literature panel provides a read-optimized view of the user's paper library.
Papers are added through chat (`/paper` command or natural language request) and
managed here for quick reference.

#### 7.2.1 Sub-tabs

```
+--------------------------------------------+
| [Pending Review (12)] [Saved (47)]         |
+--------------------------------------------+
| [Search...                        ] [Filt] |
+--------------------------------------------+
|                                            |
|  Paper list items...                       |
|                                            |
+--------------------------------------------+
```

| Sub-tab | Content | Default sort |
|---------|---------|--------------|
| **Pending Review** | Papers flagged for review that haven't been marked as `read` or `reviewed` | Date added (newest first) |
| **Saved** | All papers in the library regardless of read status | Date added (newest first) |

There is **no Zotero tab**. Zotero integration (if configured) syncs papers into
the same library, appearing in both sub-tabs based on their read status.

#### 7.2.2 Search & Filter Bar

| Element | Spec |
|---------|------|
| Search input | Placeholder "Search papers...", filters by title/author/keyword. Debounced 300ms |
| Filter button | Opens dropdown: by year range, venue, tags, read status |
| Sort | Dropdown in filter: Date added / Year / Title / Relevance |

#### 7.2.3 Paper List Item

```
+--------------------------------------------+
| [Status]  Paper Title That May Be Long...  |
|           Author A, Author B, +3  ·  2026  |
|           Venue Name                        |
|           [tag1] [tag2]        [*] [...] |
+--------------------------------------------+
```

| Element | Spec |
|---------|------|
| Status badge | Circle, 8px. Colors below |
| Title | Inter Medium 14px, `var(--text-primary)`, max 2 lines, ellipsis |
| Authors | Inter Regular 12px, `var(--text-secondary)`, truncated with "+N" |
| Year | Inter Regular 12px, `var(--text-tertiary)` |
| Venue | Inter Regular 12px, `var(--text-tertiary)` |
| Tags | Chip badges, 10px font, `var(--bg-surface)` bg, max 3 visible + "+N" |
| Star button | Toggle, filled = starred. `var(--accent-amber)` when active |
| More menu `[...]` | Open PDF, Cite, Remove, Edit tags |
| Row height | Auto, approx 72-88px |
| Hover | `var(--bg-hover)` background |

#### 7.2.4 Read Status Badges

| Status | Color | Label |
|--------|-------|-------|
| `unread` | `var(--text-tertiary)` (gray, hollow) | Unread |
| `reading` | `#3B82F6` (blue, half-filled) | Reading |
| `read` | `#22C55E` (green, filled) | Read |
| `reviewed` | `#A855F7` (purple, filled + check) | Reviewed |

#### 7.2.5 Empty State

When no papers exist in a sub-tab:

```
    [Book icon, 48px, muted]

    No papers yet.
    Ask the agent to find papers for you,
    or drop a PDF here to add it.
```

### 7.3 Tab 2: Workspace

A merged file tree showing research materials and agent outputs.

#### 7.3.1 Layout

```
+--------------------------------------------+
| Workspace                        [Upload]  |
+--------------------------------------------+
| Recent Changes                             |
|   modified.tex    2 min ago                |
|   results.csv     15 min ago               |
|   draft-v3.md     1 hr ago                 |
+--------------------------------------------+
| File Tree                                  |
|   v sources/                               |
|     > literature/                          |
|     > data/                                |
|       experiment-1.csv                     |
|       experiment-2.csv                     |
|   v outputs/                               |
|     > drafts/                              |
|       summary.md                           |
|       analysis.py                          |
+--------------------------------------------+
```

| Element | Spec |
|---------|------|
| Recent changes | Top 5 most recently modified files. Relative timestamps. Click -> open in default app |
| File tree | Collapsible directory tree. Icons by file type (PDF, code, data, text, image) |
| Upload button | Opens file picker. Also supports drag-and-drop onto the tree |
| Git indicators | Modified files show `M` badge, new files show `+` badge, in `var(--accent-blue)` |
| File actions | Right-click context menu: Open, Rename, Delete, Copy path, Show in chat |
| Max depth | 6 levels visible, then horizontal scroll |

#### 7.3.2 File Type Icons

| Extension | Icon | Color |
|-----------|------|-------|
| `.pdf` | Document | `#EF4444` |
| `.tex`, `.md`, `.txt` | Text file | `var(--text-secondary)` |
| `.py`, `.r`, `.jl`, `.m` | Code brackets | `#22C55E` |
| `.csv`, `.xlsx`, `.json` | Table/data | `#3B82F6` |
| `.png`, `.jpg`, `.svg` | Image | `#A855F7` |
| `.bib` | Book | `#F59E0B` |
| Directory | Folder | `var(--text-tertiary)` |

### 7.4 Tab 3: Tasks

A **deadline-sorted list** of research tasks. NOT a Kanban board.

#### 7.4.1 Layout

```
+--------------------------------------------+
| Tasks                     [Agent] [Human]  |
+--------------------------------------------+
| Overdue (2)                                |
|   [!] Submit revised paper      Mar 8  [x]|
|   [!] Reply to reviewer #2     Mar 10 [x]|
+--------------------------------------------+
| Upcoming                                   |
|   [>>] Run experiment batch 3   Mar 14 [ ]|
|   [>]  Draft introduction       Mar 18 [ ]|
|   [.]  Update bibliography      Mar 25 [ ]|
+--------------------------------------------+
| v Completed (14)                           |
|   [v] Lit review pass 1         Mar 5     |
|   [v] Data preprocessing        Mar 3     |
|   ...                                      |
+--------------------------------------------+
```

#### 7.4.2 Perspective Toggle

| Toggle | View |
|--------|------|
| **Human** (default) | Tasks assigned to the human researcher. Standard task list. |
| **Agent** | Tasks the agent is working on or has queued. Shows agent's internal task queue with status. |

The toggle is a segmented control in the tab header.

#### 7.4.3 Task List Item

```
+--------------------------------------------+
| [Priority] Task title              [Date]  |
|            Project: ProjectName    [Check]  |
+--------------------------------------------+
```

| Element | Spec |
|---------|------|
| Priority indicator | Left border 3px + icon prefix |
| Title | Inter Medium 14px, `var(--text-primary)` |
| Deadline | Inter Regular 12px. Red if overdue, amber if within 3 days, `var(--text-tertiary)` otherwise |
| Checkbox | 18px, rounded square. Check -> moves to Completed with animation |
| Project tag | Inter Regular 11px, `var(--text-tertiary)`, only shown when viewing "All Projects" |
| Hover | `var(--bg-hover)` background |
| Click | Opens task detail in chat (pre-filled message: "Show me details for task: {title}") |

#### 7.4.4 Priority Color Coding

| Priority | Color | Icon | Left border |
|----------|-------|------|-------------|
| `urgent` | `#EF4444` (red) | `!!` double exclamation | 3px `#EF4444` |
| `high` | `#F59E0B` (amber) | `>>` double chevron | 3px `#F59E0B` |
| `medium` | `#3B82F6` (blue) | `>` single chevron | 3px `#3B82F6` |
| `low` | `#6B7280` (gray) | `.` dot | 3px `#6B7280` |

#### 7.4.5 Sections

| Section | Behavior |
|---------|----------|
| **Overdue** | Tasks past deadline, not completed. Always expanded. Red header. |
| **Upcoming** | Future tasks sorted by deadline (nearest first). Always expanded. |
| **Completed** | Checked-off tasks. Collapsed by default. Toggle to expand. Sorted by completion date (most recent first). |

#### 7.4.6 Creating Tasks

There is no "Add Task" button in the panel. To create a task:

1. Type in chat: `/task Create a task to...` or natural language
2. Agent creates the task, confirms with a `task_card` in chat
3. Task appears in the panel list

This enforces the "chat is the OS" principle -- the agent helps set appropriate
deadlines, priorities, and context.

### 7.5 Tab 4: Radar

The Radar panel shows the user's monitoring configuration and recent findings.

#### 7.5.1 Layout

```
+--------------------------------------------+
| Radar                          [Refresh]   |
+--------------------------------------------+
| Tracking                                   |
|   Keywords: "LLM agents", "protein fo..." |
|   Authors:  Smith J, Lee K, +3             |
|   Journals: Nature, Science, +2            |
|   [Edit via chat...]                       |
+--------------------------------------------+
| Recent Findings                            |
+--------------------------------------------+
| [digest_card] 3 new papers matching        |
| "LLM agents" from arXiv (2 hrs ago)       |
+--------------------------------------------+
| [digest_card] Smith J published new paper  |
| in Nature Methods (1 day ago)              |
+--------------------------------------------+
| ...                                        |
+--------------------------------------------+
```

#### 7.5.2 Tracking Section

| Element | Spec |
|---------|------|
| Keywords | Comma-separated tags, chip style. Click `[Edit via chat...]` to modify |
| Authors | Author name chips. Same edit pattern |
| Journals | Journal name chips. Same edit pattern |
| Sources | Badge showing active sources (arXiv, PubMed, OpenAlex, Google Scholar) |
| Edit link | Pre-fills chat: "I want to update my radar tracking keywords" |

#### 7.5.3 Findings Digest Cards

| Element | Spec |
|---------|------|
| Background | `var(--bg-surface)` |
| Border | 1px `var(--border-default)` |
| Padding | 12px |
| Title | Match type + count: "3 new papers matching 'LLM agents'" |
| Source | Source name + relative timestamp |
| Action | Click -> expands inline or opens in chat for details |
| Refresh button | Top-right, triggers radar check via agent |

#### 7.5.4 Empty State

```
    [Satellite icon, 48px, muted]

    No radar configured yet.
    Tell the agent what topics, authors,
    or journals you want to monitor.
```

### 7.6 Tab 5: Settings

Settings are organized into 4 sub-tabs. Most settings can also be changed
via natural language in chat ("set my temperature to 0.3").

#### 7.6.1 Sub-tabs

```
+--------------------------------------------+
| [General] [Model] [Proxy] [About]          |
+--------------------------------------------+
```

#### 7.6.2 General Settings

| Setting | Control | Default | Description |
|---------|---------|---------|-------------|
| Language | Dropdown: English / Chinese | English | UI language |
| Theme | Toggle: Dark / Light | Dark | Color theme |
| Notification sound | Toggle | On | Play sound on agent completion |
| Auto-scroll | Toggle | On | Auto-scroll chat on new messages |
| Timestamp format | Dropdown: Relative / Absolute / ISO | Relative | Message timestamp display |
| File open behavior | Dropdown: System default / Internal viewer | System default | How to open files from workspace |

#### 7.6.3 Model Settings

| Setting | Control | Default | Description |
|---------|---------|---------|-------------|
| Provider | Dropdown: Anthropic / OpenAI / Custom | Anthropic | LLM provider |
| Model | Dropdown (filtered by provider) | claude-sonnet-4-5 | Model selection |
| API key | Masked text input + eye toggle | (from setup) | API key. Show last 4 chars |
| Temperature | Slider 0.0-1.0, step 0.1 | 0.3 | Sampling temperature |
| Max output tokens | Number input | 8192 | Max tokens per response |
| System prompt append | Textarea | (empty) | Extra instructions appended to system prompt |

#### 7.6.4 Proxy Settings

| Setting | Control | Default | Description |
|---------|---------|---------|-------------|
| Proxy enabled | Toggle | Off | Enable/disable proxy for all outbound requests |
| Protocol | Segmented: SOCKS5 / HTTP | SOCKS5 | Proxy protocol |
| Host | Text input | 127.0.0.1 | Proxy hostname |
| Port | Number input | 7890 | Proxy port |
| Authentication | Toggle | Off | Proxy requires auth |
| Username | Text input (shown if auth on) | (empty) | Proxy username |
| Password | Password input (shown if auth on) | (empty) | Proxy password |
| Test button | Button | -- | Tests proxy connectivity, shows result inline |

#### 7.6.5 About Sub-tab

| Item | Display |
|------|---------|
| Version | `Research-Claw v{version}` |
| OpenClaw version | `OpenClaw v{version}` |
| Gateway endpoint | `ws://127.0.0.1:28789` |
| Plugin: research-claw-core | Version + status (loaded/error) |
| Plugin: research-plugins | Version + item count |
| Connected software | List: Zotero (status), Overleaf (status), etc. |
| Bootstrap files | List of loaded bootstrap files with checkmarks |
| Logs link | "Open logs folder" -> opens filesystem path |
| Diagnostics | "Copy diagnostics" -> copies system info to clipboard |

---

## 8. Panel Operation Routing

Every panel operation routes either through **Direct RPC** (immediate, no chat
involvement) or **Chat** (pre-fills a message for the user to confirm/modify).

### 8.1 Literature Panel

| Operation | Route | Pre-filled message / RPC method |
|-----------|-------|---------------------------------|
| Search papers by query | Chat | `Find papers about {query}` |
| Add paper by DOI/URL | Chat | `/paper add {doi_or_url}` |
| Add paper by dropping PDF | Chat | `I've added a PDF. Please extract metadata and add to library: {filename}` |
| Toggle read status | Direct RPC | `library.setReadStatus({paperId, status})` |
| Star/unstar paper | Direct RPC | `library.toggleStar({paperId})` |
| Add/remove tag | Direct RPC | `library.updateTags({paperId, tags})` |
| Remove paper from library | Direct RPC | `library.removePaper({paperId})` |
| Open PDF | Direct RPC | `workspace.openFile({path})` -- opens in system viewer |
| Cite paper (copy citation) | Direct RPC | `library.getCitation({paperId, format})` -> clipboard |
| Start paper review session | Chat | `/review {paperTitle}` |
| Bulk import from BibTeX | Chat | `Import papers from this BibTeX file: {filename}` |
| Filter / sort list | Direct RPC | `library.query({filters, sort})` -- client-side re-render |

### 8.2 Workspace Panel

| Operation | Route | Pre-filled message / RPC method |
|-----------|-------|---------------------------------|
| Open file | Direct RPC | `workspace.openFile({path})` |
| Upload file | Direct RPC | `workspace.uploadFile({file})` |
| Rename file | Direct RPC | `workspace.renameFile({oldPath, newPath})` |
| Delete file | Direct RPC | `workspace.deleteFile({path})` -- with confirmation dialog |
| Create folder | Direct RPC | `workspace.createDirectory({path})` |
| Copy file path | Direct RPC | Client-side clipboard write |
| Show file in chat | Chat | `Tell me about this file: {path}` |
| Generate summary of file | Chat | `Summarize the contents of {path}` |
| Diff two files | Chat | `Compare {path1} and {path2}` |
| Export workspace | Chat | `/export workspace as zip` |

### 8.3 Tasks Panel

| Operation | Route | Pre-filled message / RPC method |
|-----------|-------|---------------------------------|
| Create task | Chat | `/task {description}` |
| Mark task complete | Direct RPC | `tasks.setCompleted({taskId, completed})` |
| Change priority | Direct RPC | `tasks.setPriority({taskId, priority})` |
| Change deadline | Direct RPC | `tasks.setDeadline({taskId, deadline})` |
| Delete task | Direct RPC | `tasks.deleteTask({taskId})` -- with confirmation |
| View task details | Chat | `Show me details for task: {title}` |
| Reorder tasks | Direct RPC | `tasks.reorder({taskId, afterTaskId})` -- drag handle |
| Assign to project | Direct RPC | `tasks.setProject({taskId, projectId})` |
| Bulk complete | Direct RPC | `tasks.bulkComplete({taskIds})` |
| Plan a research phase | Chat | `Help me plan the next phase of {project}` |

### 8.4 Radar Panel

| Operation | Route | Pre-filled message / RPC method |
|-----------|-------|---------------------------------|
| Add tracking keyword | Chat | `Add "{keyword}" to my radar` |
| Remove tracking keyword | Chat | `Remove "{keyword}" from my radar` |
| Add tracked author | Chat | `Track papers by {author}` |
| Remove tracked author | Chat | `Stop tracking {author}` |
| Add tracked journal | Chat | `Track new papers from {journal}` |
| Manual refresh | Chat | `Check my radar for new findings` |
| View finding details | Chat | `Tell me more about these {n} new papers matching {keyword}` |
| Configure check frequency | Chat | `Set radar to check every {n} hours` |
| Dismiss finding | Direct RPC | `radar.dismissFinding({findingId})` |
| Export findings | Chat | `/export radar findings as BibTeX` |

### 8.5 Settings Panel

| Operation | Route | Pre-filled message / RPC method |
|-----------|-------|---------------------------------|
| Change language | Direct RPC | `settings.setLanguage({lang})` -- immediate UI refresh |
| Change theme | Direct RPC | `settings.setTheme({theme})` -- immediate |
| Toggle notification sound | Direct RPC | `settings.set({key, value})` |
| Change model/provider | Direct RPC | `settings.setModel({provider, model})` |
| Update API key | Direct RPC | `settings.setApiKey({provider, key})` -- encrypted storage |
| Change temperature | Direct RPC | `settings.set({temperature})` |
| Configure proxy | Direct RPC | `settings.setProxy({config})` |
| Test proxy | Direct RPC | `settings.testProxy()` -- returns connectivity result |
| Update system prompt | Direct RPC | `settings.set({systemPromptAppend})` |
| Any setting via chat | Chat | `Set my temperature to 0.3` (agent interprets) |

---

## 9. Setup Wizard

### 9.1 Design Decision

The setup wizard is **ONE step only**. Research profile, preferences, and
initial configuration are handled by the agent through conversation after
setup, driven by `BOOTSTRAP.md`.

### 9.2 Wireframe

```
+----------------------------------------------------------+
|                                                          |
|              [Research-Claw Logo, 64px]                   |
|              Welcome to Research-Claw                     |
|                                                          |
|   +----------------------------------------------------+ |
|   |                                                    | |
|   |  LLM Provider                                      | |
|   |  [ Anthropic               v ]                     | |
|   |                                                    | |
|   |  API Key                                           | |
|   |  [ sk-ant-**************************** ] [Eye]     | |
|   |                                                    | |
|   |                          [ Start Research-Claw >>> ]| |
|   |                                                    | |
|   +----------------------------------------------------+ |
|                                                          |
|   Supports: Anthropic, OpenAI, Google, Azure, Ollama     |
|   Your key is stored locally and never transmitted.      |
|                                                          |
+----------------------------------------------------------+
```

### 9.3 Specification

| Element | Spec |
|---------|------|
| Container | Centered card, max-width 480px, `var(--bg-secondary)` background |
| Logo | 64x64px, centered above card |
| Heading | "Welcome to Research-Claw", Inter SemiBold 24px |
| Provider selector | Dropdown with icons. Options: Anthropic (default), OpenAI, Google, Azure, Custom/Ollama |
| API key input | Password field with eye toggle. Placeholder varies by provider |
| Start button | Full-width, 44px height, `var(--accent-red)` background, white text, Inter SemiBold 16px |
| Validation | Button disabled until key is non-empty. On submit, validates key format client-side |
| Error state | Red border on input + error message below: "Invalid key format" or "Connection failed" |
| Privacy note | Muted text below card, Inter Regular 12px |

### 9.4 Post-Setup Flow

1. User enters API key and clicks Start
2. Gateway starts with configured provider
3. Dashboard loads (3-column layout)
4. Agent sends first message driven by `BOOTSTRAP.md`:
   - "Welcome to Research-Claw! I'm your AI research assistant."
   - "Let's set up your research profile. What field are you working in?"
5. Conversational onboarding continues:
   - Research field and sub-field
   - Current projects
   - Preferred citation style
   - Key papers/authors to track
   - Writing tools (LaTeX/Word/Markdown)
6. Agent stores profile in `MEMORY.md` for future sessions

---

## 10. Status Bar

### 10.1 Layout

```
+------------------------------------------------------------------------+
| claude-sonnet-4-5 | In: 12.4k  Out: 3.1k | HB: 14m ago | v0.1.0     |
+------------------------------------------------------------------------+
```

### 10.2 Specification

| Property | Value |
|----------|-------|
| Height | 24px |
| Background | `var(--bg-secondary)` |
| Border | Top 1px `var(--border-default)` |
| Position | Fixed bottom, full width |
| Font | JetBrains Mono 11px, `var(--text-tertiary)` |
| Padding | 0 16px |
| z-index | 100 |

### 10.3 Status Bar Segments

| Segment | Content | Update frequency |
|---------|---------|------------------|
| **Model** | Active model name (e.g., `claude-sonnet-4-5`) | On model change |
| **Token count** | `In: {n}k  Out: {n}k` -- session cumulative input/output tokens | After each message |
| **Heartbeat timer** | `HB: {n}m ago` -- time since last heartbeat completion | Every 30 seconds |
| **Version** | `v{semver}` | Static |

### 10.4 Excluded Elements

- **NO cost/money display.** Token counts are informational for context-window
  awareness. Displaying costs would create anxiety and discourage exploration.
  Users who want cost tracking can check their provider dashboard.

### 10.5 Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| >= 1024px | Full status bar visible |
| 768-1023px | Model name + token count only |
| < 768px | Hidden entirely |

---

## 11. Notification System

### 11.1 Notification Sources

| Source | Trigger | Priority |
|--------|---------|----------|
| Heartbeat completion | Agent completed scheduled heartbeat check | Low |
| Radar finding | New papers/updates matching tracked keywords | Medium |
| Task deadline approaching | Task due within 24 hours | High |
| Task overdue | Task past deadline | High |
| Agent approval request | Agent needs Human-in-Loop confirmation | Critical |
| Agent error | Tool failure, API error, etc. | High |
| Setup reminder | Incomplete configuration items | Low |

### 11.2 Bell Icon & Badge

| Property | Value |
|----------|-------|
| Icon | Bell, 20px, `var(--text-secondary)` |
| Badge | 16px red circle, white count, positioned top-right of bell |
| Max count display | "99+" |
| No notifications | No badge shown, icon is `var(--text-tertiary)` |

### 11.3 Notification Dropdown

```
+------------------------------------------+
| Notifications                [Mark all]  |
+------------------------------------------+
| [!] Task overdue: Submit paper   2h ago  |
| [*] 3 new papers on "LLM agents" 6h ago |
| [v] Heartbeat: All clear        14m ago  |
| [...] Show 12 more                       |
+------------------------------------------+
```

| Property | Value |
|----------|-------|
| Position | Below bell icon, right-aligned |
| Width | 360px |
| Max height | 400px, scrollable |
| Background | `var(--bg-surface)` |
| Border | 1px `var(--border-default)` |
| Shadow | `0 4px 16px rgba(0,0,0,0.4)` |
| Item height | Auto, approx 56px |
| Unread items | Left 3px border in priority color |
| Read items | No left border, `var(--text-tertiary)` text |
| Mark all | Text button, "Mark all read" |

### 11.4 Notification Interaction

- Click a notification -> dismiss dropdown + scroll to related chat message
- If the chat message is from a previous session, load that session context
- Heartbeat notifications summarize findings; clicking opens the full heartbeat
  report in chat
- Approval request notifications are persistent until acted upon

### 11.5 Notification Priority Colors

| Priority | Left border color | Sound |
|----------|-------------------|-------|
| Critical | `#EF4444` | Two-tone chime |
| High | `#F59E0B` | Single chime |
| Medium | `#3B82F6` | Soft ping |
| Low | `var(--text-tertiary)` | None |

---

## 12. Message Card Visual Specs

All structured cards share a common container:

| Property | Value |
|----------|-------|
| Background | `var(--bg-surface)` |
| Border | 1px `var(--border-default)` |
| Border radius | 8px |
| Padding | 16px |
| Max width | 560px |
| Margin | 8px 0 |
| Font family | Inter (UI elements), JetBrains Mono (metadata values) |

### 12.1 paper_card

Displays a single paper reference with action buttons.

```
+------------------------------------------------------+
| [Status]  Paper Title That May Span Two Lines or     |
|           Even Three If It Is Quite Long              |
|                                                      |
|  Authors: Author A, Author B, Author C, +2           |
|  Venue:   NeurIPS 2026                               |
|  Year:    2026                                       |
|  DOI:     10.1234/example.2026.001  [link icon]      |
|                                                      |
|  [tag1] [tag2] [tag3]                                |
|                                                      |
|  [+ Add to Library]  [Cite]  [Open PDF]              |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| Status badge | Same as Section 7.2.4 (unread/reading/read/reviewed). Top-left. |
| Title | Inter SemiBold 15px, `var(--text-primary)` |
| Metadata labels | Inter Regular 12px, `var(--text-tertiary)`. Values in `var(--text-secondary)` |
| DOI link | `var(--accent-blue)`, opens in browser on click |
| Tags | Chip badges, same as library panel |
| Action: Add to Library | Outlined button, `var(--accent-blue)` border + text. Changes to "In Library" (disabled) if already added |
| Action: Cite | Outlined button. Click -> copy citation to clipboard, brief toast "Citation copied" |
| Action: Open PDF | Outlined button. Only shown if PDF URL available. Opens in system viewer or browser |
| Card border-left | 3px accent matching read status color |

### 12.2 task_card

Confirms a task creation or shows task details inline.

```
+------------------------------------------------------+
| [Priority]  Task Title Here                          |
|                                                      |
|  Deadline:  March 18, 2026                           |
|  Priority:  High                                     |
|  Project:   Dissertation Chapter 3                   |
|  Status:    In Progress                              |
|                                                      |
|  [View in Tasks Panel ->]                            |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| Priority indicator | Left 3px border in priority color (see 7.4.4) |
| Title | Inter SemiBold 15px, `var(--text-primary)` |
| Metadata | Key-value pairs. Keys in `var(--text-tertiary)`, values in `var(--text-secondary)` |
| Deadline | Red text if overdue, amber if within 3 days, default otherwise |
| Status badge | Inline badge: `todo` (gray), `in_progress` (blue), `completed` (green), `blocked` (red) |
| Link | Text link to open Tasks panel and highlight this task |

### 12.3 progress_card

Summarizes a session or period of research activity.

```
+------------------------------------------------------+
| [Chart icon]  Research Progress                      |
|               March 4-11, 2026                       |
+------------------------------------------------------+
|                                                      |
|  Papers read:          7                             |
|  Papers reviewed:      3                             |
|  Tasks completed:      12                            |
|  Words written:        4,280                         |
|  Agent conversations:  23                            |
|                                                      |
|  Highlights:                                         |
|  - Completed lit review for Chapter 2                |
|  - Found 3 key papers on attention mechanisms        |
|  - Drafted methodology section outline               |
|                                                      |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| Header icon | Chart/graph icon, 20px, `var(--accent-blue)` |
| Title | Inter SemiBold 15px, "Research Progress" |
| Date range | Inter Regular 12px, `var(--text-tertiary)` |
| Metrics | Key-value grid, 2 columns. Keys left-aligned `var(--text-tertiary)`, values right-aligned JetBrains Mono `var(--text-primary)` |
| Highlights | Bulleted list, Inter Regular 13px, `var(--text-secondary)` |
| Border-left | 3px `var(--accent-blue)` |

### 12.4 approval_card

Human-in-the-Loop confirmation request from the agent.

```
+------------------------------------------------------+
| [!]  Approval Required                               |
+------------------------------------------------------+
|                                                      |
|  The agent wants to perform the following action:     |
|                                                      |
|  Action:  Delete 3 duplicate entries from library    |
|  Scope:   Papers: "Attention Is All You Need" (x2), |
|           "BERT: Pre-training..." (x1)               |
|  Reason:  These appear to be duplicate imports from  |
|           BibTeX file uploaded yesterday.             |
|                                                      |
|  [ Approve ]              [ Reject ]                 |
|                                                      |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| Header icon | Warning triangle, 20px, `#F59E0B` |
| Title | Inter SemiBold 15px, "Approval Required", `#F59E0B` |
| Context text | Inter Regular 14px, `var(--text-secondary)` |
| Action/Scope/Reason | Key-value pairs. Keys bold, values regular |
| Approve button | Solid `#22C55E` background, white text, Inter SemiBold 13px |
| Reject button | Outlined `#EF4444` border + text |
| Card border-left | 3px `#F59E0B` |
| State: pending | Both buttons active |
| State: approved | Card shows "Approved" badge, buttons disabled, green tint |
| State: rejected | Card shows "Rejected" badge, buttons disabled, red tint |
| Timeout | If not acted upon in 5 minutes, agent adds reminder to chat |

### 12.5 radar_digest

Aggregated monitoring update card.

```
+------------------------------------------------------+
| [Satellite]  Radar Update                            |
|              March 11, 2026 - 14:30                  |
+------------------------------------------------------+
|                                                      |
|  3 new papers matching "LLM agents"                  |
|                                                      |
|  1. Multi-Agent Collaboration for Scientific...      |
|     Chen et al. - arXiv - 2026                       |
|                                                      |
|  2. Autonomous Research Assistants: A Survey         |
|     Park, Kim - ACL 2026                             |
|                                                      |
|  3. Tool-Augmented Language Models for Lab...        |
|     Martinez et al. - arXiv - 2026                   |
|                                                      |
|  Source: arXiv (2), ACL (1)                          |
|  Keywords matched: "LLM agents", "research assistant"|
|                                                      |
|  [Add all to library]  [Show details]                |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| Header icon | Satellite dish, 20px, `var(--accent-blue)` |
| Title | Inter SemiBold 15px, "Radar Update" |
| Timestamp | Inter Regular 12px, `var(--text-tertiary)` |
| Summary line | Inter Medium 14px, `var(--text-primary)` |
| Paper entries | Numbered list. Title in Inter Medium 13px, authors/venue/year in Inter Regular 12px `var(--text-tertiary)` |
| Source counts | Chip-style badges per source |
| Keywords matched | Chip-style badges, `var(--accent-blue)` border |
| Add all | Outlined button, `var(--accent-blue)` |
| Show details | Text link, opens expanded view in chat |
| Border-left | 3px `var(--accent-blue)` |

### 12.6 file_card

Represents a file reference in chat (uploaded, generated, or referenced).

```
+------------------------------------------------------+
| [File icon]  experiment-results-v3.csv               |
|                                                      |
|  Path:  sources/data/experiment-results-v3.csv       |
|  Size:  2.4 MB                                       |
|  Type:  CSV (Comma-Separated Values)                 |
|                                                      |
|  [Open]  [Download]                                  |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| File icon | Type-specific icon (see 7.3.2), 24px |
| Filename | Inter SemiBold 14px, `var(--text-primary)` |
| Metadata | Key-value pairs, Inter Regular 12px |
| Open button | Outlined, opens in system default application |
| Download button | Outlined, saves to user-chosen location |
| Border-left | 3px, color matches file type icon color |

### 12.7 code_block

Syntax-highlighted code with utility buttons. This is a passthrough from
Markdown rendering -- when the agent's response includes fenced code blocks,
they render with these enhanced controls.

```
+------------------------------------------------------+
| python                           [Copy]  [Save]      |
+------------------------------------------------------+
| import numpy as np                                   |
| from scipy import stats                              |
|                                                      |
| def analyze_results(data_path):                      |
|     data = np.loadtxt(data_path, delimiter=',')      |
|     mean = np.mean(data, axis=0)                     |
|     std = np.std(data, axis=0)                       |
|     t_stat, p_value = stats.ttest_ind(               |
|         data[:, 0], data[:, 1]                       |
|     )                                                |
|     return mean, std, t_stat, p_value                |
+------------------------------------------------------+
```

| Element | Spec |
|---------|------|
| Language label | Top-left, JetBrains Mono 11px, `var(--text-tertiary)` |
| Copy button | Top-right, icon + "Copy", `var(--text-tertiary)`. Click -> "Copied!" for 2s |
| Save button | Top-right, icon + "Save", `var(--text-tertiary)`. Click -> save dialog or save to workspace |
| Background | `#0D0D14` (slightly darker than surface) |
| Border | 1px `var(--border-default)` |
| Border radius | 8px |
| Font | JetBrains Mono 13px, line-height 1.5 |
| Syntax highlighting | Shiki, theme: custom dark matching terminal aesthetic |
| Line numbers | Optional, shown for blocks > 5 lines, `var(--text-tertiary)` |
| Max height | 400px, then scrollable with visible scrollbar |
| Horizontal overflow | Horizontal scroll (no wrapping for code) |

---

## 13. Theme Tokens

### 13.1 Dark Theme (Default -- Terminal)

The default theme follows the HashMind Dark Cyberpunk Terminal Aesthetic.

#### 13.1.1 Background Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#0A0A0F` | Page background, main canvas |
| `--bg-secondary` | `#12121A` | Top bar, status bar, nav sidebar, input areas |
| `--bg-surface` | `#1A1A25` | Cards, panels, dropdowns, popovers |
| `--bg-hover` | `#22222E` | Hover state for interactive items |
| `--bg-active` | `#2A2A38` | Active/pressed state |
| `--bg-overlay` | `rgba(0,0,0,0.6)` | Modal/sheet backdrop |
| `--bg-code` | `#0D0D14` | Code block background |
| `--bg-input` | `#15151F` | Text inputs, text areas |

#### 13.1.2 Text Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#E8E8ED` | Headings, body text, primary content |
| `--text-secondary` | `#9898A6` | Descriptions, metadata values, secondary info |
| `--text-tertiary` | `#5C5C6E` | Placeholders, timestamps, disabled text |
| `--text-inverse` | `#0A0A0F` | Text on accent-colored backgrounds |
| `--text-link` | `#3B82F6` | Hyperlinks |

#### 13.1.3 Border Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--border-default` | `rgba(255,255,255,0.06)` | Default borders, dividers |
| `--border-hover` | `rgba(255,255,255,0.12)` | Borders on hover |
| `--border-focus` | `#3B82F6` | Input focus rings |
| `--border-error` | `#EF4444` | Error state borders |

#### 13.1.4 Accent Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--accent-red` | `#EF4444` | Primary brand, CTAs, active nav, destructive actions |
| `--accent-red-hover` | `#DC2626` | Red hover state |
| `--accent-red-subtle` | `rgba(239,68,68,0.12)` | Red tinted backgrounds |
| `--accent-blue` | `#3B82F6` | Links, informational badges, medium priority |
| `--accent-blue-hover` | `#2563EB` | Blue hover state |
| `--accent-blue-subtle` | `rgba(59,130,246,0.12)` | Blue tinted backgrounds |
| `--accent-green` | `#22C55E` | Success, completed, approve |
| `--accent-green-subtle` | `rgba(34,197,94,0.12)` | Green tinted backgrounds |
| `--accent-amber` | `#F59E0B` | Warning, high priority, starred |
| `--accent-amber-subtle` | `rgba(245,158,11,0.12)` | Amber tinted backgrounds |
| `--accent-purple` | `#A855F7` | Reviewed status, special categories |
| `--accent-purple-subtle` | `rgba(168,85,247,0.12)` | Purple tinted backgrounds |

#### 13.1.5 Scrollbar

| Token | Hex |
|-------|-----|
| `--scrollbar-track` | `transparent` |
| `--scrollbar-thumb` | `rgba(255,255,255,0.08)` |
| `--scrollbar-thumb-hover` | `rgba(255,255,255,0.16)` |

### 13.2 Light Theme (Warm Paper)

For researchers who prefer a paper-like reading experience.

#### 13.2.1 Background Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-primary` | `#FFFBF5` | Page background |
| `--bg-secondary` | `#FFF8EE` | Top bar, status bar, nav sidebar |
| `--bg-surface` | `#FFF5E6` | Cards, panels, dropdowns |
| `--bg-hover` | `#FFEFD6` | Hover state |
| `--bg-active` | `#FFE8C4` | Active/pressed state |
| `--bg-overlay` | `rgba(0,0,0,0.3)` | Modal backdrop |
| `--bg-code` | `#FFF2DD` | Code block background |
| `--bg-input` | `#FFFFFF` | Text inputs |

#### 13.2.2 Text Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#1A1A1A` | Headings, body text |
| `--text-secondary` | `#5A5A5A` | Descriptions, metadata |
| `--text-tertiary` | `#9A9A9A` | Placeholders, timestamps |
| `--text-inverse` | `#FFFFFF` | Text on accent backgrounds |
| `--text-link` | `#2563EB` | Hyperlinks (slightly darker blue for contrast) |

#### 13.2.3 Border Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--border-default` | `rgba(0,0,0,0.08)` | Default borders |
| `--border-hover` | `rgba(0,0,0,0.15)` | Borders on hover |
| `--border-focus` | `#2563EB` | Focus rings |
| `--border-error` | `#DC2626` | Error borders |

#### 13.2.4 Accent Colors (Light Adjustments)

Accent colors remain the same hex values as dark theme for brand consistency.
The subtle/tinted variants adjust opacity:

| Token | Hex |
|-------|-----|
| `--accent-red-subtle` | `rgba(239,68,68,0.08)` |
| `--accent-blue-subtle` | `rgba(59,130,246,0.08)` |
| `--accent-green-subtle` | `rgba(34,197,94,0.08)` |
| `--accent-amber-subtle` | `rgba(245,158,11,0.08)` |
| `--accent-purple-subtle` | `rgba(168,85,247,0.08)` |

### 13.3 Typography Scale

| Token | Font | Size | Weight | Line Height | Usage |
|-------|------|------|--------|-------------|-------|
| `--type-h1` | Inter | 24px | 600 (SemiBold) | 1.3 | Page headings, setup wizard title |
| `--type-h2` | Inter | 18px | 600 | 1.35 | Section headings, card titles |
| `--type-h3` | Inter | 15px | 600 | 1.4 | Sub-section headings, list item titles |
| `--type-body` | Inter | 14px | 400 (Regular) | 1.65 | Body text, chat messages |
| `--type-body-sm` | Inter | 13px | 400 | 1.5 | Secondary content, card metadata |
| `--type-caption` | Inter | 12px | 400 | 1.4 | Timestamps, labels, tertiary info |
| `--type-caption-sm` | Inter | 11px | 400 | 1.35 | Status bar, badges |
| `--type-code` | JetBrains Mono | 13px | 400 | 1.5 | Code blocks, inline code |
| `--type-code-sm` | JetBrains Mono | 11px | 400 | 1.4 | Status bar values, token counts |

### 13.4 Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight spacing, badge padding |
| `--space-2` | 8px | Compact spacing, between inline elements |
| `--space-3` | 12px | Default gap, card internal padding (tight) |
| `--space-4` | 16px | Standard padding, section gaps |
| `--space-5` | 20px | Medium spacing |
| `--space-6` | 24px | Large gaps |
| `--space-8` | 32px | Section separators |
| `--space-10` | 40px | Page margins |
| `--space-12` | 48px | Top bar height, large section breaks |

### 13.5 Animation Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | General transitions |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Elements entering |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Elements exiting |
| `--duration-fast` | `100ms` | Hover states, toggles |
| `--duration-normal` | `200ms` | Panel transitions, dropdowns |
| `--duration-slow` | `350ms` | Page transitions, modals |
| `--pulse-agent` | `1s ease-in-out infinite` | Agent thinking indicator |

---

## 14. Internationalization (i18n)

### 14.1 Strategy

| Decision | Choice |
|----------|--------|
| Default language | English (EN) |
| Supported languages | EN, zh-CN (Simplified Chinese) |
| String storage | JSON files: `locales/en.json`, `locales/zh-CN.json` |
| Framework | `react-i18next` with namespace separation |
| Toggle location | Settings > General > Language dropdown |
| Persistence | `localStorage` key `research-claw-lang` |

### 14.2 Namespace Structure

```
locales/
  en.json
  zh-CN.json

Namespaces (top-level keys):
  common.*        -- Shared: buttons, labels, status text
  nav.*           -- Navigation labels, session switcher
  chat.*          -- Chat area: placeholders, system messages
  literature.*    -- Literature panel
  workspace.*     -- Workspace panel
  tasks.*         -- Tasks panel
  radar.*         -- Radar panel
  settings.*      -- Settings panel
  setup.*         -- Setup wizard
  notifications.* -- Notification text
  cards.*         -- Structured card labels
  errors.*        -- Error messages
  status.*        -- Status bar labels
```

### 14.3 Key Examples

| Key | EN | zh-CN |
|-----|-----|-------|
| `common.approve` | Approve | Approve |
| `common.reject` | Reject | Reject |
| `nav.literature` | Literature | Literature |
| `nav.workspace` | Workspace | Workspace |
| `nav.tasks` | Tasks | Tasks |
| `nav.radar` | Radar | Radar |
| `nav.settings` | Settings | Settings |
| `nav.allProjects` | All Projects | All Projects |
| `chat.placeholder` | Type a message... | Type a message... |
| `chat.send` | Send | Send |
| `literature.pendingReview` | Pending Review | Pending Review |
| `literature.saved` | Saved | Saved |
| `literature.noPapers` | No papers yet. | No papers yet. |
| `tasks.overdue` | Overdue | Overdue |
| `tasks.upcoming` | Upcoming | Upcoming |
| `tasks.completed` | Completed | Completed |
| `setup.welcome` | Welcome to Research-Claw | Welcome to Research-Claw |
| `setup.apiKeyLabel` | API Key | API Key |
| `setup.start` | Start Research-Claw | Start Research-Claw |
| `setup.privacyNote` | Your key is stored locally and never transmitted. | Your key is stored locally and never transmitted. |
| `status.heartbeat` | HB: {{time}} ago | HB: {{time}} ago |
| `status.tokens` | In: {{input}}k  Out: {{output}}k | In: {{input}}k  Out: {{output}}k |
| `cards.approvalRequired` | Approval Required | Approval Required |
| `cards.radarUpdate` | Radar Update | Radar Update |
| `cards.researchProgress` | Research Progress | Research Progress |
| `errors.connectionFailed` | Connection failed | Connection failed |
| `errors.invalidKeyFormat` | Invalid key format | Invalid key format |

> **Note:** Chinese translations are shown as English placeholders above. Actual
> zh-CN values will be provided in the locale file during implementation. The
> table demonstrates the key structure.

### 14.4 Implementation Rules

1. **No hardcoded strings** in JSX. Every visible string uses `t('key')`.
2. **Interpolation** for dynamic values: `t('status.tokens', { input: 12.4, output: 3.1 })`
3. **Pluralization** where needed: `t('literature.paperCount', { count: n })`
4. **Date/time formatting**: Use `Intl.DateTimeFormat` with the active locale for all timestamps.
5. **RTL**: Not needed for EN/zh-CN. Structure allows future RTL support if Arabic/Hebrew added.
6. **Fallback**: If a key is missing in zh-CN, fall back to EN value.

---

## 15. Component Hierarchy

### 15.1 Top-Level Tree

```
<App>
  <ThemeProvider>
    <I18nProvider>
      <GatewayProvider>              // WebSocket connection to OpenClaw gateway
        <NotificationProvider>
          <SetupWizard />            // Shown if not configured
          -- OR --
          <DashboardLayout>
            <TopBar />
            <MainArea>
              <LeftNav />
              <ChatArea />
              <RightPanel />
            </MainArea>
            <StatusBar />
          </DashboardLayout>
        </NotificationProvider>
      </GatewayProvider>
    </I18nProvider>
  </ThemeProvider>
</App>
```

### 15.2 Component Breakdown

```
TopBar
  Logo
  BrandText
  Spacer
  NotificationBell
    NotificationBadge
    NotificationDropdown
      NotificationItem[]
  AgentStatusDot
  ThemeToggle
  UserAvatar
    UserDropdown

LeftNav
  ProjectSwitcher
    ProjectDropdown
      ProjectItem[]
      NewProjectItem
  NavRail
    NavItem[Literature]
    NavItem[Workspace]
    NavItem[Tasks]
    NavItem[Radar]
    Spacer
    NavItem[Settings]

ChatArea
  MessageList
    MessageBubble[user_text]
    AgentMessage[assistant_text]
      MarkdownRenderer
        CodeBlock
        MathBlock
        ImageRenderer
    StructuredCard[paper_card]
    StructuredCard[task_card]
    StructuredCard[progress_card]
    StructuredCard[approval_card]
    StructuredCard[radar_digest]
    StructuredCard[file_card]
    SystemMessage
  ScrollToBottomFAB
  InputBar
    SlashCommandMenu
      SlashCommandItem[]
    TextArea
    AttachmentButton
    SendButton
    FileDropZone

RightPanel
  PanelTabBar
    TabButton[Literature]
    TabButton[Workspace]
    TabButton[Tasks]
    TabButton[Radar]
    TabButton[Settings]
    ResizeHandle
    CloseButton
  TabContent
    LiteratureTab
      SubTabBar[PendingReview, Saved]
      SearchFilterBar
      PaperList
        PaperListItem[]
      EmptyState
    WorkspaceTab
      RecentChanges
        RecentChangeItem[]
      FileTree
        FileTreeNode[] (recursive)
      UploadButton
    TasksTab
      PerspectiveToggle[Human, Agent]
      TaskSection[Overdue]
        TaskItem[]
      TaskSection[Upcoming]
        TaskItem[]
      TaskSection[Completed] (collapsible)
        TaskItem[]
    RadarTab
      TrackingSection
        KeywordChips
        AuthorChips
        JournalChips
        EditLink
      FindingsList
        FindingDigestCard[]
      RefreshButton
      EmptyState
    SettingsTab
      SettingsSubTabBar[General, Model, Proxy, About]
      GeneralSettings
      ModelSettings
      ProxySettings
      AboutInfo

StatusBar
  ModelName
  TokenCount
  HeartbeatTimer
  VersionString
```

### 15.3 State Management

| Store | Scope | Contents |
|-------|-------|----------|
| `gatewayStore` | Global | WebSocket connection state, RPC call queue, agent status |
| `chatStore` | Global | Message history, streaming state, active session |
| `libraryStore` | Global | Paper list, read statuses, tags, filters |
| `workspaceStore` | Global | File tree structure, recent changes |
| `taskStore` | Global | Task list, filters, sort order |
| `radarStore` | Global | Tracking config, findings |
| `settingsStore` | Global | All user preferences, persisted to localStorage + config file |
| `notificationStore` | Global | Notification list, unread count |
| `projectStore` | Global | Project list, active project |
| `uiStore` | Global | Panel open/closed, panel width, nav collapsed, active tab |

Recommended: Zustand for lightweight stores, or React Context + useReducer
for simple cases. No Redux -- the app is not complex enough to warrant it.

### 15.4 Gateway RPC Integration

All Direct RPC calls (Section 8) use the OpenClaw gateway WebSocket at
`ws://127.0.0.1:28789`. The `GatewayProvider` manages:

1. **Connection lifecycle**: Connect, reconnect with exponential backoff, heartbeat ping
2. **RPC calls**: JSON-RPC v2 over WebSocket. Request/response correlation via `id` field
3. **Event subscriptions**: Agent status changes, task updates, library changes
4. **Streaming**: Chat responses arrive as delta events, accumulated client-side

```
RPC Frame Format:
{
  "jsonrpc": "2.0",
  "method": "library.setReadStatus",
  "params": { "paperId": "abc123", "status": "read" },
  "id": 42
}

Response:
{
  "jsonrpc": "2.0",
  "result": { "success": true },
  "id": 42
}
```

---

## Appendix A: Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `/` | Open slash command menu (when input focused) |
| `Esc` | Close slash menu / close right panel / cancel current action |
| `Alt+1` | Toggle Literature panel |
| `Alt+2` | Toggle Workspace panel |
| `Alt+3` | Toggle Tasks panel |
| `Alt+4` | Toggle Radar panel |
| `Alt+5` | Toggle Settings panel |
| `Alt+N` | Toggle left nav sidebar |
| `Alt+P` | Open session switcher |

There is **no `Cmd+K`** shortcut. The agent is the search engine.

---

## Appendix B: Design Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Setup wizard steps | 1 (API key only) | Minimize friction. Research profile via conversational onboarding is more natural and captures richer context. |
| Task display | Deadline-sorted list | Researchers think in deadlines, not workflow stages. Kanban adds complexity without value for solo research. |
| Projects | Shared workstreams | Isolated containers fragment memory and context. Shared `MEMORY.md` means the agent always has full history. |
| Global search | No `Cmd+K` | The agent can search across all data sources (memory, files, literature, web). A search palette would be a less capable duplicate. |
| Status bar | Token count, no cost | Cost display creates anxiety. Token count is useful for context-window awareness. Researchers should focus on research, not API bills. |
| Literature sub-tabs | 2 (Pending/Saved) | Zotero integration is transparent -- synced papers appear in the same library. A separate tab creates a false dichotomy. |
| Dashboard framework | React 18 | Aligns with web platform (UmiJS/React). Larger ecosystem, better tooling, easier to recruit contributors. Lit was OpenClaw's choice for minimal footprint, but Research-Claw's dashboard is more feature-rich. |
| Operation routing | Simple=RPC, Complex=Chat | Snappy interactions for trivial actions (toggle, star, check). Rich agent assistance for actions requiring judgement or external data. |

---

## Appendix C: File Structure (Dashboard Source)

```
dashboard/
  index.html
  vite.config.ts
  tsconfig.json
  package.json
  public/
    favicon.ico
    fonts/
      inter-*.woff2
      jetbrains-mono-*.woff2
  src/
    main.tsx
    App.tsx
    styles/
      theme.css              -- CSS custom properties (Section 13)
      global.css             -- Reset, scrollbar, base typography
    locales/
      en.json
      zh-CN.json
    stores/
      gateway.ts
      chat.ts
      library.ts
      workspace.ts
      tasks.ts
      radar.ts
      settings.ts
      notifications.ts
      projects.ts
      ui.ts
    components/
      layout/
        DashboardLayout.tsx
        TopBar.tsx
        LeftNav.tsx
        StatusBar.tsx
      chat/
        ChatArea.tsx
        MessageList.tsx
        MessageBubble.tsx
        AgentMessage.tsx
        InputBar.tsx
        SlashCommandMenu.tsx
        ScrollToBottomFAB.tsx
        FileDropZone.tsx
      cards/
        PaperCard.tsx
        TaskCard.tsx
        ProgressCard.tsx
        ApprovalCard.tsx
        RadarDigestCard.tsx
        FileCard.tsx
        CodeBlock.tsx
      panels/
        RightPanel.tsx
        PanelTabBar.tsx
        LiteratureTab.tsx
        WorkspaceTab.tsx
        TasksTab.tsx
        RadarTab.tsx
        SettingsTab.tsx
      shared/
        Badge.tsx
        Chip.tsx
        Button.tsx
        Input.tsx
        Dropdown.tsx
        Toggle.tsx
        EmptyState.tsx
        ConfirmDialog.tsx
      setup/
        SetupWizard.tsx
      notifications/
        NotificationBell.tsx
        NotificationDropdown.tsx
    hooks/
      useGateway.ts
      useTheme.ts
      useLocale.ts
      useKeyboardShortcuts.ts
      useBreakpoint.ts
    utils/
      rpc.ts
      formatting.ts
      validation.ts
```

---

*End of document. This spec is the single source of truth for Research-Claw
dashboard interaction design. Implementation details for individual components
are in `03e-components.md`. Wire protocol for structured cards is in
`03d-card-protocol.md`. Technology stack decisions are in `02-tech-stack.md`.*
