/**
 * workspace/export-convert — Binary document format conversion
 *
 * Converts text source files (Markdown, CSV) to binary document formats
 * (docx, pdf, xlsx) using pandoc and Python tools available in the
 * Research-Claw Docker image.
 *
 * Issue #38: LLM agents cannot generate binary files directly.
 * This module provides the conversion pipeline.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Supported conversions
// ---------------------------------------------------------------------------

export interface ConversionSpec {
  /** Source text extensions that can be converted from. */
  sourceExts: string[];
  /** Shell command builder. Returns [command, ...args]. */
  buildCommand: (srcPath: string, destPath: string) => string[];
}

const CONVERSIONS: Record<string, ConversionSpec> = {
  docx: {
    sourceExts: ['.md', '.txt', '.tex', '.html', '.rst'],
    buildCommand: (src, dest) => [
      'pandoc', src, '-o', dest,
      '--from', inferPandocFormat(src),
      // Standalone ensures proper document structure
      '--standalone',
    ],
  },
  pdf: {
    sourceExts: ['.md', '.txt', '.tex', '.html', '.rst'],
    buildCommand: (src, dest) => [
      'pandoc', src, '-o', dest,
      '--from', inferPandocFormat(src),
      '--pdf-engine=xelatex',
      // CJK font support for Chinese academic content
      '-V', 'CJKmainfont=Noto Sans CJK SC',
      '-V', 'geometry:margin=2.5cm',
      '--standalone',
    ],
  },
  xlsx: {
    sourceExts: ['.csv', '.tsv', '.json'],
    buildCommand: (src, dest) => {
      const srcStr = JSON.stringify(src);
      const destStr = JSON.stringify(dest);
      const ext = path.extname(src).toLowerCase();
      // Choose the correct pandas reader based on source format
      let readExpr: string;
      if (ext === '.tsv') {
        readExpr = `pd.read_csv(${srcStr}, sep='\\t', encoding='utf-8')`;
      } else if (ext === '.json') {
        readExpr = `pd.read_json(${srcStr}, encoding='utf-8')`;
      } else {
        readExpr = `pd.read_csv(${srcStr}, encoding='utf-8')`;
      }
      return [
        'python3', '-c',
        `import pandas as pd; df = ${readExpr}; df.to_excel(${destStr}, index=False, engine='openpyxl')`,
      ];
    },
  },
};

/** Infer pandoc input format from file extension. */
function inferPandocFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.md': return 'markdown';
    case '.txt': return 'markdown';
    case '.tex': return 'latex';
    case '.html': case '.htm': return 'html';
    case '.rst': return 'rst';
    default: return 'markdown';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExportResult {
  outputPath: string;
  size: number;
  format: string;
}

export const SUPPORTED_FORMATS = Object.keys(CONVERSIONS);

/**
 * Check if a target format is supported.
 */
export function isSupportedFormat(format: string): boolean {
  return format in CONVERSIONS;
}

/**
 * Check if a source file can be converted to the target format.
 */
export function isValidSource(srcPath: string, format: string): boolean {
  const spec = CONVERSIONS[format];
  if (!spec) return false;
  const ext = path.extname(srcPath).toLowerCase();
  return spec.sourceExts.includes(ext);
}

/**
 * Get the list of valid source extensions for a target format.
 */
export function validSourceExts(format: string): string[] {
  return CONVERSIONS[format]?.sourceExts ?? [];
}

/**
 * Convert a text source file to a binary document format.
 *
 * @param srcAbsPath  - Absolute path to the source text file (must exist)
 * @param destAbsPath - Absolute path for the output binary file
 * @param format      - Target format key (docx, pdf, xlsx)
 * @returns ExportResult with output path and size
 */
export async function convertFile(
  srcAbsPath: string,
  destAbsPath: string,
  format: string,
): Promise<ExportResult> {
  const spec = CONVERSIONS[format];
  if (!spec) {
    throw new Error(`Unsupported export format: "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}`);
  }

  const srcExt = path.extname(srcAbsPath).toLowerCase();
  if (!spec.sourceExts.includes(srcExt)) {
    throw new Error(
      `Cannot convert "${srcExt}" to "${format}". ` +
      `Valid source formats: ${spec.sourceExts.join(', ')}`,
    );
  }

  // Ensure source exists
  try {
    await fsp.access(srcAbsPath);
  } catch {
    throw new Error(`Source file not found: ${srcAbsPath}`);
  }

  // Ensure output directory exists
  await fsp.mkdir(path.dirname(destAbsPath), { recursive: true });

  // Run conversion
  const [cmd, ...args] = spec.buildCommand(srcAbsPath, destAbsPath);
  try {
    await execFileAsync(cmd, args, {
      timeout: 60_000, // 60s timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB stderr/stdout buffer
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Conversion failed (${cmd}): ${msg}`);
  }

  // Verify output was created
  let stat;
  try {
    stat = await fsp.stat(destAbsPath);
  } catch {
    throw new Error(`Conversion command succeeded but output file was not created: ${destAbsPath}`);
  }

  return {
    outputPath: destAbsPath,
    size: stat.size,
    format,
  };
}
