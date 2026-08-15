'use strict';

const crypto = require('node:crypto');
const { isIP } = require('node:net');
const path = require('node:path').posix;
const UNICODE15_ASSIGNED_TABLE = require('./unicode-15.0-assigned-ranges.json');

const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;
const MAX_SKILLS = 10;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 256 * 1024;
const MIN_API_KEY_BYTES = 16;
const MAX_API_KEY_BYTES = 16 * 1024;
const MAX_PORTABLE_COMPONENT_BYTES = 255;
const MAX_SKILL_PATH_DEPTH = 32;
const MAX_SKILL_PATH_BYTES = 512;
const MARKDOWN_OPERATION_FACTOR = 16;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER = /^custom-rc-profile-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASCII_DNS_HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*\.?$/;
const NUMERIC_HOST = /^(?:[0-9]+|0x[0-9a-f]+)(?:\.(?:[0-9]+|0x[0-9a-f]+))*\.?$/i;
const WIRE_BOUNDARY_WHITESPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const WIRE_BOUNDARY_WHITESPACE_START = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/u;
const WIRE_BOUNDARY_WHITESPACE_END = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/u;
const WINDOWS_FORBIDDEN_COMPONENT = /[<>:"\\|?*]/u;
const DANGEROUS_FORMAT_CHARACTER = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const LINK_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'doi']);
const AUTOLINK_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_{}|~\x60-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const RAW_HTML_ANGLE = /^(?:!?\/?[A-Za-z]|\?)/u;
const UNICODE15_ASSIGNED_RANGES = UNICODE15_ASSIGNED_TABLE.ranges;
if (UNICODE15_ASSIGNED_TABLE.unicodeVersion !== '15.0.0'
    || !Array.isArray(UNICODE15_ASSIGNED_RANGES)
    || UNICODE15_ASSIGNED_RANGES.length !== 707) {
  throw new Error('invalid Unicode 15 assigned-scalar table');
}
const PROTOCOLS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-chatgpt-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'github-copilot',
  'bedrock-converse-stream',
  'ollama',
  'azure-openai-responses',
]);

class BootstrapCapsuleValidationError extends Error {
  constructor(code) {
    super('Bootstrap Capsule validation failed');
    this.name = 'BootstrapCapsuleValidationError';
    this.code = code;
  }
}

function fail(code) {
  throw new BootstrapCapsuleValidationError(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value, keys) {
  if (!isObject(value)) fail('INVALID_STRUCTURE');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('UNKNOWN_FIELD');
  }
}

function requireString(value, code, { min = 1, max = Infinity } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(code);
  return value;
}

function requireInteger(value, code, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function rejectLoneSurrogates(value) {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('INVALID_JSON');
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('INVALID_JSON');
    }
  } else if (Array.isArray(value)) {
    for (const item of value) rejectLoneSurrogates(item);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      rejectLoneSurrogates(key);
      rejectLoneSurrogates(item);
    }
  }
}

function hasWireBoundaryWhitespace(value) {
  const characters = Array.from(value);
  return characters.length > 0
    && (WIRE_BOUNDARY_WHITESPACE.test(characters[0])
      || WIRE_BOUNDARY_WHITESPACE.test(characters.at(-1)));
}

function trimWireBoundaryWhitespace(value) {
  return value
    .replace(WIRE_BOUNDARY_WHITESPACE_START, '')
    .replace(WIRE_BOUNDARY_WHITESPACE_END, '');
}

