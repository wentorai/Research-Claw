/**
 * locales.test.ts — 语言包完整性回归
 *
 * 三条不变量,每条都对应一个已经真实发生过的故障：
 *
 * 1. **同级重复键**：`en.json` / `zh-CN.json` 里出现过两个顶层 `"panel"` 块。
 *    `JSON.parse` 对重复键是「后者胜」且完全静默,于是先出现的那个 `panel` 块
 *    (dockSide / placement* / resizeHandle 共 7 个键)在运行时被整块抹掉,
 *    RightPanel 的停靠菜单只能靠 `t()` 的第二参数兜底。文件看着有,运行时没有。
 *
 * 2. **双语键集必须一致**：任一侧缺键 = 该语言下静默回退到另一语言或裸键。
 *
 * 3. **代码引用的键必须存在**：`t('a.b')` 里的字面量键如果两个语言包都没有,
 *    有 fallback 的会掩盖问题(改文案得改代码),没 fallback 的直接把 `setup.
 *    ollamaDetecting` 这种裸键渲染给用户。
 *
 * 这里不用 `JSON.parse` 找重复键(它天然看不见),而是走一遍最小 JSON 词法分析,
 * 记录每个对象里出现过的键。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, '..');
const LOCALES = ['en.json', 'zh-CN.json'] as const;

/**
 * Minimal JSON scanner that reports every duplicated key, per containing object.
 * `JSON.parse` cannot do this: duplicates are legal JSON and the last one wins.
 */
function findDuplicateKeys(source: string): string[] {
  const dups: string[] = [];
  let i = 0;

  const skipWs = () => {
    while (i < source.length && /\s/.test(source[i])) i += 1;
  };

  const readString = (): string => {
    // source[i] === '"'
    i += 1;
    let out = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        out += source[i] + source[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return out;
      }
      out += ch;
      i += 1;
    }
    throw new Error('unterminated string');
  };

  const readValue = (pathPrefix: string): void => {
    skipWs();
    const ch = source[i];
    if (ch === '{') {
      i += 1;
      const seen = new Set<string>();
      for (;;) {
        skipWs();
        if (source[i] === '}') {
          i += 1;
          return;
        }
        if (source[i] === ',') {
          i += 1;
          continue;
        }
        const key = readString();
        const full = pathPrefix ? `${pathPrefix}.${key}` : key;
        if (seen.has(key)) dups.push(full);
        seen.add(key);
        skipWs();
        if (source[i] !== ':') throw new Error(`expected ':' at ${i}`);
        i += 1;
        readValue(full);
      }
    } else if (ch === '[') {
      i += 1;
      for (;;) {
        skipWs();
        if (source[i] === ']') {
          i += 1;
          return;
        }
        if (source[i] === ',') {
          i += 1;
          continue;
        }
        readValue(pathPrefix);
      }
    } else if (ch === '"') {
      readString();
    } else {
      // number / true / false / null
      while (i < source.length && !/[,}\]\s]/.test(source[i])) i += 1;
    }
  };

  readValue('');
  return dups;
}

function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
      else out[key] = String(v);
    }
  }
  return out;
}

function loadFlat(file: string): Record<string, string> {
  return flatten(JSON.parse(fs.readFileSync(path.join(here, file), 'utf8')));
}

/** All non-test source files that may call `t(...)`. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__fixtures__') continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

/** Literal keys passed as the first argument to `t(...)`, with their source file. */
function referencedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /\bt\(\s*['"`]([A-Za-z0-9_.]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // Namespaced keys only; bare identifiers are almost always some other `t(`.
      if (!m[1].includes('.')) continue;
      if (!found.has(m[1])) found.set(m[1], path.relative(SRC_DIR, file));
    }
  }
  return found;
}

describe('i18n locale files', () => {
  it.each(LOCALES)('%s 内不得有同级重复键（JSON.parse 会静默丢掉先出现的那个块）', (file) => {
    const source = fs.readFileSync(path.join(here, file), 'utf8');
    expect(findDuplicateKeys(source)).toEqual([]);
  });

  it('en 与 zh-CN 的键集必须完全一致', () => {
    const en = Object.keys(loadFlat('en.json')).sort();
    const zh = Object.keys(loadFlat('zh-CN.json')).sort();
    expect(en.filter((k) => !zh.includes(k))).toEqual([]);
    expect(zh.filter((k) => !en.includes(k))).toEqual([]);
  });

  it.each(LOCALES)('%s 的系统文案不得向用户暴露 OC/OpenClaw 内部品牌', (file) => {
    const leaked = Object.entries(loadFlat(file))
      .filter(([, value]) => /OpenClaw|(^|[^A-Za-z])OC([^A-Za-z]|$)/i.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(leaked).toEqual([]);
  });

  it('t() 的硬编码 fallback 文案不得重新引入 OC/OpenClaw 内部品牌', () => {
    const leaked: string[] = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /\bt\(\s*['"`]([A-Za-z0-9_.]+)['"`]\s*,\s*['"`]([^'"`]*)['"`]/gs;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src))) {
        if (/OpenClaw|(^|[^A-Za-z])OC([^A-Za-z]|$)/i.test(match[2])) {
          leaked.push(`${path.relative(SRC_DIR, file)}:${match[1]}: ${match[2]}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('代码里引用的每个字面量键都必须在两个语言包中存在', () => {
    const en = loadFlat('en.json');
    const zh = loadFlat('zh-CN.json');
    const missing: string[] = [];
    for (const [key, file] of referencedKeys()) {
      const inEn = key in en;
      const inZh = key in zh;
      if (!inEn || !inZh) {
        missing.push(`${key} (missing in ${[!inEn && 'en', !inZh && 'zh-CN'].filter(Boolean).join(' + ')}) — ${file}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it('重复键扫描器本身能抓到重复（否则上面的用例是空转）', () => {
    const withDup = '{"panel":{"a":"1"},"other":{},"panel":{"b":"2"}}';
    expect(findDuplicateKeys(withDup)).toEqual(['panel']);
    const nestedDup = '{"a":{"b":"1","b":"2"}}';
    expect(findDuplicateKeys(nestedDup)).toEqual(['a.b']);
    expect(findDuplicateKeys('{"a":{"b":"1"},"c":["x","y"]}')).toEqual([]);
  });
});
