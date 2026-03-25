---
name: kai-slide-creator
description: Generate zero-dependency HTML presentations that run entirely in the browser. Zero npm, no build tools. Includes presentation mode and edit mode.
tags: [slides, presentation, html, generator]
version: 1.0.0
author: kaisersong
source: https://clawhub.ai/kaisersong/kai-slide-creator
---

# Slide Creator

Generate zero-dependency HTML presentations that run entirely in the browser.

---

## Core Philosophy

| Principle | Description |
|-----------|-------------|
| **Zero Dependencies** | Single HTML files with inline CSS/JS. No npm, no build tools. |
| **Show, Don't Tell** | Generate visual style previews; design preferences emerge from seeing options. |
| **Distinctive Design** | Avoid generic AI aesthetics (Inter font, purple gradients, predictable heroes). |
| **Viewport Fitting** | Slides fit exactly in the viewport. Overflowing content gets split, not squished. |
| **Plan Before Generate** | `--plan` creates outline; `--generate` produces HTML from it. |

---

## Generation Contract (Non-Negotiable)

Every generated HTML file MUST include:

1. **Presentation Mode** — F5 / ▶ button, fullscreen scaling, PresentMode class
2. **Edit Mode** — top-left hotzone, ✏ Edit toggle, contenteditable on all text, notes panel

---

## Command Routing

| Command | What to Load | What to Do |
|---------|-------------|------------|
| `--plan [prompt]` | planning-template.md | Create PLANNING.md. Stop — no HTML. |
| `--generate` | html-template.md + style file + base-css.md | Read PLANNING.md, generate HTML. |
| No flag (interactive) | workflow.md + html-template.md | Follow Phase 0–5. |
| Content + style given directly | html-template.md + style file + base-css.md | Generate immediately — no Phase 1/2. |

---

## Content-Type → Style Hints

| Content Type | Suggested Styles |
|--------------|-----------------|
| Data report / KPI dashboard | Data Story, Enterprise Dark, Swiss Modern |
| Business pitch / VC deck | Bold Signal, Aurora Mesh, Enterprise Dark |
| Developer tool / API docs | Terminal Green, Neon Cyber, Neo-Retro Dev Deck |
| Research / thought leadership | Modern Newspaper, Paper & Ink, Swiss Modern |
| Creative / personal brand | Vintage Editorial, Split Pastel, Neo-Brutalism |
| Product launch / SaaS | Aurora Mesh, Glassmorphism, Electric Studio |
| Education / tutorial | Notebook Tabs, Paper & Ink, Pastel Geometry |
| Chinese content | Chinese Chan, Aurora Mesh, Blue Sky |
| Hackathon / indie dev | Neo-Retro Dev Deck, Neo-Brutalism, Terminal Green |

---

## Style Reference Files

| Style | File |
|-------|------|
| Blue Sky | blue-sky-starter.html (full base) |
| Aurora Mesh | aurora-mesh.md |
| Chinese Chan | chinese-chan.md |
| Data Story | data-story.md |
| Enterprise Dark | enterprise-dark.md |
| Glassmorphism | glassmorphism.md |
| Neo-Brutalism | neo-brutalism.md |
| All other styles | STYLE-DESC.md |

---

## For AI Agents

```bash
# From a topic or notes
/slide-creator Make a pitch deck for [topic]

# From a plan file (skip interactive phases)
/slide-creator --generate  # reads PLANNING.md automatically

# Two-step (review the plan before generating)
/slide-creator --plan "Product launch deck for Acme v2"
# (edit PLANNING.md if needed)
/slide-creator --generate

# Export to PPTX after generation
/kai-html-export presentation.html  # image mode (pixel-perfect)
/kai-html-export --mode native presentation.html  # native mode
```

---

## Phase 0: Detect Mode

Before starting:
- PLANNING.md exists → read it, skip to Phase 3
- User provides source content + style directly → skip Phase 1/2, generate immediately
- User has a .ppt/.pptx file → Phase 4 (PPT conversion)
- User wants to enhance existing HTML → read and enhance
- Everything else → Phase 1 (Content Discovery)

---

## When to Use This Skill

- Create HTML presentations from topics or notes
- Convert existing content to slides
- Design pitch decks, reports, tutorials
- Generate zero-dependency HTML slideshows

---

## Related Skills

- **report-creator** — For long-form scrollable HTML reports (not slides)
- **frontend-design** — For interactive pages that go beyond slides
