---
name: imap-smtp-email
description: Read, search, and manage email via IMAP protocol. Send email via SMTP. Supports Gmail, Outlook, 163.com, 126.com, QQ Mail, and any standard IMAP/SMTP server with multi-account support.
tags: [email, imap, smtp, gmail, communication]
version: 1.0.0
author: gzlicanyi
source: https://clawhub.ai/gzlicanyi/imap-smtp-email
---

# IMAP/SMTP Email

Read, search, and manage email via IMAP. Send email via SMTP.

---

## Supported Providers

| Provider | IMAP Host | IMAP Port | SMTP Host | SMTP Port |
|----------|-----------|-----------|-----------|-----------|
| 163.com | imap.163.com | 993 | smtp.163.com | 465 |
| vip.163.com | imap.vip.163.com | 993 | smtp.vip.163.com | 465 |
| 126.com | imap.126.com | 993 | smtp.126.com | 465 |
| Gmail | imap.gmail.com | 993 | smtp.gmail.com | 587 |
| Outlook | outlook.office365.com | 993 | smtp.office365.com | 587 |
| QQ Mail | imap.qq.com | 993 | smtp.qq.com | 587 |

---

## Configuration

### Setup

```bash
bash setup.sh
```

Config stored at `~/.config/imap-smtp-email/.env`

### Config File Format

```bash
# Default account (no prefix)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your@email.com
IMAP_PASS=your_password
IMAP_TLS=true
IMAP_MAILBOX=INBOX

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@email.com
SMTP_PASS=your_password
SMTP_FROM=your@email.com

# File access whitelist
ALLOWED_READ_DIRS=~/Downloads,~/Documents
ALLOWED_WRITE_DIRS=~/Downloads
```

---

## Multi-Account Support

### Adding an Account

```bash
# Run setup and choose "Add a new account"
bash setup.sh
```

Or manually add prefixed variables:

```bash
# Work account (WORK_ prefix)
WORK_IMAP_HOST=imap.company.com
WORK_IMAP_PORT=993
WORK_IMAP_USER=me@company.com
WORK_IMAP_PASS=password
WORK_SMTP_HOST=smtp.company.com
WORK_SMTP_PORT=587
WORK_SMTP_USER=me@company.com
WORK_SMTP_PASS=password
```

### Using a Named Account

```bash
# Use --account <name> before the command
node scripts/imap.js --account work check
node scripts/smtp.js --account work send --to foo@bar.com --subject Hi --body Hello
```

---

## IMAP Commands (Receiving Email)

### check — Check for New Emails

```bash
node scripts/imap.js [--account <name>] check [--limit 10] [--mailbox INBOX] [--recent 2h]
```

Options:
- `--limit`: Max results (default: 10)
- `--mailbox`: Mailbox to check (default: INBOX)
- `--recent`: Only show emails from last X time (e.g., 30m, 2h, 7d)

### fetch — Fetch Full Email

```bash
node scripts/imap.js [--account <name>] fetch <uid> [--mailbox INBOX]
```

### download — Download Attachments

```bash
node scripts/imap.js [--account <name>] download <uid> [--dir <path>] [--file <filename>]
```

### search — Search Emails

```bash
node scripts/imap.js [--account <name>] search [options]
```

Options:
- `--unseen`: Only unread messages
- `--seen`: Only read messages
- `--from <email>`: From address contains
- `--subject <text>`: Subject contains
- `--recent <time>`: From last X time
- `--since <date>`: After date (YYYY-MM-DD)
- `--before <date>`: Before date (YYYY-MM-DD)
- `--limit <n>`: Max results (default: 20)

### mark-read / mark-unread

```bash
node scripts/imap.js [--account <name>] mark-read <uid> [uid2 uid3...]
node scripts/imap.js [--account <name>] mark-unread <uid> [uid2 uid3...]
```

### list-mailboxes

```bash
node scripts/imap.js [--account <name>] list-mailboxes
```

### list-accounts

```bash
node scripts/imap.js list-accounts
```

---

## SMTP Commands (Sending Email)

### send — Send Email

```bash
node scripts/smtp.js [--account <name>] send --to <email> --subject <text> [options]
```

**Required:**
- `--to`: Recipient (comma-separated for multiple)
- `--subject`: Email subject

**Optional:**
- `--body`: Plain text body
- `--html`: Send body as HTML
- `--body-file`: Read body from file
- `--html-file`: Read HTML from file
- `--cc`: CC recipients
- `--bcc`: BCC recipients
- `--attach`: Attachments (comma-separated)
- `--from`: Override default sender

**Examples:**

```bash
# Simple text email
node scripts/smtp.js send --to recipient@example.com --subject "Hello" --body "World"

# HTML email
node scripts/smtp.js send --to recipient@example.com --subject "Newsletter" --html --body "<h1>Welcome</h1>"

# Email with attachment
node scripts/smtp.js send --to recipient@example.com --subject "Report" --body "Please find attached" --attach report.pdf

# Multiple recipients
node scripts/smtp.js send --to "a@example.com,b@example.com" --cc "c@example.com" --subject "Update" --body "Team update"
```

### test — Test SMTP Connection

```bash
node scripts/smtp.js [--account <name>] test
```

---

## Important Notes

### Gmail
- Regular password is rejected
- Must generate an **App Password**: https://myaccount.google.com/apppasswords
- Requires 2-Step Verification enabled

### 163.com / 126.com
- Use **authorization code** (授权码), not account password
- Enable IMAP/SMTP in web settings first

---

## Dependencies

```bash
npm install
```

---

## Security Notes

- Config stored at `~/.config/imap-smtp-email/.env` with 600 permissions
- File access whitelist limits where attachments can be saved
- Never commit .env files to version control
