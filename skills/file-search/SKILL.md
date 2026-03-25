---
name: file-search
description: Fast file-name and content search using fd and ripgrep (rg). Provides efficient file system search capabilities with modern CLI tools.
tags: [search, files, fd, ripgrep, rg, cli]
version: 1.0.0
author: xejrax
source: https://clawhub.ai/xejrax/file-search
requirements:
  - fd-find
  - ripgrep
---

# File Search

Fast file-name and content search using `fd` and `ripgrep (rg)`.

---

## Purpose

This skill provides efficient file system search capabilities using two modern CLI tools:

| Tool | Purpose |
|------|---------|
| `fd` | Fast file-name search (alternative to `find`) |
| `rg` | Fast content search (alternative to `grep`) |

---

## Installation

### Fedora/RHEL (dnf)

```bash
sudo dnf install fd-find ripgrep
```

### Ubuntu/Debian (apt)

```bash
sudo apt install fd-find ripgrep
```

### macOS (brew)

```bash
brew install fd ripgrep
```

### Arch Linux (pacman)

```bash
sudo pacman -S fd ripgrep
```

---

## fd — File Name Search

### Basic Usage

```bash
# Search for files by name pattern
fd "pattern"

# Search in specific directory
fd "pattern" /path/to/search

# Case-insensitive search
fd -i "pattern"

# Search for exact file name
fd -x "exact_name"
```

### File Type Filters

```bash
# Files only
fd -t f "pattern"

# Directories only
fd -t d "pattern"

# Executable files
fd -t x "pattern"

# Symlinks
fd -t l "pattern"
```

### Extension Filters

```bash
# Search for specific extension
fd -e py "pattern"

# Multiple extensions
fd -e py -e js "pattern"

# All Python files
fd -t f -e py ""
```

### Hidden and Ignored Files

```bash
# Include hidden files
fd -H "pattern"

# Include ignored files (gitignore, etc.)
fd -I "pattern"

# Include both hidden and ignored
fd -HI "pattern"
```

### Size and Time Filters

```bash
# Files larger than 100MB
fd -S +100M

# Files smaller than 1KB
fd -S -1k

# Modified in last 7 days
fd --changed-within 7d

# Modified more than 30 days ago
fd --changed-before 30d
```

---

## ripgrep (rg) — Content Search

### Basic Usage

```bash
# Search for pattern in files
rg "pattern"

# Search in specific directory
rg "pattern" /path/to/search

# Case-insensitive search
rg -i "pattern"

# Search for exact word
rg -w "pattern"
```

### File Type Filters

```bash
# Search only Python files
rg -t py "pattern"

# Search only JavaScript files
rg -t js "pattern"

# Search all except Python
rg -T py "pattern"

# List available types
rg --type-list
```

### Output Control

```bash
# Show only file names
rg -l "pattern"

# Show only count of matches
rg -c "pattern"

# Show line numbers (default)
rg -n "pattern"

# No line numbers
rg -N "pattern"

# Show context (2 lines before and after)
rg -C 2 "pattern"

# Show only matching part
rg -o "pattern"
```

### Hidden and Ignored Files

```bash
# Include hidden files
rg --hidden "pattern"

# Include ignored files
rg --no-ignore "pattern"

# Include both
rg --hidden --no-ignore "pattern"
```

### Regex Features

```bash
# Use PCRE2 regex
rg -P "pattern"

# Fixed string (no regex)
rg -F "literal.string"

# Multi-line search
rg -U "line1.*\n.*line2"
```

---

## Common Patterns

### Find All Python Files

```bash
fd -t f -e py ""
```

### Search for TODO in Code

```bash
rg -i "TODO|FIXME|XXX" -t py
```

### Find Large Files

```bash
fd -S +100M -t f
```

### Find Recently Modified Files

```bash
fd --changed-within 1d
```

### Search for Specific Function

```bash
rg "def function_name" -t py
```

### Find Empty Directories

```bash
fd -t d -e ""
```

### Search and Replace Preview

```bash
rg "old_pattern" -r "new_pattern"
```

---

## When to Use This Skill

- User asks to find files by name
- User needs to search file contents
- Fast file system navigation needed
- Code search in projects
- Finding large or old files
- Searching with regex patterns

---

## Security Notes

- These tools will read files you point them at
- Be careful when searching sensitive directories
- Use `--max-depth` to limit search scope
- Review results before acting on them

---

## Comparison with Traditional Tools

| Feature | fd vs find | rg vs grep |
|---------|-----------|------------|
| Speed | fd is faster (parallel) | rg is faster (parallel) |
| Defaults | fd ignores hidden/gitignore by default | rg ignores hidden/gitignore by default |
| Output | fd has colored output | rg has colored output |
| Regex | fd uses regex by default | rg uses regex by default |
| Typing | fd is shorter to type | rg is shorter to type |