function unicode15ScalarIsAssigned(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return false;
  let low = 0;
  let high = UNICODE15_ASSIGNED_RANGES.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end] = UNICODE15_ASSIGNED_RANGES[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function unicode15StringIsAssigned(value) {
  for (const character of value) {
    if (!unicode15ScalarIsAssigned(character.codePointAt(0))) return false;
  }
  return true;
}

function unicode15CaseKey(value) {
  return value.normalize('NFC').toLowerCase().normalize('NFC');
}

function portablePathComponentIsValid(part) {
  const windowsStem = part.split('.', 1)[0].replace(/[ .]+$/u, '');
  return Buffer.byteLength(part, 'utf8') <= MAX_PORTABLE_COMPONENT_BYTES
    && !hasWireBoundaryWhitespace(part)
    && !part.endsWith('.')
    && !/[\x00-\x1f\x7f]/u.test(part)
    && !WINDOWS_FORBIDDEN_COMPONENT.test(part)
    && !DANGEROUS_FORMAT_CHARACTER.test(part)
    && !WINDOWS_RESERVED_BASENAME.test(windowsStem);
}

function skillPathIsValid(value) {
  if (typeof value !== 'string' || !value || !unicode15StringIsAssigned(value)
      || value !== value.normalize('NFC')
      || Buffer.byteLength(value, 'utf8') > MAX_SKILL_PATH_BYTES
      || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const parts = value.split('/');
  if (parts.length > MAX_SKILL_PATH_DEPTH || parts.some((part) => !part || part === '.' || part === '..'
      || part.startsWith('.') || !portablePathComponentIsValid(part))) return false;
  if (value === 'SKILL.md') return true;
  return parts.length >= 2 && parts[0] === 'references' && value.endsWith('.md');
}

function portablePathCollisionKey(value) {
  return unicode15CaseKey(value);
}

function frontmatter(content) {
  if (!content.startsWith('---\n')) fail('INVALID_SKILL_FRONTMATTER');
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) fail('INVALID_SKILL_FRONTMATTER');
  const values = {};
  for (const line of content.slice(4, end).split('\n')) {
    if (!line || /^[ \t#]/.test(line) || /[\x00-\x09\x0b-\x1f\x7f\u0085\u2028\u2029]/.test(line)) {
      fail('INVALID_SKILL_FRONTMATTER');
    }
    const separator = line.indexOf(':');
    if (separator < 1) fail('INVALID_SKILL_FRONTMATTER');
    const key = line.slice(0, separator);
    const raw = trimWireBoundaryWhitespace(line.slice(separator + 1));
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(key) || !raw || Object.hasOwn(values, key)) {
      fail('INVALID_SKILL_FRONTMATTER');
    }
    let parsed = raw;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0];
      if (raw.length < 2 || raw.at(-1) !== quote) fail('INVALID_SKILL_FRONTMATTER');
      parsed = raw.slice(1, -1);
      if (!parsed || /^["']|["']$/.test(parsed)) fail('INVALID_SKILL_FRONTMATTER');
    } else if (raw.endsWith('"') || raw.endsWith("'")) {
      fail('INVALID_SKILL_FRONTMATTER');
    }
    values[key] = parsed;
  }
  if (!values.name || !values.description || Object.hasOwn(values, 'always')) {
    fail('INVALID_SKILL_FRONTMATTER');
  }
  return values;
}

function validCanonicalHttpsAuthority(raw) {
  const remainder = raw.slice('https://'.length);
  const authorityEnd = remainder.indexOf('/');
  const authority = remainder.slice(0, authorityEnd < 0 ? undefined : authorityEnd);
  if (!authority || authority.includes('@')) return false;
  let host;
  let port;
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']');
    if (closing < 0) return false;
    const suffix = authority.slice(closing + 1);
    if (suffix && !suffix.startsWith(':')) return false;
    host = authority.slice(1, closing);
    port = suffix ? suffix.slice(1) : undefined;
    if (host.includes('%') || isIP(host) !== 6) return false;
  } else {
    const colon = authority.lastIndexOf(':');
    host = colon < 0 ? authority : authority.slice(0, colon);
    port = colon < 0 ? undefined : authority.slice(colon + 1);
    if (!host || host.includes('%')) return false;
    if (NUMERIC_HOST.test(host)) {
      if (isIP(host) !== 4) return false;
    } else {
      const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
      if (normalized.length > 253 || !ASCII_DNS_HOST.test(host)) return false;
    }
  }
  return port === undefined || (/^[0-9]+$/.test(port) && Number(port) <= 65_535);
}

