---
name: document-converter
description: Convert Office documents (PPTX, DOCX, XLSX, PDF, HTML, CSV, JSON, XML, images) to Markdown using Microsoft MarkItDown. Provides the agent with conversion strategies for academic and research workflows.
tags: [document, conversion, markdown, office, pdf, pptx, docx]
version: 1.0.0
requirements:
  - markitdown
  - markitdown-mcp
install: pip install 'markitdown[all]' markitdown-mcp
---

# Document Converter (MarkItDown)

Convert Office and structured documents to Markdown for LLM consumption using Microsoft MarkItDown.

---

## Overview

MarkItDown is a Microsoft open-source tool that converts a wide range of document formats into clean Markdown text. This is essential for academic research workflows where source materials arrive in diverse formats (PDFs from journals, PPTX from conferences, DOCX from collaborators, XLSX data tables).

---

## Supported Formats

| Format | Extensions | Notes |
|--------|-----------|-------|
| PDF | `.pdf` | Text extraction; scanned PDFs require OCR |
| Word | `.docx` | Paragraphs, tables, lists, headings preserved |
| PowerPoint | `.pptx` | Slide-by-slide with speaker notes |
| Excel | `.xlsx`, `.xls` | Sheet-by-sheet, tables as Markdown tables |
| HTML | `.html`, `.htm` | Cleaned content extraction |
| CSV | `.csv` | Converted to Markdown table |
| JSON | `.json` | Pretty-printed structured output |
| XML | `.xml` | Structured text extraction |
| Images | `.jpg`, `.png`, `.gif`, `.bmp`, `.tiff` | OCR text extraction (requires optional deps) |
| Audio | `.mp3`, `.wav` | Transcription (requires optional deps) |
| ZIP | `.zip` | Recursively converts contained files |

---

## MCP Tool Usage

When the `markitdown-mcp` server is configured, use the `convert_to_markdown` tool:

```
Tool: convert_to_markdown
Parameters:
  uri: "file:///absolute/path/to/document.pptx"
```

The `uri` parameter accepts:
- Local files: `file:///path/to/file.docx`
- HTTP URLs: `https://example.com/paper.pdf`

### Important

- Always use absolute paths with the `file://` URI scheme for local files.
- The tool returns the full Markdown text content of the converted document.
- For large documents, the output may be substantial. Consider summarizing or extracting relevant sections after conversion.

---

## CLI Fallback

If the MCP server is not available, use the CLI directly via shell:

```bash
# Convert a single file
markitdown document.pptx

# Save output to file
markitdown document.pptx > output.md

# Convert from URL
markitdown https://example.com/paper.pdf
```

---

## Academic Research Workflows

### 1. Conference Presentation Analysis

Convert a PPTX to Markdown, then analyze the content:

1. Convert the presentation with `convert_to_markdown`
2. The output preserves slide structure and speaker notes
3. Summarize key findings, methodology, and conclusions

### 2. Paper Review from PDF

1. Convert the PDF to Markdown
2. Extract sections: Abstract, Introduction, Methods, Results, Discussion
3. Cross-reference with literature library

### 3. Data Table Extraction

1. Convert XLSX to Markdown tables
2. Each sheet becomes a separate section
3. Use the extracted tables for analysis or comparison

### 4. Batch Literature Processing

When processing multiple documents:
1. Convert each document individually
2. Extract metadata (title, authors, date) from the content
3. Add to the literature library with `library_add_paper`

---

## Output Quality Notes

| Format | Quality | Caveats |
|--------|---------|---------|
| DOCX | Excellent | Complex layouts may lose formatting |
| PPTX | Good | Diagrams/charts become text descriptions |
| XLSX | Good | Merged cells may not render perfectly |
| PDF | Variable | Depends on PDF type (text vs scanned) |
| HTML | Good | JavaScript-rendered content not captured |
| CSV | Excellent | Direct table conversion |

---

## When to Use This Skill

- User uploads or references an Office document (PPTX, DOCX, XLSX)
- User wants to analyze content from a PDF
- User needs to extract text from images (OCR)
- User wants to convert a document for inclusion in notes or workspace
- User asks to read, summarize, or analyze a non-Markdown file
- Batch processing of research materials in mixed formats

---

## When NOT to Use

- File is already Markdown or plain text
- User wants to edit the original document format (use appropriate editor)
- User needs pixel-perfect layout preservation (use the original format)
- File is a scanned PDF without OCR support configured

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `markitdown` not found | Run `pip install 'markitdown[all]'` |
| MCP tool not available | Ensure `markitdown-mcp` is installed and configured in `openclaw.json` |
| Empty output from PDF | PDF may be scanned/image-only; needs OCR dependencies |
| Encoding errors | Ensure file is not corrupted; try re-saving from source application |
| Large file timeout | Convert via CLI instead of MCP for very large files |

---

## Installation

### Local (macOS/Linux)

```bash
pip install 'markitdown[all]' markitdown-mcp
```

### Verify

```bash
markitdown --help
```

### Docker

MarkItDown is pre-installed in the Research-Claw Docker image.
