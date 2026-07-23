import { describe, it, expect, vi } from 'vitest';
import {
  applyDropPolicy,
  collectDroppedEntries,
  mapWithConcurrency,
  splitRelPath,
  type CollectedDrop,
} from './drop-entries';

// --- Minimal FileSystemEntry mocks (webkitGetAsEntry tree) ---

function fileEntry(name: string): any {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (onSuccess: (f: File) => void) => onSuccess(new File([name], name)),
  };
}

function dirEntry(name: string, children: any[]): any {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      // readEntries drains in batches and signals completion with [].
      let served = false;
      return {
        readEntries: (onSuccess: (entries: any[]) => void) => {
          onSuccess(served ? [] : children);
          served = true;
        },
      };
    },
  };
}

function makeDataTransfer(entries: any[]): DataTransfer {
  const items = entries.map((entry) => ({
    webkitGetAsEntry: () => entry,
  }));
  return {
    items: items as unknown as DataTransferItemList,
    files: [] as unknown as FileList,
  } as unknown as DataTransfer;
}

describe('collectDroppedEntries', () => {
  it('flattens a dropped folder preserving relative paths + rootDir', async () => {
    const tree = dirEntry('myfolder', [
      fileEntry('a.txt'),
      dirEntry('sub', [fileEntry('b.txt')]),
    ]);

    const result = await collectDroppedEntries(makeDataTransfer([tree]));

    expect(result.hadDirectory).toBe(true);
    expect(result.files.map((f) => f.relPath).sort()).toEqual([
      'myfolder/a.txt',
      'myfolder/sub/b.txt',
    ]);
    expect(result.files.every((f) => f.rootDir === 'myfolder')).toBe(true);
  });

  it('treats loose top-level files as rootDir=null', async () => {
    const result = await collectDroppedEntries(makeDataTransfer([fileEntry('loose.pdf')]));

    expect(result.hadDirectory).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe('loose.pdf');
    expect(result.files[0].rootDir).toBeNull();
  });

  it('falls back to dataTransfer.files when entries API is unavailable', async () => {
    const dt = {
      items: [] as unknown as DataTransferItemList,
      files: [new File(['x'], 'x.csv')] as unknown as FileList,
    } as unknown as DataTransfer;

    const result = await collectDroppedEntries(dt);

    expect(result.hadDirectory).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe('x.csv');
    expect(result.files[0].rootDir).toBeNull();
  });
});

describe('splitRelPath', () => {
  const id = (s: string) => s;

  it('strips the root folder and returns subdir + filename', () => {
    expect(splitRelPath('myfolder/sub/a.txt', 'myfolder', id)).toEqual({
      subDir: 'sub',
      fileName: 'a.txt',
    });
  });

  it('returns empty subdir for a file directly under the root', () => {
    expect(splitRelPath('myfolder/a.txt', 'myfolder', id)).toEqual({
      subDir: '',
      fileName: 'a.txt',
    });
  });

  it('handles loose files (no rootDir)', () => {
    expect(splitRelPath('a.txt', null, id)).toEqual({ subDir: '', fileName: 'a.txt' });
  });

  it('sanitizes each directory segment', () => {
    const sanitize = (s: string) => s.replace(/[^a-z]/gi, '_');
    expect(splitRelPath('root/we ird/a.txt', 'root', sanitize)).toEqual({
      subDir: 'we_ird',
      fileName: 'a.txt',
    });
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe('entriesUnsupported fallback flag', () => {
  it('marks the drop when webkitGetAsEntry is unavailable (folder contents lost)', async () => {
    const dt = {
      items: [{}] as unknown as DataTransferItemList, // items without webkitGetAsEntry
      files: [new File(['x'], 'loose.txt')] as unknown as FileList,
    } as unknown as DataTransfer;
    const collected = await collectDroppedEntries(dt);
    expect(collected.entriesUnsupported).toBe(true);
    expect(collected.files.map((f) => f.relPath)).toEqual(['loose.txt']);
  });

  it('is not set when the entries API is available', async () => {
    const collected = await collectDroppedEntries(makeDataTransfer([fileEntry('a.txt')]));
    expect(collected.entriesUnsupported).toBeUndefined();
  });
});

describe('applyDropPolicy', () => {
  const drop = (sizes: number[]): CollectedDrop => ({
    files: sizes.map((size, i) => ({
      file: new File([new Uint8Array(size)], `f${i}.bin`),
      relPath: `f${i}.bin`,
      rootDir: null,
    })),
    hadDirectory: false,
  });
  const noopCallbacks = () => ({
    warnOversize: vi.fn(),
    confirmBulk: vi.fn(async () => true),
  });

  it('returns [] for an empty drop without invoking callbacks', async () => {
    const cb = noopCallbacks();
    expect(await applyDropPolicy({ files: [], hadDirectory: false }, { maxFileSize: 10, ...cb })).toEqual([]);
    expect(cb.warnOversize).not.toHaveBeenCalled();
    expect(cb.confirmBulk).not.toHaveBeenCalled();
  });

  it('filters oversized files with a single combined warning', async () => {
    const cb = noopCallbacks();
    const kept = await applyDropPolicy(drop([5, 50, 60]), { maxFileSize: 10, ...cb });
    expect(kept?.map((d) => d.file.size)).toEqual([5]);
    expect(cb.warnOversize).toHaveBeenCalledTimes(1);
    expect(cb.warnOversize).toHaveBeenCalledWith(2, 0); // 10 bytes rounds to 0MB
    expect(cb.confirmBulk).not.toHaveBeenCalled();
  });

  it('skips the bulk confirm below the thresholds', async () => {
    const cb = noopCallbacks();
    const kept = await applyDropPolicy(drop([1, 1, 1]), { maxFileSize: 10, ...cb });
    expect(kept).toHaveLength(3);
    expect(cb.confirmBulk).not.toHaveBeenCalled();
  });

  it('asks for confirmation above MAX_DROP_FILES and honors acceptance', async () => {
    const cb = noopCallbacks();
    const many = drop(Array.from({ length: 201 }, () => 1));
    const kept = await applyDropPolicy(many, { maxFileSize: 10, ...cb });
    expect(cb.confirmBulk).toHaveBeenCalledTimes(1);
    expect(cb.confirmBulk).toHaveBeenCalledWith(201, 0);
    expect(kept).toHaveLength(201);
  });

  it('returns null when the bulk confirm is declined', async () => {
    const cb = { warnOversize: vi.fn(), confirmBulk: vi.fn(async () => false) };
    const many = drop(Array.from({ length: 201 }, () => 1));
    expect(await applyDropPolicy(many, { maxFileSize: 10, ...cb })).toBeNull();
  });
});
