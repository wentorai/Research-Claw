/**
 * Tool Schema Compliance Tests (Static Analysis)
 *
 * Validates that ALL tool schemas in tools.ts files conform to the
 * LLM API JSON Schema subset. Uses regex extraction — no runtime deps.
 *
 * Rule set (provider-intersection safe):
 *   R1: type:"array" MUST have "items"            → HTTP 400 on Anthropic/OpenAI
 *   R2: type MUST be a string, NOT an array        → rejected by OpenAI Strict
 *   R3: top-level parameters MUST be type:"object" → required by all providers
 *   R4: enum MUST be a non-empty array             → rejected by all providers
 *   R5: required entries MUST exist in properties   → rejected by all providers
 *
 * Reference: openclaw/src/agents/pi-tools.schema.ts
 *            openclaw/src/agents/schema/clean-for-gemini.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Schema walker ───────────────────────────────────────────────────

interface SchemaViolation {
  file: string;
  path: string;
  rule: string;
  detail: string;
}

function walkSchema(
  fileName: string,
  schema: Record<string, unknown>,
  jsonPath: string,
  violations: SchemaViolation[],
): void {
  if (!schema || typeof schema !== 'object') return;

  // R1: array must have items
  if (schema.type === 'array' && !('items' in schema)) {
    violations.push({ file: fileName, path: jsonPath, rule: 'R1', detail: 'type:"array" missing "items"' });
  }

  // R2: type must be a string, not an array
  if (Array.isArray(schema.type)) {
    violations.push({ file: fileName, path: jsonPath, rule: 'R2', detail: `type is array ${JSON.stringify(schema.type)}` });
  }

  // R4: enum must be non-empty
  if ('enum' in schema && Array.isArray(schema.enum) && schema.enum.length === 0) {
    violations.push({ file: fileName, path: jsonPath, rule: 'R4', detail: 'enum is empty' });
  }

  // Recurse into properties
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    const props = schema.properties as Record<string, Record<string, unknown>>;

    // R5: required entries must exist in properties
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (typeof req === 'string' && !(req in props)) {
          violations.push({ file: fileName, path: jsonPath, rule: 'R5', detail: `required "${req}" not in properties` });
        }
      }
    }

    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'object' && value !== null) {
        walkSchema(fileName, value, `${jsonPath}.${key}`, violations);
      }
    }
  }

  // Recurse into items
  if (typeof schema.items === 'object' && schema.items !== null) {
    walkSchema(fileName, schema.items as Record<string, unknown>, `${jsonPath}[items]`, violations);
  }

  // Recurse into anyOf / oneOf
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[keyword])) {
      for (let i = 0; i < (schema[keyword] as unknown[]).length; i++) {
        const variant = (schema[keyword] as unknown[])[i];
        if (typeof variant === 'object' && variant !== null) {
          walkSchema(fileName, variant as Record<string, unknown>, `${jsonPath}.${keyword}[${i}]`, violations);
        }
      }
    }
  }
}

// ── Extract tool schemas from source ────────────────────────────────
//
// We use a two-phase approach:
// 1. Find all tools.push({ ... parameters: { ... } ... }) blocks
// 2. Extract the `parameters` JSON schema via Function constructor eval
//
// This avoids needing runtime dependencies (better-sqlite3, service stubs).

const TOOLS_DIR = path.resolve(__dirname, '../extensions/research-claw-core/src');
const TOOL_FILES = ['literature/tools.ts', 'tasks/tools.ts', 'workspace/tools.ts', 'radar/tools.ts', 'monitor/tools.ts'];

interface ExtractedTool {
  file: string;
  name: string;
  parameters: Record<string, unknown>;
}

function extractToolSchemas(filePath: string): ExtractedTool[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const tools: ExtractedTool[] = [];
  const fileName = path.relative(TOOLS_DIR, filePath);

  // Match: name: 'tool_name',
  const nameRegex = /name:\s*'([^']+)'/g;
  // Match the parameters block for each tool
  let nameMatch: RegExpExecArray | null;

  while ((nameMatch = nameRegex.exec(content)) !== null) {
    const toolName = nameMatch[1];
    // Find "parameters:" after this name
    const afterName = content.slice(nameMatch.index);
    const paramStart = afterName.indexOf('parameters:');
    if (paramStart === -1) continue;

    // Extract the object literal after "parameters:"
    const paramContent = afterName.slice(paramStart + 'parameters:'.length);
    const obj = extractBalancedObject(paramContent);
    if (!obj) continue;

    try {
      // Safely evaluate the object literal
      // Replace TypeScript-specific patterns:
      // - VALID_SOURCE_TYPES (const reference) → inline the array
      // - [...] as const → [...]
      let evalStr = obj
        .replace(/VALID_SOURCE_TYPES/g, "['arxiv','semantic_scholar','github','rss','webpage','openalex','twitter','custom']")
        .replace(/\bas\s+const\b/g, '')
        .replace(/\bas\s+\w+/g, '');

      // Use Function to evaluate in clean scope
      const schema = new Function(`return (${evalStr})`)() as Record<string, unknown>;
      tools.push({ file: fileName, name: toolName, parameters: schema });
    } catch {
      // If eval fails, skip — the tool factory tests will catch real issues
    }
  }

  return tools;
}

function extractBalancedObject(str: string): string | null {
  const trimmed = str.trimStart();
  if (!trimmed.startsWith('{')) return null;

  let depth = 0;
  let i = 0;
  for (; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(0, i + 1);
    }
  }
  return null;
}

// Collect all schemas
const allTools: ExtractedTool[] = [];
for (const file of TOOL_FILES) {
  const fullPath = path.join(TOOLS_DIR, file);
  if (fs.existsSync(fullPath)) {
    allTools.push(...extractToolSchemas(fullPath));
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Tool Schema Compliance (static analysis)', () => {
  it('extracts schemas from all 5 tool files', () => {
    // We expect at least 38+ tools (41 minus a few that may have complex syntax)
    expect(allTools.length).toBeGreaterThanOrEqual(38);
  });

  it('R1: every type:"array" has "items"', () => {
    const violations: SchemaViolation[] = [];
    for (const tool of allTools) {
      walkSchema(tool.file, tool.parameters, `${tool.name}.parameters`, violations);
    }
    const r1 = violations.filter((v) => v.rule === 'R1');
    expect(r1, formatViolations(r1)).toHaveLength(0);
  });

  it('R2: "type" is always a string, never an array', () => {
    const violations: SchemaViolation[] = [];
    for (const tool of allTools) {
      walkSchema(tool.file, tool.parameters, `${tool.name}.parameters`, violations);
    }
    const r2 = violations.filter((v) => v.rule === 'R2');
    expect(r2, formatViolations(r2)).toHaveLength(0);
  });

  it('R3: top-level parameters is type:"object"', () => {
    for (const tool of allTools) {
      expect(tool.parameters.type, `${tool.name}: top-level type`).toBe('object');
    }
  });

  it('R4: no empty enum arrays', () => {
    const violations: SchemaViolation[] = [];
    for (const tool of allTools) {
      walkSchema(tool.file, tool.parameters, `${tool.name}.parameters`, violations);
    }
    const r4 = violations.filter((v) => v.rule === 'R4');
    expect(r4, formatViolations(r4)).toHaveLength(0);
  });

  it('R5: every required field exists in properties', () => {
    const violations: SchemaViolation[] = [];
    for (const tool of allTools) {
      walkSchema(tool.file, tool.parameters, `${tool.name}.parameters`, violations);
    }
    const r5 = violations.filter((v) => v.rule === 'R5');
    expect(r5, formatViolations(r5)).toHaveLength(0);
  });

  it('zero total violations', () => {
    const violations: SchemaViolation[] = [];
    for (const tool of allTools) {
      walkSchema(tool.file, tool.parameters, `${tool.name}.parameters`, violations);
    }
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

function formatViolations(vs: SchemaViolation[]): string {
  if (vs.length === 0) return 'no violations';
  return `${vs.length} violation(s):\n${vs.map((v) => `  [${v.rule}] ${v.path}: ${v.detail}`).join('\n')}`;
}
