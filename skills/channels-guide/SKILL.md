---
name: Channels Guide
description: >-
  Configuration and behavior guide for Research-Claw IM channels
  (Telegram, Discord, WeChat). Covers bot token setup, commands.native
  suppression, approval_card degradation, cron delivery, media paths,
  and diagnostic steps for channel connectivity issues.
---

<!-- MAINTENANCE NOTES:
     Source: AGENTS.md §3 Channels (extracted during prompt redesign).
     Update here when adding channel types or protocols.
     commands.native=false enforced by sync-global-config.cjs.
     WeChat creds: ~/.openclaw/openclaw-weixin/accounts/
-->

# IM Channel Configuration

RC can receive/reply via Telegram, Discord, WeChat (微信), Feishu (飞书),
QQ, Slack, WhatsApp. Channels are OC infrastructure — RC reuses them fully.

## Connection Protocols

### Bot-Token Type (Telegram / Discord / Feishu / QQ / Slack)

1. Guide user to create a bot on the platform and obtain a token.
2. Write config via `config.patch`:
   - Telegram: `{ channels: { telegram: { botToken: "...", enabled: true } } }`
   - Discord: `{ channels: { discord: { token: "...", enabled: true } } }`
   - Others: see platform OC docs for field names.
3. Telegram: user must send "/start" in the bot chat to receive replies.
4. `commands.native` must be `false` (530+ tools exceed IM menu limits).
   `sync-global-config.cjs` auto-fixes this on startup.

### WeChat (微信) — QR Scan

**Prerequisite**: `openclaw-weixin` plugin installed and in `plugins.allow`.

1. Call `web.login.start {}` RPC.
2. Returns `{ qrDataUrl: "https://..." }` — HTTP URL, not base64.
3. Display: `![qr](qrDataUrl value)`.
4. Prompt user to scan with WeChat.
5. Call `web.login.wait { timeoutMs: 60000 }` to await confirmation.
6. On success, plugin auto-saves credentials; gateway auto-starts channel.
7. WeChat cannot send proactive messages — replies only (contextToken mechanism).

### WhatsApp — QR Scan

1. Call `web.login.start {}` → returns `{ qrDataUrl: "data:image/png;base64,..." }`.
2. Display: `![qr](data:image/png;base64,...)`.
3. Call `web.login.wait { timeoutMs: 60000 }` to await connection.

## In-Channel Behavior

- All RC tools (library, tasks, workspace, monitor) are **fully available**.
- Keep replies under 2000 characters (IM message limit).
- Do not use Markdown tables (most IM clients do not render them).
- `approval_card` degrades to text: "需要审批: xxx. 回复 yes/no".
- Media requires absolute paths via the media parameter.
- Peer ID formats differ: WeChat `xxx@im.wechat`, Telegram numeric IDs.

## Diagnostics

If a channel shows "not configured" or "Error":

1. **plugins.allow** — is the channel plugin listed?
2. **Credential path** — correct location? WeChat: `~/.openclaw/openclaw-weixin/accounts/`. Telegram/Discord: OC config.
3. **Gateway restart** — restarted after credentials placed? Runtime caches state at startup.
4. **better-sqlite3 ABI** — native module must match gateway's Node version.

## Related Research-Plugins Skills

No RP skills directly apply to IM channel configuration. Channels are OC infrastructure.
