import {
  identifierAt,
  identifierEndingAt,
  isIdentPart,
  KIND_CODE,
  KIND_COMMENT,
  lineStartOffset,
  matchBracketBackwards,
  readIdentifier,
  skipWhitespace,
  skipWhitespaceBackwards,
} from '../util/text';

export interface RefSegment {
  name: string;
  start: number;
  end: number;
  /** The segment is immediately followed by `(` or a trailing lambda. */
  isCall: boolean;
}

export type ReferenceKind = 'expression' | 'import' | 'package' | 'kdoc' | 'annotation' | 'namedArgument';

export interface ReferenceChain {
  segments: RefSegment[];
  /** Index of the segment the cursor is on; everything before it is the qualifier. */
  targetIndex: number;
  kind: ReferenceKind;
  /** The receiver could not be modelled (index access, lambda result, ...). */
  opaqueReceiver: boolean;
  /** For imports: the full dotted path as written. */
  fullPath?: string;
}

/**
 * Works out what the cursor is pointing at.
 *
 * Operates on the *masked* source, so a `class` inside a comment or a string is
 * never mistaken for code - with the deliberate exception of Kotlin string
 * templates, whose contents the masker keeps visible.
 */
export function referenceAt(masked: string, kinds: Uint8Array, raw: string, offset: number): ReferenceChain | undefined {
  if (offset > 0 && kinds[offset] !== KIND_CODE && kinds[offset - 1] !== KIND_CODE) {
    // Inside a comment: KDoc links such as [SearchState] are still navigable.
    if (kinds[offset] === KIND_COMMENT || kinds[offset - 1] === KIND_COMMENT) {
      return kdocLinkAt(raw, offset);
    }
    return undefined;
  }

  const target = identifierAt(masked, offset);
  if (!target || !target.name) {
    return undefined;
  }
  if (/^\d/.test(target.name)) {
    return undefined;
  }

  const segments: RefSegment[] = [
    { name: target.name, start: target.start, end: target.end, isCall: isFollowedByCall(masked, target.end) },
  ];
  let opaqueReceiver = false;

  // Walk the qualifier chain leftwards: `a.b().c.|d`
  let cursor = target.start;
  for (let guard = 0; guard < 64; guard++) {
    let j = skipWhitespaceBackwards(masked, cursor);
    if (j === 0 || masked[j - 1] !== '.') {
      break;
    }
    j--; // step over the dot
    if (j > 0 && (masked[j - 1] === '?' || masked[j - 1] === '!')) {
      j--;
    }
    j = skipWhitespaceBackwards(masked, j);
    if (j === 0) {
      break;
    }

    const prevChar = masked[j - 1];
    if (prevChar === ')') {
      const open = matchBracketBackwards(masked, j - 1, '(', ')');
      if (open < 0) {
        opaqueReceiver = true;
        break;
      }
      const beforeParen = skipWhitespaceBackwards(masked, open);
      const callee = identifierEndingAt(masked, beforeParen);
      if (!callee) {
        opaqueReceiver = true;
        break;
      }
      segments.unshift({ name: callee.name, start: callee.start, end: callee.end, isCall: true });
      cursor = callee.start;
      continue;
    }
    if (prevChar === ']' || prevChar === '}' || prevChar === '"') {
      opaqueReceiver = true;
      break;
    }

    const prev = identifierEndingAt(masked, j);
    if (!prev) {
      opaqueReceiver = true;
      break;
    }
    segments.unshift({ name: prev.name, start: prev.start, end: prev.end, isCall: false });
    cursor = prev.start;
  }

  const targetIndex = segments.length - 1;
  const kind = classify(masked, segments[0].start, segments[targetIndex]);

  if (kind === 'import' || kind === 'package') {
    // For imports the whole dotted path is written out, so extend to the right
    // as well and resolve the prefix ending at the cursor.
    const full = readDottedForward(masked, segments[0].start);
    return {
      segments: full.segments,
      targetIndex: full.segments.findIndex((s) => s.start === segments[targetIndex].start),
      kind,
      opaqueReceiver: false,
      fullPath: full.segments.map((s) => s.name).join('.'),
    };
  }

  return { segments, targetIndex, kind, opaqueReceiver };
}

