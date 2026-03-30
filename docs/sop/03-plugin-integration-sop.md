# S3 — Plugin Integration SOP

> Development standards and operation log for plugin ecosystem integration
> Covers: 05 (Plugin Integration Guide) + wentor-connect + research-plugins

---

## 1. Scope

This SOP governs:
1. **research-plugins** integration — 478 items (438 Skills + 34 Agent Tools + 6 Curated Lists) from `@wentorai/research-plugins`
2. **wentor-connect** plugin — OAuth, sync, telemetry (post-MVP placeholder)
3. **Third-party plugin** compatibility and testing
4. **Plugin SDK** usage patterns and best practices

**Owner track:** Plugin Integration team / agent
**Source files:** `extensions/wentor-connect/`, npm packages
**Design doc:** `docs/05-plugin-integration-guide.md`

---

## 2. Architecture Summary

### 2.1 Plugin Types in Research-Claw

| Plugin | Type | Status | Priority |
|--------|------|--------|----------|
| `research-claw-core` | Tool + RPC | Scaffold | P0 (MVP) |
| `@wentorai/research-plugins` | Skills + Tools + MCPs | Published v1.3.2 | P0 |
| `wentor-connect` | Tool + HTTP | Placeholder | P1 (post-MVP) |
| Zotero | Tool | Planned | P1 |
| QQ (`@tencent-connect/openclaw-qqbot`) | Channel | Available | P1 |
| DingTalk / Email | Channel | Planned | P2 |

### 2.2 Plugin Discovery Pipeline

OpenClaw discovers plugins in this order:
1. Bundled plugins (`dist/plugins/`)
2. Config-defined paths (`plugins.load.paths[]`)
3. User extensions (`~/.openclaw/config/extensions/`)
4. Workspace extensions (`./extensions/`)

Research-Claw config (`openclaw.json`) adds:
```json
{
  "plugins": {
    "entries": {
      "research-claw-core": { "enabled": true, "config": {...} },
      "wentor-connect": { "enabled": false }
    }
  }
}
```

### 2.3 Skill vs Plugin Decision Tree

| Need | Choice | Reason |
|------|--------|--------|
| Pure knowledge/docs | Skill (SKILL.md) | Agent reads text, no code |
| CLI tool guidance | Skill | Agent constructs commands |
| High-frequency API calls | Plugin (tool) | Type validation, reliable |
| Parameter validation needed | Plugin (tool) | TypeBox schema checking |
| Background service/HTTP | Plugin (service) | Lifecycle management |
| IM integration | Plugin (channel) | ChannelPlugin interface |
| Combined knowledge + tool | Plugin + bundled Skills | Best of both |

### 2.4 research-plugins Content

| Category | Count | Type |
|----------|------:|------|
| Skills | 438 | SKILL.md files (+ 40 index skills = 478 total) |
| Agent Tools | 34 | TypeScript tool factories (18 modules) |
| Curated Lists | 6 | Recommended combinations |
| **Total** | **478** | MCP configs archived in v1.4.0 |

**Installation:** `openclaw plugins install @wentorai/research-plugins`

**Auto-load via config:**
```json
"skills": {
  "load": {
    "extraDirs": [
      "./node_modules/@wentorai/research-plugins/skills",
      "./skills"
    ]
  }
}
```

### 2.5 wentor-connect Plugin (Post-MVP)

**Planned features:**
- OAuth: Browser -> wentor.ai -> local token exchange
- Sync: Community skill scores, new skills download
- Reporting: Opt-in anonymous usage statistics
- Community: Post/comment/vote via API proxy

**Plugin structure:**
```
extensions/wentor-connect/
+-- openclaw.plugin.json
+-- package.json
+-- index.ts (stub)
```

**Custom RPC methods (planned):**
- `wentor.account.status` — Check account link status
- `wentor.account.link` — OAuth initiation
- `wentor.skills.sync` — Sync community scores
- `wentor.skills.trending` — Get trending skills

**Custom HTTP endpoint (planned):**
- `GET /plugins/wentor/oauth/callback` — OAuth redirect handler

---

## 3. Development Standards

### 3.1 Plugin Manifest

Every plugin must have `openclaw.plugin.json`:
```json
{
  "id": "plugin-id",
  "name": "Plugin Name",
  "description": "One-line description",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": { ... }
  }
}
```

### 3.2 Plugin Entry Point

```typescript
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

export async function activate(api: PluginRuntime): Promise<void> {
  // Register tools, RPC handlers, HTTP routes, services
}

export async function deactivate(): Promise<void> {
  // Cleanup
}
```

### 3.3 Tool Factory Pattern

