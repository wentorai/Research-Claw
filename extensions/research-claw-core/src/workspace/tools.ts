/**
 * workspace/tools — 7 Agent Tool Registrations
 *
 * Registers workspace_save, workspace_read, workspace_list, workspace_diff,
 * workspace_history, workspace_restore, and workspace_move as OpenClaw agent tools.
 *
 * All tools delegate to WorkspaceService (no direct DB or Git access).
 * Uses plain JSON Schema objects for parameter definitions.
 */

// Note: Tool parameters use raw JSON Schema objects for simplicity.
// The spec suggests TypeBox (@sinclair/typebox) but raw schemas are
// functionally equivalent and avoid an additional abstraction layer.

import * as path from 'node:path';
import type { WorkspaceService, TreeNode } from './service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string, details: unknown): unknown {
  return { content: [{ type: 'text', text }], details };
}

// MIME extension → card mime_type mapping
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown', txt: 'text/plain', tex: 'text/x-latex', bib: 'application/x-bibtex',
  csv: 'text/csv', json: 'application/json', yaml: 'text/x-yaml', yml: 'text/x-yaml',
  py: 'text/x-python', r: 'text/x-r', jl: 'text/x-julia', m: 'text/x-matlab',
  js: 'text/javascript', ts: 'text/typescript',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  svg: 'image/svg+xml', gif: 'image/gif',
};

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

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
 * Create the 6 workspace agent tools.
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
      'Save or create a file in the research workspace. Automatically commits the change to Git. ' +
      'Use paths relative to the workspace root (e.g. "outputs/drafts/review.md").',
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

        const result = await service.save(filePath, content, commitMessage);

        // Build file_card JSON block so the LLM includes it in its response
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mimeType = EXT_MIME[ext] ?? 'application/octet-stream';
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
          `Saved ${result.path} (${result.size} bytes, committed: ${result.committed})\n\nInclude this card in your response:\n\`\`\`file_card\n${cardJson}\n\`\`\``,
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

  return tools;
}
