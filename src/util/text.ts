/**
 * Lexical helpers shared by the Kotlin and Java scanners.
 *
 * The scanners never see raw source directly. They work on a *masked* copy in
 * which comments and string literals have been replaced by spaces of the exact
 * same length, so every offset in the masked text is also a valid offset in the
 * original. That removes the single biggest source of false positives for a
 * regex-flavoured parser (the word `class` inside a doc comment or a string)
 * while keeping offsets usable for jumping to a location.
 */

export const KIND_CODE = 0;
export const KIND_COMMENT = 1;
export const KIND_STRING = 2;

export interface MaskResult {
  /** Same length as the input; comments and string bodies blanked out. */
  masked: string;
  /** Per-character classification, one of the KIND_* constants. */
  kinds: Uint8Array;
}

interface Frame {
  kind: 'code' | 'string' | 'raw';
  braceDepth: number;
}

export function isIdentStart(c: string | undefined): boolean {
  if (!c) {
    return false;
  }
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c.charCodeAt(0) > 127;
}

export function isIdentPart(c: string | undefined): boolean {
  if (!c) {
    return false;
  }
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

export function isDigit(c: string | undefined): boolean {
  return !!c && c >= '0' && c <= '9';
}

/**
 * Blank out comments and string literals.
 *
 * Kotlin string templates are deliberately left visible: the body of `${...}`
 * and the identifier in `$name` stay classified as code, because those really
 * are expressions the user expects to be able to ctrl-click.
 */
export function maskSource(text: string, options: { templates?: boolean; nestedBlockComments?: boolean } = {}): MaskResult {
  const templates = options.templates ?? true;
  const nestedBlockComments = options.nestedBlockComments ?? true;
  const n = text.length;
  const buf: string[] = new Array(n);
  const kinds = new Uint8Array(n);
  const stack: Frame[] = [{ kind: 'code', braceDepth: 0 }];
  let i = 0;

  const put = (idx: number, ch: string, kind: number): void => {
    buf[idx] = ch;
    kinds[idx] = kind;
  };
  // Replace with a space but keep line terminators so line numbers survive.
  const blank = (idx: number, kind: number): void => {
    const c = text[idx];
    put(idx, c === '\n' || c === '\r' ? c : ' ', kind);
  };

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = text[i];

    if (frame.kind === 'code') {
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') {
          blank(i, KIND_COMMENT);
          i++;
        }
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        let depth = 0;
        while (i < n) {
          if (text[i] === '/' && text[i + 1] === '*') {
            blank(i, KIND_COMMENT);
            blank(i + 1, KIND_COMMENT);
            i += 2;
            depth++;
            if (!nestedBlockComments) {
              depth = 1;
            }
            continue;
          }
          if (text[i] === '*' && text[i + 1] === '/') {
            blank(i, KIND_COMMENT);
            blank(i + 1, KIND_COMMENT);
            i += 2;
            depth--;
            if (depth <= 0) {
              break;
            }
            continue;
          }
          blank(i, KIND_COMMENT);
          i++;
        }
        continue;
      }
      if (c === '"') {
        if (text.startsWith('"""', i)) {
          blank(i, KIND_STRING);
          blank(i + 1, KIND_STRING);
          blank(i + 2, KIND_STRING);
          i += 3;
          stack.push({ kind: 'raw', braceDepth: 0 });
          continue;
        }
        blank(i, KIND_STRING);
        i++;
        stack.push({ kind: 'string', braceDepth: 0 });
        continue;
      }
      if (c === "'") {
        blank(i, KIND_STRING);
        i++;
        while (i < n && text[i] !== "'" && text[i] !== '\n') {
          if (text[i] === '\\' && i + 1 < n) {
            blank(i, KIND_STRING);
            i++;
          }
          blank(i, KIND_STRING);
          i++;
        }
        if (i < n && text[i] === "'") {
          blank(i, KIND_STRING);
          i++;
        }
        continue;
      }
      // A `}` that closes an enclosing `${` template expression.
      if (c === '}' && stack.length > 1 && frame.braceDepth === 0) {
        blank(i, KIND_STRING);
        i++;
        stack.pop();
        continue;
      }
      if (c === '{') {
        frame.braceDepth++;
      } else if (c === '}') {
        frame.braceDepth--;
      }
      put(i, c, KIND_CODE);
      i++;
      continue;
    }

    // Inside a string literal.
    const raw = frame.kind === 'raw';
    if (!raw && c === '\\') {
      blank(i, KIND_STRING);
      i++;
      if (i < n) {
        blank(i, KIND_STRING);
        i++;
      }
      continue;
    }
    if (raw && text.startsWith('"""', i)) {
      blank(i, KIND_STRING);
      blank(i + 1, KIND_STRING);
      blank(i + 2, KIND_STRING);
      i += 3;
      stack.pop();
      continue;
    }
    if (!raw && c === '"') {
      blank(i, KIND_STRING);
      i++;
      stack.pop();
      continue;
    }
    if (!raw && c === '\n') {
      // Unterminated literal - recover at the line break rather than eating the file.
      put(i, c, KIND_STRING);
      i++;
      stack.pop();
      continue;
    }
    if (templates && c === '$') {
      if (text[i + 1] === '{') {
        blank(i, KIND_STRING);
        blank(i + 1, KIND_STRING);
        i += 2;
        stack.push({ kind: 'code', braceDepth: 0 });
        continue;
      }
      if (isIdentStart(text[i + 1]) && text[i + 1] !== '$') {
        blank(i, KIND_STRING);
        i++;
        while (i < n && isIdentPart(text[i])) {
          put(i, text[i], KIND_CODE);
          i++;
        }
        continue;
      }
    }
    blank(i, KIND_STRING);
    i++;
  }

  for (let k = 0; k < n; k++) {
    if (buf[k] === undefined) {
      buf[k] = text[k];
    }
  }
  return { masked: buf.join(''), kinds };
}

