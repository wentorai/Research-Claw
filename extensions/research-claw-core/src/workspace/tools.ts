/**
 * workspace/tools — 11 Agent Tool Registrations
 *
 * Registers workspace_save, workspace_read, workspace_list, workspace_diff,
 * workspace_history, workspace_restore, workspace_move, workspace_export,
 * workspace_delete, workspace_append, and workspace_download
 * as OpenClaw agent tools.
 *
 * All tools delegate to WorkspaceService (no direct DB or Git access).
 * Uses plain JSON Schema objects for parameter definitions.
 */

// Note: Tool parameters use raw JSON Schema objects for simplicity.
// The spec suggests TypeBox (@sinclair/typebox) but raw schemas are
// functionally equivalent and avoid an additional abstraction layer.

import * as path from 'node:path';
import * as net from 'node:net';
import type { WorkspaceService, TreeNode } from './service.js';
import {
  convertFile,
  isSupportedFormat,
  isValidSource,
  validSourceExts,
  SUPPORTED_FORMATS,
} from './export-convert.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string, details: unknown): unknown {
  return { content: [{ type: 'text', text }], details };
}

// MIME extension → card mime_type mapping
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', tex: 'text/x-latex', bib: 'application/x-bibtex', ris: 'application/x-research-info-systems',
  csv: 'text/csv', json: 'application/json', yaml: 'text/x-yaml', yml: 'text/x-yaml',
  py: 'text/x-python', r: 'text/x-r', jl: 'text/x-julia', m: 'text/x-matlab',
  js: 'text/javascript', ts: 'text/typescript',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  svg: 'image/svg+xml', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

// ---------------------------------------------------------------------------
// SSRF guard — block requests to private/internal networks
// ---------------------------------------------------------------------------

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Hostnames that must never be fetched. */
const BLOCKED_HOSTS = new Set([
  'localhost', '0.0.0.0', '[::]', '[::1]',
  'metadata.google.internal',   // GCP metadata
  'metadata.internal',
]);

/** Check if an IPv4 address belongs to a private/reserved range. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local + cloud metadata)
  if (a === 0) return true;                            // 0.0.0.0/8
  return false;
}

/** Validate a URL is safe for outbound fetch (not internal/private). */
function validateDownloadUrl(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return 'Invalid URL format';
  }

  if (!parsed.protocol.startsWith('http')) {
    return 'Only HTTP/HTTPS URLs are supported';
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname)) {
    return `Blocked host: ${hostname}`;
  }

  // Check if hostname is an IP address
  if (net.isIPv4(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return `Blocked: private/internal IP address ${hostname}`;
    }
  } else if (net.isIPv6(hostname) || hostname.startsWith('[')) {
    // Block all IPv6 literals — too many reserved ranges to enumerate safely
    const raw = hostname.replace(/^\[|\]$/g, '');
    if (raw === '::1' || raw === '::' || raw.startsWith('fe80') || raw.startsWith('fc') || raw.startsWith('fd')) {
      return `Blocked: private/internal IPv6 address`;
    }
  }

  return null; // safe
}

// ---------------------------------------------------------------------------
// Binary format guard — prevents writing text to binary file extensions
// ---------------------------------------------------------------------------

/** Extensions that are binary formats and cannot be created from plain text. */
const BINARY_SAVE_GUARD = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.odt', '.ods',
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.ico', '.webp',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.hdf5', '.h5', '.parquet', '.sqlite', '.db',
  '.npy', '.npz',
  '.exe', '.dll', '.so', '.dylib',
  '.mp4', '.avi', '.mov', '.mkv', '.mp3', '.wav', '.flac',
]);

/** Suggest the correct text source format for each binary target. */
const BINARY_TO_TEXT: Record<string, string> = {
  '.docx': '.md', '.doc': '.md',
  '.xlsx': '.csv', '.xls': '.csv',
  '.pptx': '.md',
  '.pdf': '.md',
  '.odt': '.md', '.ods': '.csv',
};

/**
 * Flatten a TreeNode[] into a flat list of file entries (excluding directories).
 */