function isFollowedByCall(masked: string, end: number): boolean {
  const j = skipWhitespace(masked, end);
  return masked[j] === '(' || masked[j] === '{';
}

function classify(masked: string, headStart: number, target: RefSegment): ReferenceKind {
  const lineStart = lineStartOffset(masked, headStart);
  const firstTok = readIdentifier(masked, skipWhitespace(masked, lineStart));
  if (firstTok?.name === 'import' && firstTok.end <= headStart) {
    return 'import';
  }
  if (firstTok?.name === 'package' && firstTok.end <= headStart) {
    return 'package';
  }
  const before = skipWhitespaceBackwards(masked, headStart);
  if (before > 0 && masked[before - 1] === '@') {
    return 'annotation';
  }
  // `foo(bar = 1)` - `bar` names a parameter of `foo`, not a variable.
  const after = skipWhitespace(masked, target.end);
  if (masked[after] === '=' && masked[after + 1] !== '=' && headStart === target.start) {
    const beforeName = skipWhitespaceBackwards(masked, target.start);
    if (beforeName > 0 && (masked[beforeName - 1] === '(' || masked[beforeName - 1] === ',')) {
      return 'namedArgument';
    }
  }
  return 'expression';
}

function readDottedForward(masked: string, start: number): { segments: RefSegment[] } {
  const segments: RefSegment[] = [];
  let i = start;
  for (let guard = 0; guard < 64; guard++) {
    const tok = readIdentifier(masked, i);
    if (!tok) {
      break;
    }
    segments.push({ name: tok.name, start: tok.start, end: tok.end, isCall: false });
    const next = skipWhitespace(masked, tok.end);
    if (masked[next] === '.') {
      i = skipWhitespace(masked, next + 1);
      continue;
    }
    break;
  }
  return { segments };
}

/** `[SomeClass]` and `[SomeClass.member]` inside a KDoc block. */
function kdocLinkAt(raw: string, offset: number): ReferenceChain | undefined {
  const lineStart = lineStartOffset(raw, offset);
  const lineEnd = raw.indexOf('\n', offset);
  const line = raw.substring(lineStart, lineEnd < 0 ? raw.length : lineEnd);
  const rel = offset - lineStart;

  let open = -1;
  for (let k = rel; k >= 0; k--) {
    if (line[k] === '[') {
      open = k;
      break;
    }
    if (line[k] === ']') {
      return undefined;
    }
  }
  if (open < 0) {
    return undefined;
  }
  const close = line.indexOf(']', open);
  if (close < 0 || rel > close) {
    return undefined;
  }
  const inner = line.substring(open + 1, close);
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(inner)) {
    return undefined;
  }
  const segments: RefSegment[] = [];
  let cursor = lineStart + open + 1;
  for (const part of inner.split('.')) {
    segments.push({ name: part, start: cursor, end: cursor + part.length, isCall: false });
    cursor += part.length + 1;
  }
  const targetIndex = segments.findIndex((s) => offset >= s.start && offset <= s.end);
  return {
    segments,
    targetIndex: targetIndex < 0 ? segments.length - 1 : targetIndex,
    kind: 'kdoc',
    opaqueReceiver: false,
  };
}

/** The word under the cursor in raw text, used by the resource providers. */
export function wordAt(raw: string, offset: number): { name: string; start: number; end: number } | undefined {
  let start = offset;
  if (start >= raw.length || !isIdentPart(raw[start])) {
    if (start > 0 && isIdentPart(raw[start - 1])) {
      start--;
    } else {
      return undefined;
    }
  }
  while (start > 0 && isIdentPart(raw[start - 1])) {
    start--;
  }
  let end = start;
  while (end < raw.length && isIdentPart(raw[end])) {
    end++;
  }
  return { name: raw.substring(start, end), start, end };
}