```typescript
import { Type } from "@sinclair/typebox";

const AddPaperParams = Type.Object({
  doi: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  bibtex: Type.Optional(Type.String()),
});

export function createLiteratureTools(service: LiteratureService) {
  return [
    {
      name: "library_add_paper",
      description: "Add a paper to the local library by DOI, title, or BibTeX",
      parameters: AddPaperParams,
      execute: async (params) => service.addPaper(params),
    },
    // ... more tools
  ];
}
```

### 3.4 RPC Handler Pattern

```typescript
export function registerLiteratureRPC(api: PluginRuntime, service: LiteratureService) {
  api.registerGatewayMethod("rc.lit.list", async ({ params, respond }) => {
    const result = await service.listPapers(params);
    respond(true, result);
  });
  // ... more handlers
}
```

### 3.5 HTTP Route Pattern

```typescript
api.registerHttpRoute({
  path: "/rc/upload",
  method: "POST",
  auth: "gateway",    // or "plugin" or "none"
  match: "exact",     // or "prefix"
  handler: async (req, res) => {
    // Handle multipart upload
  },
});
```

### 3.6 Plugin HTTP Route Scope (v2026.3.8 Breaking Change)

OpenClaw commit `a1520d70f` introduced scope enforcement for plugin HTTP handlers:

- **`auth: "plugin"` routes** receive `WRITE_SCOPE` only (no admin privileges)
- **`auth: "gateway"` routes** receive full scope (`ADMIN + APPROVALS + PAIRING`)
- Plugin routes using `runtime.subagent.*` calls now receive scoped gateway clients

**Impact on Research-Claw plugins:**
- `wentor-connect` OAuth callback uses `auth: "gateway"` → unaffected
- `/rc/upload` uses `auth: "gateway"` → unaffected
- Any future `auth: "plugin"` routes must NOT rely on admin scope

**Device token rotation:** `device.token.rotate` now enforces caller-scope subsetting. Plugins cannot request elevated scopes beyond what they hold.

### 3.7 Testing

- Plugin activation: mock PluginRuntime
- Tool validation: test TypeBox schema with edge cases
- RPC round-trip: mock WS connection
- research-plugins: verify skill loading + count
- wentor-connect: OAuth flow mock

### 3.8 PR Checklist

- [ ] `openclaw.plugin.json` is valid JSON with correct schema
- [ ] Plugin activates without errors in test environment
- [ ] All registered tool names match `config.tools.alsoAllow` list
- [ ] RPC method names use `rc.*` namespace (no collisions with OpenClaw built-ins)
- [ ] HTTP routes use `/rc/` or `/plugins/wentor/` prefix
- [ ] Config schema has sensible defaults
- [ ] `pnpm build` compiles without errors

---

## 4. Integration Testing Checklist

### 4.1 research-plugins

- [ ] `pnpm install @wentorai/research-plugins` succeeds
- [ ] Skill files appear under `node_modules/@wentorai/research-plugins/skills/`
- [ ] Gateway loads skills from `extraDirs` path
- [ ] Agent can reference research skills in conversation
- [ ] Skill count matches expected (438 + 40 indexes)

### 4.2 research-claw-core

- [ ] Plugin manifest validates
- [ ] `pnpm build` in extensions/research-claw-core succeeds
- [ ] Gateway discovers and activates plugin
- [ ] SQLite DB created at configured path
- [ ] All 62 WS RPC methods respond (even if stub)
- [ ] All 31 agent tools register
- [ ] HTTP upload endpoint responds

### 4.3 wentor-connect (Post-MVP)

- [ ] Plugin disabled by default in config
- [ ] Enabling doesn't break gateway startup
- [ ] OAuth callback endpoint registered
- [ ] Account link flow works end-to-end

---

## 5. Operation Log

> Append entries as work progresses.

### 5.1 research-plugins

- [2026-03-11] v1.0.0 published to NPM + PyPI + GitHub
- [2026-03-11] v1.1.0 content complete (S1-S10), awaiting publish
- [2026-03-14] v1.3.2 published — 432 skills, 13 tools, progressive disclosure architecture
- [2026-03-18] v1.4.0 published — 438 skills, 34 tools (18 modules), MCP configs archived

### 5.2 wentor-connect

- [2026-03-11] [Claude] Placeholder stub created

### 5.3 Third-party Plugins

<!-- Append entries here -->

### 5.4 Issues & Fixes

<!-- Append entries here -->

---

## 6. Dependencies on Other Tracks

| Dependency | Track | Blocks |
|------------|-------|--------|
| Plugin core service classes | Modules (S2) | Tool + RPC registration |
| Skill display in dashboard | Dashboard (S1) | Skills panel |
| Agent knows tool usage | Prompt (S4) | TOOLS.md references |
| Web platform OAuth | External (wentor.ai) | wentor-connect |

---

*Document: S3 | Track: Plugin Integration | Created: 2026-03-11*