function flattenTree(nodes: readonly TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node);
    }
    if (node.children) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

/**
 * Simple glob-like pattern matching. Supports:
 *  - "*" wildcard segments
 *  - "*.ext" suffix matching
 *  - "**\/*.ext" recursive suffix matching
 *  - Plain substring matching as fallback
 */
function matchPattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;

  // "*.ext" — match files ending with .ext
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1); // ".ext"
    return filePath.endsWith(ext);
  }

  // "**/*.ext" — match files ending with .ext anywhere in tree
  if (pattern.startsWith('**/')) {
    const sub = pattern.slice(3);
    return matchPattern(filePath, sub);
  }

  // Contains check as fallback
  return filePath.includes(pattern);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../types.js';

/**
 * Create the 11 workspace agent tools.
 *
 * @param service   - WorkspaceService instance to delegate operations to
 * @returns Array of tool definitions to register
 */
export function createWorkspaceTools(service: WorkspaceService): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // -----------------------------------------------------------------------
  // 1. workspace_save
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_save',
    description:
      'Save or create a text file in the research workspace. Automatically commits to Git. ' +
      'Convention: agent-generated files → outputs/, user uploads → uploads/. ' +
      'Use paths relative to workspace root (e.g. "outputs/drafts/review.md").',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'File path relative to workspace root (e.g. "outputs/drafts/review.md")',
        },
        content: {
          type: 'string',
          description: 'File content to write (UTF-8 text)',
        },
        commit_message: {
          type: 'string',
          maxLength: 200,
          description: 'Custom git commit message. If omitted, an auto-generated message is used.',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.path !== 'string' || !params.path.trim()) {
          return fail('path is required and must be a non-empty string');
        }
        if (typeof params.content !== 'string') {
          return fail('content is required and must be a string');
        }
        const filePath = params.path.trim();
        const content = params.content;
        const commitMessage = typeof params.commit_message === 'string' ? params.commit_message : undefined;

        // Guard: reject text writes to known binary formats (Issue #38)
        const ext = path.extname(filePath).toLowerCase();
        if (BINARY_SAVE_GUARD.has(ext)) {
          const textExt = BINARY_TO_TEXT[ext] ?? '.md';
          const textPath = filePath.replace(/\.[^.]+$/, textExt);
          const fmt = ext.slice(1);
          return fail(
            `Cannot write "${ext}" files directly — "${ext}" is a binary format ` +
            `that cannot be created from plain text.\n\n` +
            `Correct workflow:\n` +
            `1. Save content as "${textExt}" first: workspace_save("${textPath}", content)\n` +
            `2. Convert to "${ext}": workspace_export({ source: "${textPath}", format: "${fmt}" })`,
          );
        }

        const result = await service.save(filePath, content, commitMessage);

        // Build file_card JSON block so the LLM includes it in its response
        const fileExt = path.extname(filePath).slice(1).toLowerCase();
        const mimeType = EXT_MIME[fileExt] ?? 'application/octet-stream';
        const gitStatus = result.committed ? 'committed' : 'new';
        const cardJson = JSON.stringify({
          type: 'file_card',
          name: path.basename(filePath),
          path: result.path,
          size_bytes: result.size,
          mime_type: mimeType,
          git_status: gitStatus,
        });

        const overwriteNote = !result.is_new
          ? `\n⚠️ Overwrote existing file. Previous version is in git history.`
          : '';
        return ok(
          `Saved ${result.path} (${result.size} bytes, committed: ${result.committed})${overwriteNote}\n\nInclude this card in your response:\n\`\`\`file_card\n${cardJson}\n\`\`\``,
          { path: result.path, size: result.size, committed: result.committed, commit_hash: result.commit_hash },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 2. workspace_read
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_read',
    description:
      'Read a file from the research workspace. Returns UTF-8 content for text files ' +
      'or base64-encoded content for binary files, along with file metadata.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'File path relative to workspace root',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.path !== 'string' || !params.path.trim()) {
          return fail('path is required and must be a non-empty string');
        }
        const filePath = params.path.trim();

        const result = await service.read(filePath);

        return ok(
          `Read ${filePath} (${result.size} bytes, ${result.mime_type})`,
          {
            content: result.content,
            path: filePath,
            size: result.size,
            mime_type: result.mime_type,
            git_status: result.git_status,
            encoding: result.encoding,
            modified_at: result.modified_at,
          },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 3. workspace_list
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_list',
    description:
      'List files in the research workspace. Optionally filter by directory, ' +
      'recurse into subdirectories, or match a glob pattern (e.g. "*.pdf", "*.md").',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Subdirectory relative to workspace root. Defaults to workspace root.',
        },
        recursive: {
          type: 'boolean',
          default: false,
          description: 'List files recursively. Default: false.',
        },
        pattern: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.pdf", "**/*.md").',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const directory = typeof params.directory === 'string' ? params.directory : undefined;
        const recursive = typeof params.recursive === 'boolean' ? params.recursive : undefined;
        const pattern = typeof params.pattern === 'string' ? params.pattern : undefined;

        // Use depth 1 for non-recursive, 10 for recursive
        const depth = recursive ? 10 : 1;
        const { tree } = await service.tree(directory, depth);

        // Flatten the tree to a flat file list
        let files = flattenTree(tree);

        // Apply pattern filter if provided
        if (pattern) {
          files = files.filter((f) => matchPattern(f.path, pattern));
        }

        // Sort by modified_at descending (most recent first)
        files.sort((a, b) => {
          const aTime = a.modified_at ?? '';
          const bTime = b.modified_at ?? '';
          return bTime.localeCompare(aTime);
        });

        // Cap at 500 entries
        const total = files.length;
        const capped = files.slice(0, 500);

        const mappedFiles = capped.map((f) => ({
          name: f.name,
          path: f.path,
          type: f.type,
          size: f.size,
          mime_type: f.mime_type,
          modified_at: f.modified_at,
          git_status: f.git_status,
        }));

        return ok(`Found ${total} file(s)${pattern ? ` matching "${pattern}"` : ''}`, { files: mappedFiles, total });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 4. workspace_diff
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_diff',
    description:
      'Show git diff for the research workspace. Can show uncommitted changes, ' +
      'changes to a specific file, or changes between two commits (e.g. "abc1234..def5678").',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace root. If omitted, diff all changes.',
        },
        commit_range: {
          type: 'string',
          description:
            'Git commit range (e.g. "abc1234..def5678", "HEAD~3..HEAD"). If omitted, show uncommitted changes.',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const filePath = typeof params.path === 'string' ? params.path : undefined;
        const commitRange = typeof params.commit_range === 'string' ? params.commit_range : undefined;

        // Parse commit_range "from..to" into separate from/to values
        let from: string | undefined;
        let to: string | undefined;

        if (commitRange) {
          const dotIdx = commitRange.indexOf('..');
          if (dotIdx !== -1) {
            from = commitRange.slice(0, dotIdx) || undefined;
            to = commitRange.slice(dotIdx + 2) || undefined;
          } else {
            // Single ref — treat as "to" (diff against its parent)
            to = commitRange;
          }
        }

        const result = await service.diff(filePath, from, to);

        return ok(
          `Diff: ${result.files_changed} file(s) changed, +${result.insertions} -${result.deletions}`,
          { diff: result.diff, files_changed: result.files_changed, insertions: result.insertions, deletions: result.deletions },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 5. workspace_history
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_history',
    description:
      'Show git commit history for the research workspace or a specific file. ' +
      'Returns a list of commits with hashes, messages, authors, and file change counts.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to show history for. If omitted, show full workspace history.',
        },
        limit: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of commits to return. Default: 20.',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const filePath = typeof params.path === 'string' ? params.path : undefined;
        const rawLimit = typeof params.limit === 'number' ? params.limit : undefined;
        const limit = Math.min(Math.max(rawLimit ?? 20, 1), 100);

        const result = await service.history(filePath, limit);

        return ok(
          `History: ${result.commits.length} commit(s) (total: ${result.total})`,
          { commits: result.commits, total: result.total, has_more: result.has_more },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 6. workspace_restore
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_restore',
    description:
      'Restore a file in the research workspace to a previous version from git history. ' +
      'Creates a new commit with the restored content.',
    parameters: {
      type: 'object',
      required: ['path', 'commit_hash'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'File path relative to workspace root',
        },
        commit_hash: {
          type: 'string',
          minLength: 4,
          maxLength: 40,
          pattern: '^[a-f0-9]+$',
          description: 'Git commit hash (short or full) to restore from',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.path !== 'string' || !params.path.trim()) {
          return fail('path is required and must be a non-empty string');
        }
        if (typeof params.commit_hash !== 'string' || !params.commit_hash.trim()) {
          return fail('commit_hash is required and must be a non-empty string');
        }
        const filePath = params.path.trim();
        const commitHash = params.commit_hash.trim();

        const result = await service.restore(filePath, commitHash);

        return ok(
          `Restored ${result.path} from ${result.restored_from}`,
          { path: result.path, restored_from: result.restored_from, new_commit: result.new_commit },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 7. workspace_move
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_move',
    description:
      'Move or rename a file or directory within the research workspace. ' +
      'Automatically commits the change to Git. Both paths are relative to the workspace root.',
    parameters: {
      type: 'object',
      required: ['from', 'to'],
      properties: {
        from: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Source path relative to workspace root (e.g. "outputs/drafts/old-name.md")',
        },
        to: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Destination path relative to workspace root (e.g. "outputs/drafts/new-name.md")',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.from !== 'string' || !params.from.trim()) {
          return fail('from is required and must be a non-empty string');
        }
        if (typeof params.to !== 'string' || !params.to.trim()) {
          return fail('to is required and must be a non-empty string');
        }
        const fromPath = params.from.trim();
        const toPath = params.to.trim();

        const result = await service.move(fromPath, toPath);

        return ok(
          `Moved "${fromPath}" → "${toPath}" (committed: ${result.committed})`,
          { from: result.from, to: result.to, committed: result.committed },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 8. workspace_export (Issue #38 — binary format conversion)
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_export',
    description:
      'Convert a text file in the workspace to a binary document format. ' +
      'Use this instead of workspace_save for binary formats. ' +
      'Supported: md/txt → docx, md/txt → pdf (with CJK support), csv/json → xlsx. ' +
      'The source file must already exist in the workspace (save it first with workspace_save).',
    parameters: {
      type: 'object',
      required: ['source', 'format'],
      properties: {
        source: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Source file path relative to workspace root (must be a text file, e.g. "outputs/drafts/review.md")',
        },
        format: {
          type: 'string',
          enum: SUPPORTED_FORMATS,
          description: `Target output format: ${SUPPORTED_FORMATS.join(', ')}`,
        },
        output: {
          type: 'string',
          maxLength: 512,
          description: 'Output file path relative to workspace root. Default: same name with new extension in outputs/exports/',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.source !== 'string' || !params.source.trim()) {
          return fail('source is required and must be a non-empty string');
        }
        if (typeof params.format !== 'string' || !params.format.trim()) {
          return fail('format is required and must be a non-empty string');
        }

        const source = params.source.trim();
        const format = params.format.trim().toLowerCase();

        if (!isSupportedFormat(format)) {
          return fail(`Unsupported format: "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}`);
        }

        if (!isValidSource(source, format)) {
          const valid = validSourceExts(format);
          return fail(
            `Cannot convert "${path.extname(source)}" to "${format}". ` +
            `Valid source formats: ${valid.join(', ')}`,
          );
        }

        // Resolve output path
        let outputRelative: string;
        if (typeof params.output === 'string' && params.output.trim()) {
          outputRelative = params.output.trim();
        } else {
          // Default: outputs/exports/{basename}.{format}
          const baseName = path.basename(source, path.extname(source));
          outputRelative = `outputs/exports/${baseName}.${format}`;
        }

        // Use service.resolvePath for security (path traversal guard)
        const srcAbsPath = service.resolvePath(source);
        const destAbsPath = service.resolvePath(outputRelative);

        const result = await convertFile(srcAbsPath, destAbsPath, format);

        // Auto-commit the generated file
        let committed = false;
        let commitHash: string | undefined;
        try {
          const saveResult = await service.commitGeneratedFile(
            outputRelative,
            `Export: ${path.basename(source)} → ${path.basename(outputRelative)}`,
          );
          committed = saveResult.committed;
          commitHash = saveResult.hash;
        } catch {
          // Git failure is non-fatal
        }

        // Build file_card
        const mimeType = EXT_MIME[format] ?? 'application/octet-stream';
        const cardJson = JSON.stringify({
          type: 'file_card',
          name: path.basename(outputRelative),
          path: outputRelative,
          size_bytes: result.size,
          mime_type: mimeType,
          git_status: committed ? 'committed' : 'new',
        });

        return ok(
          `Exported ${source} → ${outputRelative} (${result.size} bytes, format: ${format})\n\n` +
          `Include this card in your response:\n\`\`\`file_card\n${cardJson}\n\`\`\``,
          {
            source,
            output: outputRelative,
            size: result.size,
            format,
            committed,
            commit_hash: commitHash,
          },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 9. workspace_delete
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_delete',
    description:
      'Delete a file from the research workspace. The deletion is committed to Git, ' +
      'so the file can be recovered with workspace_restore if needed. ' +
      'Requires confirm=true as a safety guard.',
    parameters: {
      type: 'object',
      required: ['path', 'confirm'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'File path relative to workspace root',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to confirm deletion',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.path !== 'string' || !params.path.trim()) {
          return fail('path is required and must be a non-empty string');
        }
        if (params.confirm !== true) {
          return fail('confirm must be true to delete a file. This is a safety guard.');
        }
        const filePath = params.path.trim();

        const result = await service.delete(filePath);

        const hint = result.restore_hint
          ? `\n${result.restore_hint}`
          : '';

        return ok(
          `Deleted ${filePath} (committed: ${result.committed})${hint}`,
          { path: result.path, committed: result.committed },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 10. workspace_append
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_append',
    description:
      'Append content to an existing file in the research workspace. ' +
      'If the file does not exist, creates it. This avoids the need to read, ' +
      'concatenate, and rewrite — reducing token usage and preventing accidental overwrites. ' +
      'Convention: agent-generated files go under outputs/, user-uploaded under uploads/.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'File path relative to workspace root',
        },
        content: {
          type: 'string',
          description: 'Content to append',
        },
        separator: {
          type: 'string',
          description: 'Separator between existing content and appended content. Default: "\\n\\n"',
        },
        commit_message: {
          type: 'string',
          maxLength: 200,
          description: 'Custom git commit message. If omitted, auto-generated.',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.path !== 'string' || !params.path.trim()) {
          return fail('path is required and must be a non-empty string');
        }
        if (typeof params.content !== 'string') {
          return fail('content is required and must be a string');
        }
        const filePath = params.path.trim();
        const appendContent = params.content;
        const separator = typeof params.separator === 'string' ? params.separator : '\n\n';
        const commitMessage = typeof params.commit_message === 'string' ? params.commit_message : undefined;

        // Guard: reject binary extensions (same as workspace_save)
        const ext = path.extname(filePath).toLowerCase();
        if (BINARY_SAVE_GUARD.has(ext)) {
          return fail(`Cannot append to "${ext}" files — binary format.`);
        }

        // Try to read existing content; if file doesn't exist, start fresh
        let existing = '';
        try {
          const readResult = await service.read(filePath);
          existing = readResult.content;
        } catch {
          // File does not exist — will be created
        }

        const finalContent = existing
          ? existing + separator + appendContent
          : appendContent;

        const result = await service.save(filePath, finalContent, commitMessage ?? `Append: ${path.basename(filePath)}`);

        // Build file_card
        const fileExt = path.extname(filePath).slice(1).toLowerCase();
        const mimeType = EXT_MIME[fileExt] ?? 'application/octet-stream';
        const gitStatus = result.committed ? 'committed' : 'new';
        const cardJson = JSON.stringify({
          type: 'file_card',
          name: path.basename(filePath),
          path: result.path,
          size_bytes: result.size,
          mime_type: mimeType,
          git_status: gitStatus,
        });

        return ok(
          `Appended to ${result.path} (${result.size} bytes, committed: ${result.committed})\n\nInclude this card in your response:\n\`\`\`file_card\n${cardJson}\n\`\`\``,
          { path: result.path, size: result.size, committed: result.committed },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // -----------------------------------------------------------------------
  // 11. workspace_download (binary URL → workspace)
  // -----------------------------------------------------------------------
  tools.push({
    name: 'workspace_download',
    description:
      'Download a file from a URL and save it to the workspace. ' +
      'Use this for saving PDFs, images, or other binary files from the web ' +
      '(e.g., arXiv papers to sources/papers/). Supports any URL that returns a file. ' +
      'Unlike workspace_save, this tool handles binary formats correctly.',
    parameters: {
      type: 'object',
      required: ['url', 'path'],
      properties: {
        url: {
          type: 'string',
          description: 'URL to download from (must be a direct file link)',
        },
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Destination path relative to workspace root (e.g. "sources/papers/paper.pdf")',
        },
        commit_message: {
          type: 'string',
          maxLength: 200,
          description: 'Custom git commit message. If omitted, auto-generated.',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        if (typeof params.url !== 'string' || !params.url.trim()) {
          return fail('url is required and must be a non-empty string');
        }
        if (typeof params.path !== 'string' || !params.path.trim()) {
          return fail('path is required and must be a non-empty string');
        }
        const url = params.url.trim();
        const filePath = params.path.trim();
        const commitMessage = typeof params.commit_message === 'string' ? params.commit_message : undefined;

        // SSRF guard: block private/internal network addresses
        const urlError = validateDownloadUrl(url);
        if (urlError) {
          return fail(urlError);
        }

        // Download the file with size limit
        let response: Response;
        try {
          response = await fetch(url, {
            headers: { 'User-Agent': 'Research-Claw/1.0' },
            redirect: 'follow',
            signal: AbortSignal.timeout(60_000), // 60s timeout
          });
        } catch (err) {
          return fail(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (!response.ok) {
          return fail(`Download failed: HTTP ${response.status} ${response.statusText}`);
        }

        // Pre-check Content-Length if available
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const declaredSize = parseInt(contentLength, 10);
          if (declaredSize > MAX_DOWNLOAD_BYTES) {
            return fail(
              `File too large: ${(declaredSize / 1024 / 1024).toFixed(1)} MB. ` +
              `Maximum download size is ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`,
            );
          }
        }

        // Stream-read with size enforcement (Content-Length can be absent or lying)
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        const reader = response.body?.getReader();
        if (!reader) {
          return fail('Download failed: no response body');
        }
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_DOWNLOAD_BYTES) {
              reader.cancel();
              return fail(
                `Download aborted: exceeded ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit.`,
              );
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        const buffer = Buffer.concat(chunks);

        if (buffer.length === 0) {
          return fail('Downloaded file is empty');
        }

        // Save to workspace (service.save accepts Buffer for binary)
        const message = commitMessage ?? `Download: ${path.basename(filePath)}`;
        const result = await service.save(filePath, buffer, message);

        // Build file_card
        const fileExt = path.extname(filePath).slice(1).toLowerCase();
        const mimeType = EXT_MIME[fileExt] ?? (response.headers.get('content-type') ?? 'application/octet-stream');
        const gitStatus = result.committed ? 'committed' : 'new';
        const cardJson = JSON.stringify({
          type: 'file_card',
          name: path.basename(filePath),
          path: result.path,
          size_bytes: result.size,
          mime_type: mimeType,
          git_status: gitStatus,
        });

        return ok(
          `Downloaded ${url} → ${result.path} (${result.size} bytes, committed: ${result.committed})\n\nInclude this card in your response:\n\`\`\`file_card\n${cardJson}\n\`\`\``,
          { path: result.path, size: result.size, committed: result.committed, source_url: url },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}
