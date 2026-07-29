# Research-Claw Infra Bootstrap Report

## OpenClaw Version

- **Package**: `openclaw@2026.3.8` (latest as of 2026-03-11; 2026.3.9 does not exist)
- **Branding verified**: `node ./node_modules/openclaw/dist/entry.js --version` → `Research-Claw 2026.3.8 (3caab92)`

## Plugin SDK Import Path

- **Subpath**: `openclaw/plugin-sdk`
- **Resolved physical path**: `node_modules/.pnpm/openclaw@2026.3.8_<hash>/node_modules/openclaw/dist/plugin-sdk/index.js`
- **Exports**: `definePlugin`, `definePluginTool`, `PluginContext`, `PluginToolHandler`, etc.
- **Usage**: `import { definePlugin } from 'openclaw/plugin-sdk'` (works from any workspace package)

## better-sqlite3

- **Status**: Compiles and loads successfully via openclaw's bundled dependency
- **Verified from**: `extensions/research-claw-core/` directory
- **No manual native rebuild required** on macOS (Node 22, arm64)

## Dist File Structure (Patched Files)

OpenClaw dist uses **hashed chunk filenames** (e.g., `chunk-XXXXXXXX.js`). Only two files have stable names containing branding strings:

| File | Replacements | What changed |
|------|-------------|--------------|
| `dist/entry.js` | 7 | process.title, version display, 5 log/error prefixes |
| `dist/cli/daemon-cli.js` | 4 | 4 legacy daemon error messages |

**Patch file**: `patches/openclaw@2026.3.8.patch` (78 lines, <100 line budget)

## pnpm Patch Workflow

```bash
# Generate patch (already done):
pnpm patch openclaw --edit-dir /tmp/openclaw-patch
# ... edit files in /tmp/openclaw-patch ...
pnpm patch-commit /tmp/openclaw-patch

# Auto-added to package.json:
# "pnpm": { "patchedDependencies": { "openclaw@2026.3.8": "patches/openclaw@2026.3.8.patch" } }
```

Patch applies automatically on `pnpm install --frozen-lockfile`.

## Gateway Startup

- **Start command**: `node ./node_modules/openclaw/dist/entry.js gateway run --allow-unconfigured --port 28789`
- **`--config` flag does NOT exist** — gateway discovers config via `~/.openclaw/` or `--dev` flag
- **Healthz**: `curl http://127.0.0.1:28789/healthz` → HTTP 200, `{"ok":true,"status":"live"}`
- **WS endpoint**: `ws://127.0.0.1:28789`
- **Plugins auto-load**: research-plugins discovered from `~/.openclaw/extensions/`

## System Dependencies

| Dependency | Version | Notes |
|-----------|---------|-------|
| Node.js | >= 22.12.0 | Required by openclaw |
| pnpm | 10.34.4 | Workspace + patch support |
| Python | 3.x | For node-gyp (better-sqlite3 build) |
| Xcode CLI Tools | latest | macOS native compilation |

## Known Issues

1. **No `postinstall` script needed** — pnpm patch applies at install time automatically via `patchedDependencies`
2. **Canvas path still says "openclaw"**: `/__openclaw__/canvas/` — this is internal gateway routing, not user-visible, and is in hashed chunks (not patchable without fragile changes)
3. **Log file path**: `/tmp/openclaw/openclaw-*.log` — uses openclaw's default, acceptable for satellite
