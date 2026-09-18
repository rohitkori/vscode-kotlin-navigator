import { Declaration, DeclKind, ImportEntry, ParsedFile, TYPE_KINDS } from './types';
import { collectIdentifiers, IdentToken, matchAngles, matchBracket, maskSource, readIdentifier, skipWhitespace } from '../util/text';

const JAVA_MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'native',
  'synchronized', 'transient', 'volatile', 'strictfp', 'default', 'sealed',
  'non-sealed',
]);

const TYPE_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);

interface Frame {
  declIndex: number;
  braceDepth: number;
  localScope: boolean;
  enumEntriesOpen: boolean;
}

interface State {
  file: string;
  source: string;
  masked: string;
  decls: Declaration[];
  topLevel: number[];
  stack: Frame[];
  packageName: string;
  braceDepth: number;
}

export function parseJava(file: string, source: string): ParsedFile {
  const { masked } = maskSource(source, { templates: false, nestedBlockComments: false });
  const state: State = {
    file,
    source,
    masked,
    decls: [],
    topLevel: [],
    stack: [],
    packageName: '',
    braceDepth: 0,
  };
  const imports: ImportEntry[] = [];
  const n = masked.length;
  let i = 0;
  let pendingModifiers: string[] = [];
  let pendingStart = -1;
  let pendingBodyOwner = -1;

  const clearPending = (): void => {
    pendingModifiers = [];
    pendingStart = -1;
  };

  while (i < n) {
    const c = masked[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    if (c === '{') {
      state.braceDepth++;
      if (pendingBodyOwner >= 0) {
        const owner = state.decls[pendingBodyOwner];
        state.stack.push({
          declIndex: pendingBodyOwner,
          braceDepth: state.braceDepth,
          localScope: owner.kind === 'function' || owner.kind === 'constructor',
          enumEntriesOpen: owner.kind === 'enum',
        });
        pendingBodyOwner = -1;
      } else {
        state.stack.push({ declIndex: -1, braceDepth: state.braceDepth, localScope: true, enumEntriesOpen: false });
      }
      clearPending();
      i++;
      continue;
    }

    if (c === '}') {
      while (state.stack.length > 0 && state.stack[state.stack.length - 1].braceDepth === state.braceDepth) {
        const frame = state.stack.pop()!;
        if (frame.declIndex >= 0) {
          state.decls[frame.declIndex].endOffset = i + 1;
        }
      }
      state.braceDepth--;
      clearPending();
      i++;
      continue;
    }

    if (c === '@') {
      const after = readIdentifier(masked, skipWhitespace(masked, i + 1));
      if (after?.name === 'interface') {
        const start = pendingStart >= 0 ? pendingStart : i;
        const res = parseTypeDeclaration(state, after, start, pendingModifiers, 'annotationClass');
        clearPending();
        if (res) {
          i = res.end;
          pendingBodyOwner = res.bodyOwner;
          continue;
        }
      }
      i = skipAnnotation(masked, i);
      if (pendingStart < 0) {
        pendingStart = i;
      }
      continue;
    }

    if (c === ';') {
      const top = state.stack[state.stack.length - 1];
      if (top?.enumEntriesOpen && state.braceDepth === top.braceDepth) {
        top.enumEntriesOpen = false;
      }
      clearPending();
      i++;
      continue;
    }

    const tok = readIdentifier(masked, i);
    if (!tok) {
      clearPending();
      i++;
      continue;
    }

    if (state.braceDepth === 0 && tok.name === 'package' && !state.packageName) {
      const path = readDottedPath(masked, tok.end);
      state.packageName = path.text;
      i = path.end;
      clearPending();
      continue;
    }
    if (state.braceDepth === 0 && tok.name === 'import') {
      const entry = readImport(masked, tok.end);
      if (entry) {
        imports.push(entry);
        i = entry.offset + entry.length;
      } else {
        i = tok.end;
      }
      clearPending();
      continue;
    }

    if (JAVA_MODIFIERS.has(tok.name)) {
      if (pendingStart < 0) {
        pendingStart = tok.start;
      }
      pendingModifiers.push(tok.name);
      i = tok.end;
      continue;
    }

    if (TYPE_KEYWORDS.has(tok.name)) {
      const kind: DeclKind = tok.name === 'interface' ? 'interface' : tok.name === 'enum' ? 'enum' : 'class';
      const start = pendingStart >= 0 ? pendingStart : tok.start;
      const res = parseTypeDeclaration(state, tok, start, pendingModifiers, kind);
      clearPending();
      if (res) {
        i = res.end;
        pendingBodyOwner = res.bodyOwner;
        continue;
      }
      i = tok.end;
      continue;
    }

    const top = state.stack[state.stack.length - 1];
    const inTypeBody =
      top && top.declIndex >= 0 && state.braceDepth === top.braceDepth && TYPE_KINDS.has(state.decls[top.declIndex].kind);

    if (inTypeBody) {
      const start = pendingStart >= 0 ? pendingStart : tok.start;
      if (top.enumEntriesOpen) {
        const entry = tryParseEnumConstant(state, tok, start);
        if (entry) {
          clearPending();
          i = entry.end;
          pendingBodyOwner = entry.bodyOwner;
          continue;
        }
        top.enumEntriesOpen = false;
      }
      const member = parseMember(state, tok, start, pendingModifiers, top);
      clearPending();
      if (member) {
        i = member.end;
        pendingBodyOwner = member.bodyOwner;
        continue;
      }
    }

    clearPending();
    i = tok.end;
  }

  for (const frame of state.stack) {
    if (frame.declIndex >= 0 && state.decls[frame.declIndex].endOffset <= state.decls[frame.declIndex].startOffset) {
      state.decls[frame.declIndex].endOffset = n;
    }
  }

  return {
    file,
    language: 'java',
    packageName: state.packageName,
    imports,
    declarations: state.decls,
    topLevel: state.topLevel,
    sourceLength: source.length,
    identifiers: collectIdentifiers(masked),
  };
}

interface DeclResult {
  end: number;
  bodyOwner: number;
}

function parseTypeDeclaration(
  state: State,
  keyword: IdentToken,
  start: number,
  modifiers: string[],
  kind: DeclKind,
): DeclResult | undefined {
  const m = state.masked;
  let i = skipWhitespace(m, keyword.end);
  const nameTok = readIdentifier(m, i);
  if (!nameTok) {
    return undefined;
  }
  i = matchAngles(m, skipWhitespace(m, nameTok.end));
  i = skipWhitespace(m, i);

  const index = addDeclaration(state, {
    kind,
    name: nameTok.name,
    nameOffset: nameTok.start,
    nameLength: nameTok.end - nameTok.start,
    startOffset: start,
    modifiers,
  });

  // Record components behave like constructor parameters and fields.
  let recordParams: { start: number; end: number } | undefined;
  if (m[i] === '(') {
    const after = matchBracket(m, i, '(', ')');
    if (after > 0) {
      recordParams = { start: i + 1, end: after - 1 };
      i = skipWhitespace(m, after);
    }
  }

  // `extends A implements B, C` - one region, several keywords. Reading to the
  // body and then splitting on the keywords keeps `implements` out of the name
  // of the superclass.
  const supertypes: string[] = [];
  const header = readUntil(m, i, new Set(['{', ';']));
  if (header.end > i) {
    const region = m.substring(i, header.end);
    const keywordPattern = /\b(extends|implements|permits)\b/g;
    const sections: Array<{ keyword: string; start: number; end: number }> = [];
    let keywordMatch: RegExpExecArray | null;
    while ((keywordMatch = keywordPattern.exec(region)) !== null) {
      if (sections.length > 0) {
        sections[sections.length - 1].end = keywordMatch.index;
      }
      sections.push({ keyword: keywordMatch[1], start: keywordMatch.index + keywordMatch[0].length, end: region.length });
    }
    for (const section of sections) {
      if (section.keyword === 'permits') {
        continue;
      }
      for (const part of splitTopLevelRanges(m, i + section.start, i + section.end)) {
        const cleaned = cleanTypeName(part.text);
        if (cleaned) {
          supertypes.push(cleaned);
        }
      }
    }
    i = skipWhitespace(m, header.end);
  }

  const decl = state.decls[index];
  decl.supertypes = supertypes.length ? supertypes : undefined;
  decl.signature = renderSignature(state.source, start, i);
  decl.endOffset = i;

  if (recordParams) {
    parseParameters(state, recordParams.start, recordParams.end, index, true);
  }

  if (m[i] === '{') {
    return { end: i, bodyOwner: index };
  }
  return { end: i, bodyOwner: -1 };
}

function tryParseEnumConstant(state: State, tok: IdentToken, start: number): DeclResult | undefined {
  const m = state.masked;
  if (JAVA_MODIFIERS.has(tok.name) || TYPE_KEYWORDS.has(tok.name)) {
    return undefined;
  }
  let i = skipWhitespace(m, tok.end);
  if (m[i] !== ',' && m[i] !== ';' && m[i] !== '(' && m[i] !== '{' && m[i] !== '}') {
    return undefined;
  }
  if (m[i] === '(') {
    const after = matchBracket(m, i, '(', ')');
    if (after < 0) {
      return undefined;
    }
    i = skipWhitespace(m, after);
  }
  const index = addDeclaration(state, {
    kind: 'enumEntry',
    name: tok.name,
    nameOffset: tok.start,
    nameLength: tok.end - tok.start,
    startOffset: start,
    modifiers: [],
  });
  state.decls[index].signature = renderSignature(state.source, start, i);
  state.decls[index].endOffset = i;
  if (m[i] === '{') {
    return { end: i, bodyOwner: index };
  }
  return { end: i, bodyOwner: -1 };
}

/** Parses a field, method or constructor inside a type body. */
function parseMember(state: State, first: IdentToken, start: number, modifiers: string[], frame: Frame): DeclResult | undefined {
  const m = state.masked;
  const ownerName = state.decls[frame.declIndex].name;
  let i = first.start;

  // Generic method type parameters: `public <T> T foo(...)`.
  if (m[i] === '<') {
    i = matchAngles(m, i);
    i = skipWhitespace(m, i);
  }

  const firstType = readTypeRef(m, i);
  if (!firstType) {
    return undefined;
  }
  i = skipWhitespace(m, firstType.end);

  // `Foo(...)` with no return type is a constructor.
  if (m[i] === '(' && firstType.simpleName === ownerName && !firstType.hasGenericsOrDots) {
    return finishMethod(state, start, modifiers, firstType.nameToken, i, undefined);
  }

  const nameTok = readIdentifier(m, i);
  if (!nameTok) {
    return undefined;
  }
  i = skipWhitespace(m, nameTok.end);

  if (m[i] === '(') {
    return finishMethod(state, start, modifiers, nameTok, i, firstType.text);
  }

  // Field declaration, possibly several names in one statement.
  let arraySuffix = '';
  while (m[i] === '[') {
    const after = matchBracket(m, i, '[', ']');
    if (after < 0) {
      break;
    }
    arraySuffix += '[]';
    i = skipWhitespace(m, after);
  }
  if (m[i] !== '=' && m[i] !== ';' && m[i] !== ',') {
    return undefined;
  }

  const stmtEnd = readUntil(m, i, new Set([';'])).end;
  const index = addDeclaration(state, {
    kind: 'property',
    name: nameTok.name,
    nameOffset: nameTok.start,
    nameLength: nameTok.end - nameTok.start,
    startOffset: start,
    modifiers,
    typeText: firstType.text + arraySuffix,
  });
  state.decls[index].signature = renderSignature(state.source, start, Math.min(stmtEnd, nameTok.end + 120));
  state.decls[index].endOffset = stmtEnd;

  // `int a, b, c;`
  if (m[i] === ',') {
    for (const part of splitTopLevelRanges(m, i + 1, stmtEnd)) {
      const extra = readIdentifier(m, skipWhitespace(m, part.start));
      if (!extra) {
        continue;
      }
      const extraIndex = addDeclaration(state, {
        kind: 'property',
        name: extra.name,
        nameOffset: extra.start,
        nameLength: extra.end - extra.start,
        startOffset: part.start,
        modifiers,
        typeText: firstType.text,
      });
      state.decls[extraIndex].signature = `${firstType.text} ${extra.name}`;
      state.decls[extraIndex].endOffset = part.end;
    }
  }
  return { end: stmtEnd, bodyOwner: -1 };
}

function finishMethod(
  state: State,
  start: number,
  modifiers: string[],
  nameTok: IdentToken,
  parenIndex: number,
  returnType: string | undefined,
): DeclResult | undefined {
  const m = state.masked;
  const after = matchBracket(m, parenIndex, '(', ')');
  if (after < 0) {
    return undefined;
  }
  let i = skipWhitespace(m, after);
  const throwsTok = readIdentifier(m, i);
  if (throwsTok?.name === 'throws') {
    i = skipWhitespace(m, readUntil(m, throwsTok.end, new Set(['{', ';'])).end);
  }
  // Annotation element defaults: `String value() default "";`
  const defaultTok = readIdentifier(m, i);
  if (defaultTok?.name === 'default') {
    i = skipWhitespace(m, readUntil(m, defaultTok.end, new Set([';'])).end);
  }

  const index = addDeclaration(state, {
    kind: returnType === undefined ? 'constructor' : 'function',
    name: nameTok.name,
    nameOffset: nameTok.start,
    nameLength: nameTok.end - nameTok.start,
    startOffset: start,
    modifiers,
    typeText: returnType,
  });
  state.decls[index].signature = renderSignature(state.source, start, i);
  state.decls[index].endOffset = i;
  state.decls[index].paramTypes = parseParameters(state, parenIndex + 1, after - 1, index, false);

  if (m[i] === '{') {
    return { end: i, bodyOwner: index };
  }
  return { end: i, bodyOwner: -1 };
}

function parseParameters(state: State, start: number, end: number, ownerIndex: number, asFields: boolean): string[] {
  const m = state.masked;
  const types: string[] = [];
  for (const part of splitTopLevelRanges(m, start, end)) {
    let i = skipWhitespace(m, part.start);
    for (;;) {
      if (m[i] === '@') {
        i = skipWhitespace(m, skipAnnotation(m, i));
        continue;
      }
      const tok = readIdentifier(m, i);
      if (tok && (tok.name === 'final' || JAVA_MODIFIERS.has(tok.name))) {
        i = skipWhitespace(m, tok.end);
        continue;
      }
      break;
    }
    const typeRef = readTypeRef(m, i);
    if (!typeRef) {
      continue;
    }
    i = skipWhitespace(m, typeRef.end);
    if (m[i] === '.' && m[i + 1] === '.' && m[i + 2] === '.') {
      i = skipWhitespace(m, i + 3);
    }
    const nameTok = readIdentifier(m, i);
    if (!nameTok) {
      continue;
    }
    types.push(typeRef.text);
    const index = addDeclaration(
      state,
      {
        kind: asFields ? 'property' : 'parameter',
        name: nameTok.name,
        nameOffset: nameTok.start,
        nameLength: nameTok.end - nameTok.start,
        startOffset: part.start,
        modifiers: [],
        typeText: typeRef.text,
      },
      { forceParent: ownerIndex, forceLocal: !asFields },
    );
    state.decls[index].endOffset = part.end;
    state.decls[index].signature = `${typeRef.text} ${nameTok.name}`;
  }
  return types;
}

interface TypeRef {
  text: string;
  end: number;
  simpleName: string;
  nameToken: IdentToken;
  hasGenericsOrDots: boolean;
}

function readTypeRef(masked: string, i: number): TypeRef | undefined {
  const start = i;
  let j = i;
  let last: IdentToken | undefined;
  let dots = false;
  let generics = false;
  for (let guard = 0; guard < 32; guard++) {
    const tok = readIdentifier(masked, j);
    if (!tok) {
      return undefined;
    }
    last = tok;
    const afterAngles = matchAngles(masked, tok.end);
    if (afterAngles !== tok.end) {
      generics = true;
    }
    j = afterAngles;
    if (masked[j] === '.') {
      dots = true;
      j++;
      continue;
    }
    break;
  }
  if (!last) {
    return undefined;
  }
  let end = j;
  while (masked[end] === '[') {
    const after = matchBracket(masked, end, '[', ']');
    if (after < 0) {
      break;
    }
    end = after;
  }
  return {
    text: masked.substring(start, end).replace(/\s+/g, ''),
    end,
    simpleName: last.name,
    nameToken: last,
    hasGenericsOrDots: dots || generics || end !== j,
  };
}

interface NewDecl {
  kind: DeclKind;
  name: string;
  nameOffset: number;
  nameLength: number;
  startOffset: number;
  modifiers: string[];
  typeText?: string;
}

function addDeclaration(state: State, spec: NewDecl, options: { forceParent?: number; forceLocal?: boolean } = {}): number {
  let parent = options.forceParent ?? -1;
  if (options.forceParent === undefined) {
    for (let k = state.stack.length - 1; k >= 0; k--) {
      if (state.stack[k].declIndex >= 0) {
        parent = state.stack[k].declIndex;
        break;
      }
    }
  }
  const isLocal = options.forceLocal ?? state.stack.some((f) => f.localScope);
  const containerFqName = parent >= 0 ? state.decls[parent].fqName : state.packageName;
  const fqName = containerFqName ? `${containerFqName}.${spec.name}` : spec.name;

  const decl: Declaration = {
    kind: spec.kind,
    name: spec.name,
    fqName,
    containerFqName,
    file: state.file,
    nameOffset: spec.nameOffset,
    nameLength: spec.nameLength,
    startOffset: spec.startOffset,
    endOffset: spec.startOffset,
    signature: '',
    modifiers: spec.modifiers,
    typeText: spec.typeText,
    isLocal,
    parent,
    children: [],
    doc: extractDoc(state.source, spec.startOffset),
  };
  const index = state.decls.length;
  state.decls.push(decl);
  if (parent >= 0) {
    state.decls[parent].children.push(index);
  } else if (!isLocal) {
    state.topLevel.push(index);
  }
  return index;
}

function skipAnnotation(masked: string, i: number): number {
  let j = i + 1;
  const first = readIdentifier(masked, j);
  if (!first) {
    return i + 1;
  }
  j = first.end;
  while (masked[j] === '.') {
    const seg = readIdentifier(masked, j + 1);
    if (!seg) {
      break;
    }
    j = seg.end;
  }
  if (masked[j] === '(') {
    const after = matchBracket(masked, j, '(', ')');
    if (after > 0) {
      j = after;
    }
  }
  return j;
}

function readDottedPath(masked: string, i: number): { text: string; end: number } {
  let j = skipWhitespace(masked, i);
  const parts: string[] = [];
  for (;;) {
    const tok = readIdentifier(masked, j);
    if (!tok) {
      break;
    }
    parts.push(tok.name);
    j = tok.end;
    if (masked[j] === '.') {
      j++;
      continue;
    }
    break;
  }
  return { text: parts.join('.'), end: j };
}

function readImport(masked: string, i: number): ImportEntry | undefined {
  let start = skipWhitespace(masked, i);
  const staticTok = readIdentifier(masked, start);
  if (staticTok?.name === 'static') {
    start = skipWhitespace(masked, staticTok.end);
  }
  let j = start;
  const parts: string[] = [];
  let isStar = false;
  for (;;) {
    if (masked[j] === '*') {
      isStar = true;
      j++;
      break;
    }
    const tok = readIdentifier(masked, j);
    if (!tok) {
      break;
    }
    parts.push(tok.name);
    j = tok.end;
    if (masked[j] === '.') {
      j++;
      continue;
    }
    break;
  }
  if (parts.length === 0) {
    return undefined;
  }
  return { fqName: parts.join('.'), isStar, offset: start, length: j - start };
}

/**
 * Scans forward to one of `stops` at nesting depth zero.
 *
 * Braces are tracked as well, because a field initialiser may contain a whole
 * anonymous class - `Runnable r = new Runnable() { ... };` - and stopping at the
 * first `;` inside it would leave the scanner's brace depth permanently wrong.
 */
function readUntil(masked: string, i: number, stops: Set<string>): { text: string; end: number } {
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let j = i;
  const nested = (): boolean => depthParen > 0 || depthAngle > 0 || depthBracket > 0 || depthBrace > 0;
  while (j < masked.length) {
    const c = masked[j];
    if (c === '(') {
      depthParen++;
    } else if (c === ')') {
      if (depthParen === 0) {
        break;
      }
      depthParen--;
    } else if (c === '[') {
      depthBracket++;
    } else if (c === ']') {
      if (depthBracket === 0) {
        break;
      }
      depthBracket--;
    } else if (c === '<') {
      depthAngle++;
    } else if (c === '>') {
      if (depthAngle > 0) {
        depthAngle--;
      }
    } else if (c === '{') {
      if (!nested() && stops.has('{')) {
        break;
      }
      depthBrace++;
    } else if (c === '}') {
      if (depthBrace === 0) {
        break;
      }
      depthBrace--;
    } else if (!nested() && stops.has(c)) {
      break;
    }
    j++;
  }
  return { text: masked.substring(i, j), end: j };
}

interface Range {
  text: string;
  start: number;
  end: number;
}

function splitTopLevelRanges(masked: string, start: number, end: number): Range[] {
  const out: Range[] = [];
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let last = start;
  for (let k = start; k < end; k++) {
    const c = masked[k];
    if (c === '(') {
      depthParen++;
    } else if (c === ')') {
      depthParen--;
    } else if (c === '[') {
      depthBracket++;
    } else if (c === ']') {
      depthBracket--;
    } else if (c === '{') {
      depthBrace++;
    } else if (c === '}') {
      depthBrace--;
    } else if (c === '<') {
      depthAngle++;
    } else if (c === '>') {
      depthAngle--;
    } else if (c === ',' && !depthParen && !depthAngle && !depthBracket && !depthBrace) {
      out.push({ text: masked.substring(last, k), start: last, end: k });
      last = k + 1;
    }
  }
  if (last < end) {
    out.push({ text: masked.substring(last, end), start: last, end });
  }
  return out.filter((r) => r.text.trim().length > 0);
}

function cleanTypeName(text: string): string | undefined {
  let t = text.trim();
  const angle = t.indexOf('<');
  if (angle >= 0) {
    t = t.substring(0, angle);
  }
  t = t.trim();
  return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(t) ? t : undefined;
}

function renderSignature(source: string, start: number, end: number): string {
  const raw = source.substring(start, Math.max(start, Math.min(end, start + 400)));
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.substring(0, 197)}...` : collapsed;
}

function extractDoc(source: string, start: number): string | undefined {
  let k = start - 1;
  while (k >= 0 && /\s/.test(source[k])) {
    k--;
  }
  if (k < 1 || source[k] !== '/' || source[k - 1] !== '*') {
    return undefined;
  }
  const open = source.lastIndexOf('/**', k);
  if (open < 0) {
    return undefined;
  }
  const body = source.substring(open + 3, k - 1);
  const cleaned = body
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return cleaned.length > 0 ? cleaned.substring(0, 1200) : undefined;
}