export function skipWhitespace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  return i;
}

export function skipWhitespaceBackwards(text: string, i: number): number {
  while (i > 0 && /\s/.test(text[i - 1])) {
    i--;
  }
  return i;
}

export interface IdentToken {
  name: string;
  start: number;
  end: number;
}

/** Reads an identifier at `i`, transparently handling Kotlin's `` `quoted names` ``. */
export function readIdentifier(text: string, i: number): IdentToken | undefined {
  if (text[i] === '`') {
    const close = text.indexOf('`', i + 1);
    if (close < 0) {
      return undefined;
    }
    return { name: text.substring(i + 1, close), start: i, end: close + 1 };
  }
  if (!isIdentStart(text[i])) {
    return undefined;
  }
  let j = i;
  while (j < text.length && isIdentPart(text[j])) {
    j++;
  }
  return { name: text.substring(i, j), start: i, end: j };
}

/**
 * Given an offset inside an identifier, returns the whole identifier.
 * Handles backtick-quoted names on either side of the cursor.
 */
export function identifierAt(text: string, offset: number): IdentToken | undefined {
  const n = text.length;
  if (offset > n) {
    return undefined;
  }
  // Backtick-quoted name containing the offset.
  let tickStart = -1;
  for (let k = offset; k >= 0 && k > offset - 256; k--) {
    if (text[k] === '`') {
      tickStart = k;
      break;
    }
    if (text[k] === '\n') {
      break;
    }
  }
  if (tickStart >= 0) {
    const close = text.indexOf('`', tickStart + 1);
    if (close >= 0 && offset <= close) {
      return { name: text.substring(tickStart + 1, close), start: tickStart, end: close + 1 };
    }
  }

  let start = offset;
  if (start >= n || !isIdentPart(text[start])) {
    if (start > 0 && isIdentPart(text[start - 1])) {
      start--;
    } else {
      return undefined;
    }
  }
  while (start > 0 && isIdentPart(text[start - 1])) {
    start--;
  }
  if (!isIdentStart(text[start])) {
    return undefined;
  }
  let end = start;
  while (end < n && isIdentPart(text[end])) {
    end++;
  }
  return { name: text.substring(start, end), start, end };
}

/**
 * Index just past the bracket that matches the one at `i`.
 * Returns -1 when unbalanced.
 */
export function matchBracket(text: string, i: number, open: string, close: string): number {
  if (text[i] !== open) {
    return -1;
  }
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) {
        return k + 1;
      }
    }
  }
  return -1;
}