function canonicalHttpsPathIsValid(raw) {
  const remainder = raw.slice('https://'.length);
  const pathStart = remainder.indexOf('/');
  if (pathStart < 0) return true;
  const rawPath = remainder.slice(pathStart);
  if (/[<>"`^{}]/u.test(rawPath)) return false;
  return rawPath.split('/').every((segment) => {
    const decodedDots = segment.replace(/%2e/giu, '.');
    return decodedDots !== '.' && decodedDots !== '..';
  });
}

function isLinkWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\n'
    || character === '\v' || character === '\f' || character === '\r';
}

function isUnsafeLinkCharacter(character) {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function createMarkdownBudget(content) {
  let remaining = MARKDOWN_OPERATION_FACTOR * Buffer.byteLength(content, 'utf8') + 1024;
  return {
    step(count = 1) {
      remaining -= count;
      if (remaining < 0) fail('BROKEN_SKILL_LINK');
    },
  };
}

function isMarkdownEscapable(character) {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}

function isMarkdownEscapeAt(value, index) {
  return value[index] === '\\' && isMarkdownEscapable(value[index + 1]);
}

function isMarkdownEscaped(value, index, budget) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    budget.step();
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function skipLinkWhitespace(value, start, budget) {
  let index = start;
  while (index < value.length && isLinkWhitespace(value[index])) {
    budget.step();
    index += 1;
  }
  return index;
}

function blankMarkdownRange(characters, start, end, budget) {
  for (let index = start; index < end; index += 1) {
    budget.step();
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
  }
}

function maskIgnoredMarkdownContexts(content, budget) {
  const characters = content.split('');
  let fence;
  let index = 0;
  while (index < characters.length) {
    const atLineStart = index === 0 || characters[index - 1] === '\n';
    if (atLineStart) {
      let lineEnd = index;
      while (lineEnd < characters.length && characters[lineEnd] !== '\n') {
        budget.step();
        lineEnd += 1;
      }
      const line = characters.slice(index, lineEnd).join('');
      const fenceRun = line.match(/^ {0,3}(`+|~+)/u)?.[1];
      if (fence) {
        if (fenceRun && fenceRun[0] === fence.character && fenceRun.length >= fence.length
            && /^[ \t]*$/u.test(line.slice(line.indexOf(fenceRun) + fenceRun.length))) {
          fence = undefined;
        }
        blankMarkdownRange(characters, index, lineEnd, budget);
        index = lineEnd;
        if (index < characters.length) {
          budget.step();
          index += 1;
        }
        continue;
      }
      if (fenceRun && fenceRun.length >= 3) {
        fence = { character: fenceRun[0], length: fenceRun.length };
        blankMarkdownRange(characters, index, lineEnd, budget);
        index = lineEnd;
        if (index < characters.length) {
          budget.step();
          index += 1;
        }
        continue;
      }
      if (/^(?: {4}|\t)/u.test(line)) {
        blankMarkdownRange(characters, index, lineEnd, budget);
        index = lineEnd;
        if (index < characters.length) {
          budget.step();
          index += 1;
        }
        continue;
      }
    }

    budget.step();
    if (characters[index] === '<' && characters[index + 1] === '!'
        && characters[index + 2] === '-' && characters[index + 3] === '-'
        && !isMarkdownEscaped(characters, index, budget)) {
      let closing = index + 4;
      while (closing + 2 < characters.length
          && !(characters[closing] === '-' && characters[closing + 1] === '-'
            && characters[closing + 2] === '>')) {
        budget.step();
        closing += 1;
      }
      const commentEnd = closing + 2 < characters.length ? closing + 3 : characters.length;
      blankMarkdownRange(characters, index, commentEnd, budget);
      index = commentEnd;
      continue;
    }
    if (characters[index] !== '`' || isMarkdownEscaped(characters, index, budget)) {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (characters[index + runLength] === '`') {
      budget.step();
      runLength += 1;
    }
    let closing = index + runLength;
    while (closing < characters.length) {
      budget.step();
      if (characters[closing] !== '`' || isMarkdownEscaped(characters, closing, budget)) {
        closing += 1;
        continue;
      }
      let closingLength = 1;
      while (characters[closing + closingLength] === '`') {
        budget.step();
        closingLength += 1;
      }
      if (closingLength === runLength) break;
      closing += closingLength;
    }
    if (closing >= characters.length) {
      index += runLength;
      continue;
    }
    blankMarkdownRange(characters, index, closing + runLength, budget);
    index = closing + runLength;
  }
  return characters.join('');
}

function findMarkdownBracketClose(value, start, budget) {
  let depth = 0;
  let nested = false;
  for (let index = start + 1; index < value.length; index += 1) {
    budget.step();
    if (isMarkdownEscapeAt(value, index)) {
      budget.step();
      index += 1;
    } else if (value[index] === '[') {
      depth += 1;
      nested = true;
    } else if (value[index] === ']') {
      if (depth === 0) return { end: index, nested };
      depth -= 1;
    }
  }
  return undefined;
}

function unescapeMarkdown(value, budget) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    budget.step();
    if (isMarkdownEscapeAt(value, index)) {
      budget.step();
      index += 1;
      result += value[index];
    } else result += value[index];
  }
  return result;
}

function normalizeReferenceLabel(value, budget) {
  const unescaped = unescapeMarkdown(value, budget);
  const collapsed = unescaped.replace(/[\t\n\v\f\r ]+/gu, ' ').replace(/^ | $/gu, '');
  if (!unicode15StringIsAssigned(collapsed)) fail('BROKEN_SKILL_LINK');
  return unicode15CaseKey(collapsed);
}

function parseLinkTitle(value, start, budget) {
  const opener = value[start];
  const closer = opener === '(' ? ')' : opener;
  if (!['"', "'", '('].includes(opener)) return undefined;
  for (let index = start + 1; index < value.length; index += 1) {
    budget.step();
    if (isMarkdownEscapeAt(value, index)) {
      budget.step();
      index += 1;
    } else if (value[index] === closer) {
      return index + 1;
    } else if (value[index] === '\n' || value[index] === '\r') return undefined;
  }
  return undefined;
}

function parseInlineLinkDestination(value, openParenthesis, budget) {
  let index = skipLinkWhitespace(value, openParenthesis + 1, budget);
  let destination = '';
  let destinationClosed = false;
  if (value[index] === '<') {
    index += 1;
    while (index < value.length) {
      budget.step();
      const character = value[index];
      if (isMarkdownEscapeAt(value, index)) {
        budget.step();
        destination += value[index + 1];
        index += 2;
      } else if (character === '\\') {
        destination += character;
        index += 1;
      } else if (character === '>') {
        index += 1;
        destinationClosed = true;
        break;
      } else if (character === '<' || character === '\n' || character === '\r'
          || isUnsafeLinkCharacter(character)) return undefined;
      else {
        destination += character;
        index += 1;
      }
    }
    if (!destinationClosed) return undefined;
  } else {
    let depth = 0;
    while (index < value.length) {
      budget.step();
      const character = value[index];
      if (isMarkdownEscapeAt(value, index)) {
        budget.step();
        destination += value[index + 1];
        index += 2;
      } else if (character === '\\') {
        destination += character;
        index += 1;
      } else if (character === '(') {
        depth += 1;
        if (depth > MAX_SKILL_PATH_DEPTH) return undefined;
        destination += character;
        index += 1;
      } else if (character === ')') {
        if (depth === 0) return { destination, end: index + 1 };
        depth -= 1;
        destination += character;
        index += 1;
      } else if (depth === 0 && isLinkWhitespace(character)) break;
      else if (character === '<' || character === '>' || isUnsafeLinkCharacter(character)) return undefined;
      else {
        destination += character;
        index += 1;
      }
    }
  }

  const suffixStart = index;
  index = skipLinkWhitespace(value, index, budget);
  if (value[index] === ')') return { destination, end: index + 1 };
  if (index === suffixStart) return undefined;
  const titleEnd = parseLinkTitle(value, index, budget);
  if (titleEnd === undefined) return undefined;
  index = skipLinkWhitespace(value, titleEnd, budget);
  if (value[index] !== ')') return undefined;
  return { destination, end: index + 1 };
}

function extractMarkdownDestinations(content) {
  const budget = createMarkdownBudget(content);
  const masked = maskIgnoredMarkdownContexts(content, budget);
  const scanCharacters = masked.split('');
  const definitions = new Map();
  let lineStart = 0;
  while (lineStart < masked.length) {
    let lineEnd = lineStart;
    while (lineEnd < masked.length && masked[lineEnd] !== '\n') {
      budget.step();
      lineEnd += 1;
    }
    const line = scanCharacters.slice(lineStart, lineEnd).join('');
    const leading = line.match(/^ {0,3}/u)?.[0].length ?? 0;
    if (line[leading] === '[') {
      const bracket = findMarkdownBracketClose(line, leading, budget);
      if (bracket && line[bracket.end + 1] === ':') {
        if (bracket.nested) fail('BROKEN_SKILL_LINK');
        const label = normalizeReferenceLabel(line.slice(leading + 1, bracket.end), budget);
        const remainder = line.slice(bracket.end + 2);
        const parsed = parseInlineLinkDestination(`(${remainder})`, 0, budget);
        if (!label || !parsed || !parsed.destination || parsed.end !== remainder.length + 2
            || definitions.has(label)) fail('BROKEN_SKILL_LINK');
        definitions.set(label, parsed.destination);
        blankMarkdownRange(scanCharacters, lineStart, lineEnd, budget);
        const nextStart = lineEnd + 1;
        let nextEnd = nextStart;
        while (nextEnd < masked.length && masked[nextEnd] !== '\n') {
          budget.step();
          nextEnd += 1;
        }
        const nextLine = scanCharacters.slice(nextStart, nextEnd).join('');
        if (/^ {0,3}["'(]/u.test(nextLine)) fail('BROKEN_SKILL_LINK');
      }
    }
    if (lineEnd < masked.length) budget.step();
    lineStart = lineEnd + 1;
  }

  const destinations = [...definitions.values()];
  const scan = scanCharacters.join('');
  let index = 0;
  while (index < scan.length) {
    budget.step();
    if (isMarkdownEscapeAt(scan, index)) {
      budget.step();
      index += 2;
      continue;
    }
    if (scan[index] === '<') {
      let closing = index + 1;
      while (closing < scan.length && scan[closing] !== '>'
          && scan[closing] !== '\n' && scan[closing] !== '\r') {
        budget.step();
        closing += 1;
      }
      const candidate = scan.slice(index + 1, closing);
      if (closing >= scan.length || scan[closing] !== '>') {
        if (LINK_SCHEME.test(candidate) || RAW_HTML_ANGLE.test(candidate)) fail('BROKEN_SKILL_LINK');
        index += 1;
        continue;
      }
      if (LINK_SCHEME.test(candidate)) {
        if ([...candidate].some((character) => isLinkWhitespace(character)
            || isUnsafeLinkCharacter(character) || character === '<')) fail('BROKEN_SKILL_LINK');
        destinations.push(candidate);
        index = closing + 1;
        continue;
      }
      if (AUTOLINK_EMAIL.test(candidate)) {
        destinations.push(`mailto:${candidate}`);
        index = closing + 1;
        continue;
      }
      if (RAW_HTML_ANGLE.test(candidate)) fail('BROKEN_SKILL_LINK');
      index = closing + 1;
      continue;
    }
    if (scan[index] !== '[') {
      index += 1;
      continue;
    }
    const bracket = findMarkdownBracketClose(scan, index, budget);
    if (!bracket) fail('BROKEN_SKILL_LINK');
    const labelText = scan.slice(index + 1, bracket.end);
    const following = bracket.end + 1;
    if (scan[following] === '(') {
      if (bracket.nested) fail('BROKEN_SKILL_LINK');
      const parsed = parseInlineLinkDestination(scan, following, budget);
      if (!parsed) fail('BROKEN_SKILL_LINK');
      destinations.push(parsed.destination);
      index = parsed.end;
    } else if (scan[following] === '[') {
      if (bracket.nested) fail('BROKEN_SKILL_LINK');
      const reference = findMarkdownBracketClose(scan, following, budget);
      if (!reference || reference.nested) fail('BROKEN_SKILL_LINK');
      const rawReference = scan.slice(following + 1, reference.end) || labelText;
      const label = normalizeReferenceLabel(rawReference, budget);
      if (!definitions.has(label)) fail('BROKEN_SKILL_LINK');
      index = reference.end + 1;
    } else {
      const label = normalizeReferenceLabel(labelText, budget);
      index = bracket.end + 1;
      if (definitions.has(label)) continue;
    }
  }
  return destinations;
}

function markdownDestinationIsValid(sourcePath, destination, paths) {
  if (!destination || /[\x00-\x1f\x7f\u0085\u2028\u2029]/u.test(destination)) return destination === '';
  const scheme = LINK_SCHEME.exec(destination);
  if (scheme) return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase());
  const target = destination.split('#', 1)[0];
  if (!target) return destination.startsWith('#');
  if (target.startsWith('/') || target.endsWith('/')) return false;
  const resolved = path.normalize(path.join(path.dirname(sourcePath), target));
  return paths.has(resolved);
}

function validateCapsuleBytes(raw, options) {
  if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) fail('INVALID_CAPSULE_BYTES');
  const bytes = Buffer.from(raw);
  if (bytes.length > MAX_CAPSULE_BYTES) fail('CAPSULE_TOO_LARGE');
  let capsule;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    capsule = JSON.parse(text, (_key, value, context) => {
      if (typeof value === 'number' && !/^-?(?:0|[1-9][0-9]*)$/.test(context.source)) {
        fail('INVALID_NUMBER_LEXEME');
      }
      return value;
    });
    rejectLoneSurrogates(capsule);
  } catch (error) {
    if (error instanceof BootstrapCapsuleValidationError) throw error;
    fail('INVALID_JSON');
  }

  exactObject(capsule, ['schemaVersion', 'profile', 'model', 'secrets', 'policy', 'skills']);
  if (capsule.schemaVersion !== 1) fail('INVALID_SCHEMA_VERSION');

  exactObject(capsule.profile, ['id', 'revision', 'requiredRcVersion']);
  if (!SLUG.test(requireString(capsule.profile.id, 'INVALID_PROFILE_ID'))) fail('INVALID_PROFILE_ID');
  requireInteger(capsule.profile.revision, 'INVALID_REVISION');
  if (capsule.profile.requiredRcVersion !== options?.rcVersion || options?.rcVersion !== '0.8.3') {
    fail('RC_VERSION_MISMATCH');
  }

  exactObject(capsule.model, ['providerId', 'api', 'baseUrl', 'model']);
  if (!PROVIDER.test(requireString(capsule.model.providerId, 'INVALID_PROVIDER_ID'))
      || Buffer.byteLength(capsule.model.providerId, 'utf8') > MAX_PORTABLE_COMPONENT_BYTES) {
    fail('INVALID_PROVIDER_ID');
  }
  if (!PROTOCOLS.has(capsule.model.api)) fail('INVALID_PROTOCOL');
  const baseUrl = requireString(capsule.model.baseUrl, 'INVALID_BASE_URL', { max: 2048 });
  if (!/^[\x21-\x7e]+$/.test(baseUrl)
      || !baseUrl.startsWith('https://')
      || baseUrl.startsWith('https:///')
      || baseUrl.includes('\\')
      || baseUrl.includes('?')
      || baseUrl.includes('#')
      || /%(?![0-9a-fA-F]{2})/.test(baseUrl)
      || !validCanonicalHttpsAuthority(baseUrl)
      || !canonicalHttpsPathIsValid(baseUrl)) fail('INVALID_BASE_URL');
  exactObject(capsule.model.model, ['id', 'name', 'input', 'contextWindow', 'maxTokens']);
  requireString(capsule.model.model.id, 'INVALID_MODEL', { max: 256 });
  requireString(capsule.model.model.name, 'INVALID_MODEL', { max: 256 });
  if (!Array.isArray(capsule.model.model.input)
      || capsule.model.model.input.length < 1
      || capsule.model.model.input.length > 2
      || new Set(capsule.model.model.input).size !== capsule.model.model.input.length
      || capsule.model.model.input.some((item) => !['text', 'image'].includes(item))) {
    fail('INVALID_MODEL_INPUT');
  }
  const contextWindow = requireInteger(capsule.model.model.contextWindow, 'INVALID_MODEL', { max: 10_000_000 });
  const maxTokens = requireInteger(capsule.model.model.maxTokens, 'INVALID_MODEL', { max: 1_000_000 });
  if (maxTokens > contextWindow) fail('INVALID_MODEL');

  exactObject(capsule.secrets, ['modelApiKey']);
  const key = requireString(capsule.secrets.modelApiKey, 'INVALID_MODEL_KEY');
  const keyBytes = Buffer.byteLength(key, 'utf8');
  if (keyBytes < MIN_API_KEY_BYTES || keyBytes > MAX_API_KEY_BYTES
      || hasWireBoundaryWhitespace(key)) fail('INVALID_MODEL_KEY');

  exactObject(capsule.policy, ['capabilities', 'supervisor']);
  exactObject(capsule.policy.capabilities, ['peripherals', 'supervisor', 'settings', 'extensions']);
  if (!['enabled', 'enabled-hidden', 'disabled'].includes(capsule.policy.capabilities.peripherals)
      || !['enabled', 'enabled-hidden'].includes(capsule.policy.capabilities.supervisor)
      || !['enabled', 'enabled-hidden'].includes(capsule.policy.capabilities.settings)
      || !['enabled', 'enabled-hidden'].includes(capsule.policy.capabilities.extensions)) {
    fail('INVALID_POLICY');
  }
  exactObject(capsule.policy.supervisor, ['reviewMode', 'inheritPrimaryModel']);
  if (capsule.policy.supervisor.reviewMode !== 'correct' || capsule.policy.supervisor.inheritPrimaryModel !== true) fail('INVALID_POLICY');

  exactObject(capsule.skills, ['items']);
  if (!Array.isArray(capsule.skills.items) || capsule.skills.items.length < 1 || capsule.skills.items.length > MAX_SKILLS) fail('INVALID_SKILLS');
  const slugs = new Set();
  let skillFiles = 0;
  let skillBytes = 0;
  for (const item of capsule.skills.items) {
    exactObject(item, ['slug', 'files']);
    if (!SLUG.test(requireString(item.slug, 'INVALID_SKILL_SLUG'))) fail('INVALID_SKILL_SLUG');
    if (Buffer.byteLength(`rc-profile--${capsule.profile.id}--${item.slug}`, 'utf8')
        > MAX_PORTABLE_COMPONENT_BYTES) fail('INVALID_SKILL_PATH');
    if (slugs.has(item.slug)) fail('DUPLICATE_SKILL');
    slugs.add(item.slug);
    if (!Array.isArray(item.files) || item.files.length < 1) fail('INVALID_SKILL_FILES');
    const paths = new Set();
    const portablePathKeys = [];
    let skillMd;
    for (const file of item.files) {
      exactObject(file, ['path', 'encoding', 'sha256', 'content']);
      if (!skillPathIsValid(file.path)) fail('INVALID_SKILL_PATH');
      if (paths.has(file.path)) fail('DUPLICATE_SKILL_FILE');
      const portableKey = portablePathCollisionKey(file.path);
      if (portablePathKeys.some((existing) => existing === portableKey
          || existing.startsWith(`${portableKey}/`) || portableKey.startsWith(`${existing}/`))) {
        fail('DUPLICATE_SKILL_FILE');
      }
      paths.add(file.path);
      portablePathKeys.push(portableKey);
      if (file.encoding !== 'utf8') fail('INVALID_SKILL_ENCODING');
      requireString(file.content, 'INVALID_SKILL_CONTENT', { min: 0 });
      const fileBytes = Buffer.byteLength(file.content);
      if (fileBytes > MAX_FILE_BYTES) fail('SKILL_FILE_TOO_LARGE');
      if (!SHA256.test(file.sha256)) fail('INVALID_SKILL_HASH');
      if (crypto.createHash('sha256').update(file.content).digest('hex') !== file.sha256) fail('SKILL_HASH_MISMATCH');
      if (file.path === 'SKILL.md') {
        if (skillMd) fail('INVALID_SKILL_ROOT');
        skillMd = file.content;
      }
      skillFiles += 1;
      skillBytes += fileBytes;
    }
    if (skillMd === undefined) fail('INVALID_SKILL_ROOT');
    if (frontmatter(skillMd).name !== item.slug) fail('INVALID_SKILL_FRONTMATTER');
    for (const file of item.files) {
      for (const destination of extractMarkdownDestinations(file.content)) {
        if (!markdownDestinationIsValid(file.path, destination, paths)) fail('BROKEN_SKILL_LINK');
      }
    }
  }
  if (skillFiles > MAX_FILES) fail('TOO_MANY_SKILL_FILES');
  if (skillBytes > MAX_CAPSULE_BYTES) fail('SKILL_CONTENT_TOO_LARGE');

  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    capsule,
    digest,
    authProfileId: `${capsule.model.providerId}:managed`,
    skillFiles,
    skillBytes,
  };
}

module.exports = {
  BootstrapCapsuleValidationError,
  MAX_CAPSULE_BYTES,
  validateCapsuleBytes,
  __test: Object.freeze({
    unicode15ScalarIsAssigned,
    unicode15CaseKey,
  }),
};
