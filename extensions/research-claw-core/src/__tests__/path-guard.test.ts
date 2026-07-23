/**
 * path-guard — table-driven containment tests.
 *
 * This module is the single source of truth for workspace path containment
 * (service.resolvePath, rc.ws.openExternal/openFolder, /rc/upload destination,
 * /rc/download). The symlink cases are the load-bearing ones: /rc/download was
 * previously a prefix-only check, so `ln -s /etc evil` could read outside.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PathEscapeError, resolveWithinRoot, validateRelPath } from '../workspace/path-guard.js';

describe('validateRelPath', () => {
  it.each([
    [''],
    ['/etc/passwd'],
    ['\\windows'],
    ['..'],
    ['../x'],
    ['a/../../b'],
    ['a\\..\\b'],
    ['a/\0/b'],
  ])('rejects %j', (p) => {
    expect(() => validateRelPath(p)).toThrow(PathEscapeError);
  });

  it.each([['.'], ['a.txt'], ['sources/chat/x.pdf'], ['a/b/c'], ['.hidden']])('accepts %j', (p) => {
    expect(() => validateRelPath(p)).not.toThrow();
  });
});

describe('resolveWithinRoot', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-path-guard-'));
    fs.mkdirSync(path.join(root, 'inside'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves in-root paths (including not-yet-existing ones)', () => {
    expect(resolveWithinRoot(root, 'inside/a.txt')).toBe(path.join(root, 'inside/a.txt'));
    expect(resolveWithinRoot(root, 'new/deep/file.txt')).toBe(path.join(root, 'new/deep/file.txt'));
    expect(resolveWithinRoot(root, '.')).toBe(root);
  });

  it('allows symlinks that stay INSIDE the root', () => {
    fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'link-in'));
    expect(() => resolveWithinRoot(root, 'link-in/a.txt')).not.toThrow();
  });

  it('rejects symlinks that point OUTSIDE the root (at any depth)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'evil'));
      expect(() => resolveWithinRoot(root, 'evil/secret.txt')).toThrow(PathEscapeError);
      // Nested: root/inside/evil2 → outside
      fs.symlinkSync(outside, path.join(root, 'inside', 'evil2'));
      expect(() => resolveWithinRoot(root, 'inside/evil2/deep/x')).toThrow(PathEscapeError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects traversal that escapes even when re-entering is impossible', () => {
    expect(() => resolveWithinRoot(root, '../sibling')).toThrow(PathEscapeError);
  });
});
