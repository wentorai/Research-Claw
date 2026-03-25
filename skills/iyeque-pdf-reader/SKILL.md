---
name: iyeque-pdf-reader
description: PDF reader skill using PyMuPDF (fitz) for text extraction and metadata retrieval. Supports encrypted PDFs and handles large documents efficiently.
tags: [pdf, reader, text-extraction, metadata, pymupdf]
version: 1.0.0
author: iyeque
source: https://clawhub.ai/iyeque/iyeque-pdf-reader
requirements:
  - PyMuPDF (fitz)
install: pip install pymupdf
---

# PDF Reader (Iyeque)

PDF reader skill for text extraction and metadata retrieval using PyMuPDF.

---

## Installation

```bash
pip install pymupdf
```

---

## Tool API

The skill provides two commands:

### 1. extract — Extract Text

Extracts plain text from the specified PDF file.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | Path to the PDF file |
| `--max_pages` | integer | ❌ | Maximum number of pages to extract |

**Usage:**

```bash
# Extract all text
python3 skills/pdf-reader/reader.py extract /path/to/document.pdf

# Extract first 5 pages only
python3 skills/pdf-reader/reader.py extract /path/to/document.pdf --max_pages 5
```

**Output:** Plain text content from the PDF.

---

### 2. metadata — Get Document Info

Retrieve metadata about the document.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | ✅ | Path to the PDF file |

**Usage:**

```bash
python3 skills/pdf-reader/reader.py metadata /path/to/document.pdf
```

**Output:** Structured JSON with document metadata.

---

## Metadata Fields

| Field | Description |
|-------|-------------|
| `title` | Document title |
| `author` | Document author |
| `subject` | Document subject |
| `creator` | Software that created the PDF |
| `producer` | PDF producer software |
| `creationDate` | Creation date |
| `modDate` | Modification date |
| `format` | PDF format version |
| `encryption` | Encryption info (if any) |

---

## Example Output

### Extract Output

```
Plain text content from the PDF...
```

### Metadata Output

```json
{
  "title": "Annual Report 2024",
  "author": "John Doe",
  "creationDate": "D:20240115120000Z",
  "creator": "Microsoft Word",
  "producer": "Adobe PDF Library",
  "format": "PDF 1.7"
}
```

---

## Features

- **Fast extraction** using PyMuPDF (fitz)
- **Metadata retrieval** including creation/modification dates
- **Page limiting** with `--max_pages` for large documents
- **Encrypted PDF support** (password required if applicable)
- **Error handling** for corrupted or malformed PDFs

---

## When to Use This Skill

- Extract text content from PDF files
- Get document metadata (title, author, dates)
- Process multiple PDFs for analysis
- Quick PDF content preview
- Academic paper text extraction

---

## Python API Alternative

You can also use PyMuPDF directly in Python:

```python
import fitz  # PyMuPDF

# Open PDF
doc = fitz.open("document.pdf")

# Get metadata
print(doc.metadata)

# Extract text from all pages
for page in doc:
    text = page.get_text()
    print(text)

# Extract from specific page
page = doc[0]  # First page (0-indexed)
text = page.get_text()
```

---

## Notes

- Uses PyMuPDF (imported as `fitz`) for fast, reliable PDF processing
- Supports encrypted PDFs (will modify if password required)
- Handles large PDFs efficiently with `--max_pages` option
- Returns error message if file not found or invalid PDF

---

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| File not found | Invalid path | Check file path |
| Not a valid PDF | Corrupted file | Verify file integrity |
| Encrypted PDF | Password protected | Provide password if required |