/**
 * Index just past a `<...>` type-argument list starting at `i`.
 *
 * Angle brackets are ambiguous in a token stream, so this bails out (returns
 * `i`) on anything that clearly is not a type argument list - a newline with
 * unbalanced depth, a `;`, or a stray `{`.
 */
export function matchAngles(text: string, i: number): number {
  if (text[i] !== '<') {
    return i;
  }
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '<') {
      depth++;
    } else if (c === '>') {
      depth--;
      if (depth === 0) {
        return k + 1;
      }
    } else if (c === '(') {
      const after = matchBracket(text, k, '(', ')');
      if (after < 0) {
        return i;
      }
      k = after - 1;
    } else if (c === ';' || c === '{' || c === '}') {
      return i;
    } else if (c === '-' && text[k + 1] === '>') {
      k++; // function type inside a bound: `<T : (A) -> B>`
    }
  }
  return i;
}

/** Splits on commas that are not nested inside (), <>, [] or {}. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let last = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    switch (c) {
      case '(':
        depthParen++;
        break;
      case ')':
        depthParen--;
        break;
      case '[':
        depthBracket++;
        break;
      case ']':
        depthBracket--;
        break;
      case '{':
        depthBrace++;
        break;
      case '}':
        depthBrace--;
        break;
      case '<':
        depthAngle++;
        break;
      case '>':
        if (text[k - 1] !== '-') {
          depthAngle--;
        }
        break;
      default:
        if (c === separator && depthParen === 0 && depthAngle === 0 && depthBracket === 0 && depthBrace === 0) {
          parts.push(text.substring(last, k));
          last = k + 1;
        }
    }
  }
  parts.push(text.substring(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Byte-offset -> {line, character}, for files that are not open in the editor. */
export class LineMap {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        this.starts.push(i + 1);
      }
    }
  }

  positionAt(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, character: offset - this.starts[lo] };
  }

  offsetAt(line: number, character: number): number {
    const base = this.starts[Math.max(0, Math.min(line, this.starts.length - 1))];
    return base + character;
  }
}

/** Reads the identifier that ends exactly at `end` (scanning backwards). */
export function identifierEndingAt(text: string, end: number): IdentToken | undefined {
  if (end <= 0) {
    return undefined;
  }
  if (text[end - 1] === '`') {
    const open = text.lastIndexOf('`', end - 2);
    if (open < 0) {
      return undefined;
    }
    return { name: text.substring(open + 1, end - 1), start: open, end };
  }
  if (!isIdentPart(text[end - 1])) {
    return undefined;
  }
  let start = end;
  while (start > 0 && isIdentPart(text[start - 1])) {
    start--;
  }
  if (!isIdentStart(text[start])) {
    return undefined;
  }
  return { name: text.substring(start, end), start, end };
}

/**
 * Index of the bracket matching the closing one at `close`.
 * Returns -1 when unbalanced.
 */
export function matchBracketBackwards(text: string, close: number, open: string, closeChar: string): number {
  if (text[close] !== closeChar) {
    return -1;
  }
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const c = text[k];
    if (c === closeChar) {
      depth++;
    } else if (c === open) {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return -1;
}

/** Start offset of the line containing `offset`. */
export function lineStartOffset(text: string, offset: number): number {
  const idx = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return idx < 0 ? 0 : idx + 1;
}

/** Interning table so the word index does not hold a copy per file. */
const internTable = new Map<string, string>();

function intern(word: string): string {
  const existing = internTable.get(word);
  if (existing !== undefined) {
    return existing;
  }
  internTable.set(word, word);
  return word;
}

/**
 * Every distinct identifier appearing in code positions of the masked source.
 *
 * This is what makes Find All References fast: instead of re-reading every
 * file in the workspace, the index can go straight to the files that mention
 * the name at all.
 */
export function collectIdentifiers(masked: string): string[] {
  const out = new Set<string>();
  let i = 0;
  const n = masked.length;
  while (i < n) {
    if (!isIdentStart(masked[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isIdentPart(masked[j])) {
      j++;
    }
    if (j - i <= 64) {
      out.add(intern(masked.substring(i, j)));
    }
    i = j;
  }
  return [...out];
}
