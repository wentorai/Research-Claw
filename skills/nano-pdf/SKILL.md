---
name: nano-pdf
description: CLI wrapper for nano-pdf binary to edit PDF files. Provides page manipulation capabilities including extraction, rotation, and reordering.
tags: [pdf, cli, editor, manipulation]
version: 1.0.0
author: steipete
source: https://clawhub.ai/steipete/nano-pdf
requirements:
  - nano-pdf
install: uv tool install nano-pdf
---

# Nano PDF

CLI wrapper for the `nano-pdf` binary to edit PDF files.

---

## Installation

```bash
uv tool install nano-pdf
```

Or via pip:

```bash
pip install nano-pdf
```

---

## Usage

### Edit PDF Pages

```bash
nano-pdf edit <input.pdf> <output.pdf> <operations...>
```

### Page Operations

| Operation | Description | Example |
|-----------|-------------|---------|
| `extract` | Extract specific pages | `extract:1-5` |
| `rotate` | Rotate pages | `rotate:90:1-3` |
| `delete` | Remove pages | `delete:2,4,6` |
| `reorder` | Reorder pages | `reorder:3,1,2` |
| `duplicate` | Duplicate pages | `duplicate:1:2` |

---

## Examples

### Extract Pages 1-5

```bash
nano-pdf edit input.pdf output.pdf extract:1-5
```

### Extract Multiple Ranges

```bash
nano-pdf edit input.pdf output.pdf extract:1-3,7,10-12
```

### Rotate Pages 90 Degrees

```bash
nano-pdf edit input.pdf output.pdf rotate:90:1-5
```

### Delete Pages

```bash
nano-pdf edit input.pdf output.pdf delete:2,4,6
```

### Combine Operations

```bash
nano-pdf edit input.pdf output.pdf extract:1-10 rotate:90:1-5
```

---

## Page Numbering

- Pages are 1-indexed (first page is 1)
- Use `-` for ranges: `1-5` means pages 1 through 5
- Use `,` for multiple pages: `1,3,5` means pages 1, 3, and 5
- Combine: `1-3,7,10-12`

---

## When to Use This Skill

- Extract specific pages from a PDF
- Rotate PDF pages
- Delete unwanted pages
- Reorder PDF pages
- Quick PDF manipulation without GUI tools

---

## Notes

- Always verify output before overwriting originals
- Works best with standard PDF files
- May have issues with encrypted PDFs

---

## Safety

- Only run on trusted PDF files
- Verify output correctness on non-sensitive files first
- Keep backups of important documents
