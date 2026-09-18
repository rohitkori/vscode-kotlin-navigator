import {
  Declaration,
  DeclKind,
  ImportEntry,
  ParsedFile,
} from './types';
import {
  collectIdentifiers,
  IdentToken,
  matchAngles,
  matchBracket,
  maskSource,
  readIdentifier,
  skipWhitespace,
} from '../util/text';

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal',
  'open', 'final', 'abstract', 'sealed', 'override',
  'lateinit', 'const', 'inline', 'noinline', 'crossinline', 'reified',
  'vararg', 'suspend', 'tailrec', 'operator', 'infix', 'external',
  'annotation', 'data', 'enum', 'inner', 'companion',
  'expect', 'actual', 'value', 'out', 'in', 'static', 'synchronized',
]);

const DECL_KEYWORDS = new Set(['class', 'interface', 'object', 'fun', 'val', 'var', 'typealias', 'constructor']);

interface Frame {
  /** Index into `decls`, or -1 for a synthetic scope (lambda, `init`, `if` body...). */
  declIndex: number;
  braceDepth: number;
  /** Declarations inside this frame are locals, not members. */
  localScope: boolean;
  /** Enum body that has not yet seen its `;` or first member declaration. */
  enumEntriesOpen: boolean;
  /** Offset of the `{` that opened this frame. */
  braceOffset: number;
  /** Local declarations whose visibility ends when this frame closes. */
  scopedDecls: number[];
}

interface ParseState {
  file: string;
  source: string;
  masked: string;
  kinds: Uint8Array;
  decls: Declaration[];
  topLevel: number[];
  stack: Frame[];
  packageName: string;
  braceDepth: number;
}

export function parseKotlin(file: string, source: string): ParsedFile {
  const { masked, kinds } = maskSource(source, { templates: true, nestedBlockComments: true });
  const state: ParseState = {
    file,
    source,
    masked,
    kinds,
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
          braceOffset: i,
          scopedDecls: [],
        });
        pendingBodyOwner = -1;
        clearPending();
        i++;
        continue;
      }
      // Lambda, `init`, control-flow block, property accessor: anything declared
      // in here is a local, not a member.
      state.stack.push({
        declIndex: -1,
        braceDepth: state.braceDepth,
        localScope: true,
        enumEntriesOpen: false,
        braceOffset: i,
        scopedDecls: [],
      });
      clearPending();
      i = parseLambdaParameters(state, i);
      continue;
    }

    if (c === '}') {
      while (state.stack.length > 0 && state.stack[state.stack.length - 1].braceDepth === state.braceDepth) {
        const frame = state.stack.pop()!;
        if (frame.declIndex >= 0) {
          state.decls[frame.declIndex].endOffset = i + 1;
        }
        for (const scoped of frame.scopedDecls) {
          state.decls[scoped].scopeEnd = i + 1;
        }
      }
      state.braceDepth--;
      clearPending();
      i++;
      continue;
    }

    if (c === '@') {
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

    // `package` / `import` are only meaningful at the very top of the file.
    if (state.braceDepth === 0 && tok.name === 'package' && state.packageName === '') {
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

    if (MODIFIERS.has(tok.name) && isModifierPosition(masked, tok)) {
      if (pendingStart < 0) {
        pendingStart = tok.start;
      }
      pendingModifiers.push(tok.name);
      i = tok.end;
      continue;
    }

    if (DECL_KEYWORDS.has(tok.name)) {
      const top = state.stack[state.stack.length - 1];
      if (top?.enumEntriesOpen && state.braceDepth === top.braceDepth) {
        top.enumEntriesOpen = false;
      }
      const start = pendingStart >= 0 ? pendingStart : tok.start;
      const result = parseDeclaration(state, tok, start, pendingModifiers);
      clearPending();
      if (result) {
        i = result.end;
        pendingBodyOwner = result.bodyOwner;
        continue;
      }
      i = tok.end;
      continue;
    }

    // Enum entries: bare identifiers at the top of an `enum class` body.
    const top = state.stack[state.stack.length - 1];
    if (top?.enumEntriesOpen && state.braceDepth === top.braceDepth) {
      const entry = parseEnumEntry(state, tok, pendingStart >= 0 ? pendingStart : tok.start);
      clearPending();
      if (entry) {
        i = entry.end;
        pendingBodyOwner = entry.bodyOwner;
        continue;
      }
    }

    clearPending();
    i = tok.end;
  }

  // Close anything still open at EOF.
  for (const frame of state.stack) {
    if (frame.declIndex >= 0 && state.decls[frame.declIndex].endOffset <= state.decls[frame.declIndex].startOffset) {
      state.decls[frame.declIndex].endOffset = n;
    }
    for (const scoped of frame.scopedDecls) {
      state.decls[scoped].scopeEnd = n;
    }
  }

  return {
    file,
    language: 'kotlin',
    packageName: state.packageName,
    imports,
    declarations: state.decls,
    topLevel: state.topLevel,
    sourceLength: source.length,
    identifiers: collectIdentifiers(masked),
  };
}

// ---------------------------------------------------------------------------
// Declaration parsing
// ---------------------------------------------------------------------------

interface DeclResult {
  end: number;
  /** Declaration index whose body starts at the next `{`, or -1. */
  bodyOwner: number;
}

/** Longest stretch of source searched for a lambda's `->`. */
const LAMBDA_ARROW_LOOKAHEAD = 600;

/** Cap on how far an expression-bodied declaration is followed. */
const MAX_EXPRESSION_BODY = 20000;
const EXPRESSION_BODY_STOPS = new Set<string>();

/**
 * Indexes the parameters of a lambda that has just been opened at `braceIndex`.
 *
 * `list.forEach { doc -> ... }` binds `doc`, and clicking it should land on the
 * binding. The arrow is only accepted when it appears at the lambda's own
 * nesting level, so the `->` of a nested `when` or lambda is never mistaken
 * for a parameter list.
 */
function parseLambdaParameters(state: ParseState, braceIndex: number): number {
  const m = state.masked;
  const limit = Math.min(m.length, braceIndex + LAMBDA_ARROW_LOOKAHEAD);
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let arrow = -1;

  for (let j = braceIndex + 1; j < limit; j++) {
    const c = m[j];
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
      depthBracket--;
    } else if (c === '<') {
      depthAngle++;
    } else if (c === '>') {
      if (m[j - 1] === '-') {
        if (depthParen === 0 && depthAngle === 0 && depthBracket === 0) {
          arrow = j - 1;
        }
        break;
      }
      if (depthAngle > 0) {
        depthAngle--;
      }
    } else if (c === '{' || c === '}' || c === ';') {
      break;
    }
  }
  if (arrow < 0) {
    return braceIndex + 1;
  }

  for (const part of splitTopLevelRanges(m, braceIndex + 1, arrow)) {
    let start = skipWhitespace(m, part.start);
    // Destructured lambda parameter: `{ (key, value) -> ... }`
    if (m[start] === '(') {
      const after = matchBracket(m, start, '(', ')');
      if (after > 0) {
        for (const inner of splitTopLevelRanges(m, start + 1, after - 1)) {
          addLambdaParameter(state, inner.start, inner.end);
        }
        continue;
      }
    }
    addLambdaParameter(state, start, part.end);
  }
  return arrow + 2;
}

function addLambdaParameter(state: ParseState, start: number, end: number): void {
  const m = state.masked;
  const tok = readIdentifier(m, skipWhitespace(m, start));
  if (!tok || tok.name === '_' || MODIFIERS.has(tok.name)) {
    return;
  }
  let typeText: string | undefined;
  const afterName = skipWhitespace(m, tok.end);
  if (m[afterName] === ':') {
    typeText = m.substring(afterName + 1, end).trim() || undefined;
  }
  const index = addDeclaration(
    state,
    {
      kind: 'parameter',
      name: tok.name,
      nameOffset: tok.start,
      nameLength: tok.end - tok.start,
      startOffset: tok.start,
      modifiers: [],
      typeText,
    },
    { forceLocal: true },
  );
  state.decls[index].endOffset = end;
  state.decls[index].signature = `${tok.name}${typeText ? `: ${typeText}` : ''}`;
}

function parseDeclaration(state: ParseState, keyword: IdentToken, start: number, modifiers: string[]): DeclResult | undefined {
  switch (keyword.name) {
    case 'class':
    case 'interface':
    case 'object':
      return parseClassLike(state, keyword, start, modifiers);
    case 'fun':
      return parseFunction(state, keyword, start, modifiers);
    case 'val':
    case 'var':
      return parseProperty(state, keyword, start, modifiers);
    case 'typealias':
      return parseTypeAlias(state, keyword, start, modifiers);
    case 'constructor':
      return parseSecondaryConstructor(state, keyword, start, modifiers);
    default:
      return undefined;
  }
}

function parseClassLike(state: ParseState, keyword: IdentToken, start: number, modifiers: string[]): DeclResult | undefined {
  const m = state.masked;
  let i = skipWhitespace(m, keyword.end);

  let kind: DeclKind = keyword.name === 'interface' ? 'interface' : keyword.name === 'object' ? 'object' : 'class';
  if (modifiers.includes('enum')) {
    kind = 'enum';
  } else if (modifiers.includes('annotation')) {
    kind = 'annotationClass';
  }

  let nameTok = readIdentifier(m, i);
  const isCompanion = keyword.name === 'object' && modifiers.includes('companion');

  if (keyword.name === 'object' && (m[i] === ':' || m[i] === '{')) {
    if (!isCompanion) {
      // `object : Foo() { ... }` - an anonymous object expression, not a declaration.
      return { end: i, bodyOwner: -1 };
    }
    nameTok = undefined;
  }

  let name: string;
  let nameOffset: number;
  let nameLength: number;
  if (nameTok) {
    name = nameTok.name;
    nameOffset = nameTok.start;
    nameLength = nameTok.end - nameTok.start;
    i = nameTok.end;
  } else if (isCompanion) {
    name = 'Companion';
    nameOffset = keyword.start;
    nameLength = keyword.end - keyword.start;
  } else {
    return undefined;
  }

  i = skipWhitespace(m, i);
  const typeParamsStart = i;
  i = matchAngles(m, i);
  const typeParamsEnd = i;
  i = skipWhitespace(m, i);

  const index = addDeclaration(state, {
    kind,
    name,
    nameOffset,
    nameLength,
    startOffset: start,
    modifiers,
    isCompanion: isCompanion || undefined,
  });
  parseTypeParameters(state, typeParamsStart, typeParamsEnd, index);

  // Primary constructor. It may be preceded by annotations, visibility
  // modifiers and an explicit `constructor` keyword:
  //   class Foo @Inject internal constructor(private val bar: Bar)
  let primaryParamsRange: { start: number; end: number } | undefined;
  for (;;) {
    if (m[i] === '@') {
      i = skipWhitespace(m, skipAnnotation(m, i));
      continue;
    }
    const ahead = readIdentifier(m, i);
    if (ahead && (MODIFIERS.has(ahead.name) || ahead.name === 'constructor')) {
      i = skipWhitespace(m, ahead.end);
      if (ahead.name === 'constructor') {
        break;
      }
      continue;
    }
    break;
  }
  if (m[i] === '(') {
    const after = matchBracket(m, i, '(', ')');
    if (after > 0) {
      primaryParamsRange = { start: i + 1, end: after - 1 };
      i = skipWhitespace(m, after);
    }
  }

  // Supertype list.
  const supertypes: string[] = [];
  if (m[i] === ':') {
    const st = readUntil(m, i + 1, new Set(['{']));
    for (const part of splitTopLevelRanges(m, i + 1, st.end)) {
      const cleaned = cleanSupertype(part.text);
      if (cleaned) {
        supertypes.push(cleaned);
      }
    }
    i = st.end;
  }
  // `where T : Comparable<T>` constraints sit between the supertypes and the body.
  i = skipWhitespace(m, i);
  const whereTok = readIdentifier(m, i);
  if (whereTok?.name === 'where') {
    i = readUntil(m, whereTok.end, new Set(['{'])).end;
  }

  const decl = state.decls[index];
  decl.supertypes = supertypes.length ? supertypes : undefined;
  decl.signature = renderSignature(state.source, start, i);
  decl.endOffset = i;

  if (primaryParamsRange) {
    parseParameters(state, primaryParamsRange.start, primaryParamsRange.end, index, true);
  }

  i = skipWhitespace(m, i);
  if (m[i] === '{') {
    return { end: i, bodyOwner: index };
  }
  return { end: i, bodyOwner: -1 };
}

function parseFunction(state: ParseState, keyword: IdentToken, start: number, modifiers: string[]): DeclResult | undefined {
  const m = state.masked;
  let i = skipWhitespace(m, keyword.end);

  // `fun interface Foo { ... }`
  const peek = readIdentifier(m, i);
  if (peek?.name === 'interface') {
    return parseClassLike(state, peek, start, modifiers);
  }

  const typeParamsStart = i;
  i = matchAngles(m, i);
  const typeParamsEnd = i;
  i = skipWhitespace(m, i);

  const callable = parseCallableName(m, i);
  if (!callable) {
    return undefined;
  }
  i = callable.end;

  i = skipWhitespace(m, i);
  let paramsRange: { start: number; end: number } | undefined;
  if (m[i] === '(') {
    const after = matchBracket(m, i, '(', ')');
    if (after < 0) {
      return undefined;
    }
    paramsRange = { start: i + 1, end: after - 1 };
    i = after;
  }

  i = skipWhitespace(m, i);
  let returnType: string | undefined;
  if (m[i] === ':') {
    const rt = readUntil(m, i + 1, new Set(['{', '=']));
    returnType = rt.text.trim() || undefined;
    i = rt.end;
  }

  i = skipWhitespace(m, i);
  const whereTok = readIdentifier(m, i);
  if (whereTok?.name === 'where') {
    i = readUntil(m, whereTok.end, new Set(['{', '='])).end;
  }

  const index = addDeclaration(state, {
    kind: 'function',
    name: callable.name.name,
    nameOffset: callable.name.start,
    nameLength: callable.name.end - callable.name.start,
    startOffset: start,
    modifiers,
    receiverType: callable.receiver,
    typeText: returnType,
  });
  const decl = state.decls[index];
  decl.signature = renderSignature(state.source, start, i);
  // An expression body is part of the function, and its parameters must stay in
  // scope across it: `fun go(name: String) = "hi $name"`. The scan is bounded -
  // a runaway here costs a linear pass per declaration.
  const afterSignature = skipWhitespace(m, i);
  decl.endOffset =
    m[afterSignature] === '='
      ? readUntil(m, afterSignature + 1, EXPRESSION_BODY_STOPS, Math.min(m.length, afterSignature + MAX_EXPRESSION_BODY)).end
      : i;
  parseTypeParameters(state, typeParamsStart, typeParamsEnd, index);

  if (paramsRange) {
    decl.paramTypes = parseParameters(state, paramsRange.start, paramsRange.end, index, false);
  } else {
    decl.paramTypes = [];
  }

  i = skipWhitespace(m, i);
  if (m[i] === '{') {
    return { end: i, bodyOwner: index };
  }
  return { end: i, bodyOwner: -1 };
}

function parseProperty(state: ParseState, keyword: IdentToken, start: number, modifiers: string[]): DeclResult | undefined {
  const m = state.masked;
  let i = skipWhitespace(m, keyword.end);
  i = matchAngles(m, i);
  i = skipWhitespace(m, i);

  // Destructuring: `val (first, second) = pair`
  if (m[i] === '(') {
    const after = matchBracket(m, i, '(', ')');
    if (after < 0) {
      return undefined;
    }
    for (const part of splitTopLevelRanges(m, i + 1, after - 1)) {
      const tok = readIdentifier(m, skipWhitespace(m, part.start));
      if (tok && tok.name !== '_') {
        const idx = addDeclaration(state, {
          kind: 'property',
          name: tok.name,
          nameOffset: tok.start,
          nameLength: tok.end - tok.start,
          startOffset: tok.start,
          modifiers: [...modifiers, keyword.name],
        });
        state.decls[idx].endOffset = tok.end;
        state.decls[idx].signature = `${keyword.name} ${tok.name}`;
      }
    }
    return { end: after, bodyOwner: -1 };
  }

  const callable = parseCallableName(m, i);
  if (!callable) {
    return undefined;
  }
  i = callable.end;

  i = skipWhitespace(m, i);
  let typeText: string | undefined;
  if (m[i] === ':') {
    const t = readUntil(m, i + 1, new Set(['=', '{']));
    typeText = t.text.trim() || undefined;
    i = t.end;
  }

  const index = addDeclaration(state, {
    kind: 'property',
    name: callable.name.name,
    nameOffset: callable.name.start,
    nameLength: callable.name.end - callable.name.start,
    startOffset: start,
    // `val`/`var` is kept so highlighting can mark immutable bindings readonly.
    modifiers: [...modifiers, keyword.name],
    receiverType: callable.receiver,
    typeText,
  });
  const decl = state.decls[index];
  decl.signature = renderSignature(state.source, start, i);
  decl.endOffset = i;

  // When the type is not written out, keep the initialiser expression so the
  // resolver can evaluate it later - `val binding = FooBinding.inflate(...)`
  // is by far the most common shape in Android code and drives member lookup.
  if (!typeText) {
    decl.initializer = readInitializerChain(m, i);
  }
  return { end: i, bodyOwner: -1 };
}

function parseTypeAlias(state: ParseState, keyword: IdentToken, start: number, modifiers: string[]): DeclResult | undefined {
  const m = state.masked;
  let i = skipWhitespace(m, keyword.end);
  const nameTok = readIdentifier(m, i);
  if (!nameTok) {
    return undefined;
  }
  i = matchAngles(m, skipWhitespace(m, nameTok.end));
  i = skipWhitespace(m, i);
  let typeText: string | undefined;
  if (m[i] === '=') {
    const t = readUntil(m, i + 1, new Set([';']));
    typeText = t.text.trim() || undefined;
    i = t.end;
  }
  const index = addDeclaration(state, {
    kind: 'typealias',
    name: nameTok.name,
    nameOffset: nameTok.start,
    nameLength: nameTok.end - nameTok.start,
    startOffset: start,
    modifiers,
    typeText,
  });
  state.decls[index].signature = renderSignature(state.source, start, i);
  state.decls[index].endOffset = i;
  return { end: i, bodyOwner: -1 };
}

function parseSecondaryConstructor(state: ParseState, keyword: IdentToken, start: number, modifiers: string[]): DeclResult | undefined {
  const m = state.masked;
  let i = skipWhitespace(m, keyword.end);
  if (m[i] !== '(') {
    return undefined;
  }
  const after = matchBracket(m, i, '(', ')');
  if (after < 0) {
    return undefined;
  }
  const paramsRange = { start: i + 1, end: after - 1 };
  i = skipWhitespace(m, after);
  if (m[i] === ':') {
    i = readUntil(m, i + 1, new Set(['{'])).end;
  }
  const owner = currentTypeFrame(state);
  const index = addDeclaration(state, {
    kind: 'constructor',
    name: owner >= 0 ? state.decls[owner].name : 'constructor',
    nameOffset: keyword.start,
    nameLength: keyword.end - keyword.start,
    startOffset: start,
    modifiers,
  });
  state.decls[index].signature = renderSignature(state.source, start, i);
  state.decls[index].endOffset = i;
  state.decls[index].paramTypes = parseParameters(state, paramsRange.start, paramsRange.end, index, false);

  i = skipWhitespace(m, i);
  if (m[i] === '{') {
    return { end: i, bodyOwner: index };
  }
  return { end: i, bodyOwner: -1 };
}

function parseEnumEntry(state: ParseState, tok: IdentToken, start: number): DeclResult | undefined {
  const m = state.masked;
  if (MODIFIERS.has(tok.name) || DECL_KEYWORDS.has(tok.name)) {
    return undefined;
  }
  let i = skipWhitespace(m, tok.end);
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

/**
 * Indexes `<T, R : Comparable<R>>` so the type variables themselves are
 * navigable, the same way IntelliJ lets you jump from a use of `T` to where it
 * was introduced.
 */
function parseTypeParameters(state: ParseState, start: number, end: number, ownerIndex: number): void {
  if (end <= start + 1) {
    return;
  }
  const m = state.masked;
  for (const part of splitTopLevelRanges(m, start + 1, end - 1)) {
    let i = skipWhitespace(m, part.start);
    for (;;) {
      if (m[i] === '@') {
        i = skipWhitespace(m, skipAnnotation(m, i));
        continue;
      }
      const modifier = readIdentifier(m, i);
      if (modifier && (modifier.name === 'out' || modifier.name === 'in' || modifier.name === 'reified')) {
        i = skipWhitespace(m, modifier.end);
        continue;
      }
      break;
    }
    const tok = readIdentifier(m, i);
    if (!tok) {
      continue;
    }
    const index = addDeclaration(
      state,
      {
        kind: 'parameter',
        name: tok.name,
        nameOffset: tok.start,
        nameLength: tok.end - tok.start,
        startOffset: tok.start,
        modifiers: ['typeParameter'],
      },
      { forceParent: ownerIndex, forceLocal: true, noBlockScope: true },
    );
    state.decls[index].endOffset = part.end;
    state.decls[index].signature = `type parameter ${m.substring(part.start, part.end).trim()}`;
  }
}

/**
 * Indexes a parameter list. Primary-constructor parameters written `val`/`var`
 * are real properties of the class, so they are recorded as such; everything
 * else becomes a local parameter that is only visible inside its own file.
 */
function parseParameters(state: ParseState, start: number, end: number, ownerIndex: number, primaryCtor: boolean): string[] {
  const m = state.masked;
  const types: string[] = [];
  for (const part of splitTopLevelRanges(m, start, end)) {
    let i = skipWhitespace(m, part.start);
    const modifiers: string[] = [];
    let isProperty = false;

    // Annotations and modifiers preceding the parameter name.
    for (;;) {
      if (m[i] === '@') {
        i = skipWhitespace(m, skipAnnotation(m, i));
        continue;
      }
      const tok = readIdentifier(m, i);
      if (!tok) {
        break;
      }
      if (tok.name === 'val' || tok.name === 'var') {
        isProperty = true;
        modifiers.push(tok.name);
        i = skipWhitespace(m, tok.end);
        continue;
      }
      if (MODIFIERS.has(tok.name)) {
        modifiers.push(tok.name);
        i = skipWhitespace(m, tok.end);
        continue;
      }
      break;
    }

    const nameTok = readIdentifier(m, i);
    if (!nameTok) {
      continue;
    }
    i = skipWhitespace(m, nameTok.end);
    let typeText: string | undefined;
    if (m[i] === ':') {
      const t = readUntil(m, i + 1, new Set(['=']), part.end);
      typeText = t.text.trim() || undefined;
      i = t.end;
    }
    types.push(typeText ?? '?');

    const index = addDeclaration(
      state,
      {
        kind: isProperty ? 'property' : 'parameter',
        name: nameTok.name,
        nameOffset: nameTok.start,
        nameLength: nameTok.end - nameTok.start,
        startOffset: part.start,
        modifiers,
        typeText,
      },
      { forceParent: ownerIndex, forceLocal: !(isProperty && primaryCtor), noBlockScope: true },
    );
    // A parameter is visible throughout its own declaration, which is the
    // owner's range - not the block the declaration happens to sit in.
    if (!(isProperty && primaryCtor)) {
      state.decls[index].enclosingFunction = ownerIndex;
    }
    state.decls[index].endOffset = part.end;
    state.decls[index].signature = `${isProperty ? 'val ' : ''}${nameTok.name}${typeText ? `: ${typeText}` : ''}`;
  }
  return types;
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

interface NewDecl {
  kind: DeclKind;
  name: string;
  nameOffset: number;
  nameLength: number;
  startOffset: number;
  modifiers: string[];
  typeText?: string;
  receiverType?: string;
  isCompanion?: boolean;
}

function addDeclaration(
  state: ParseState,
  spec: NewDecl,
  options: { forceParent?: number; forceLocal?: boolean; noBlockScope?: boolean } = {},
): number {
  const parent = options.forceParent ?? nearestDeclFrame(state);
  const isLocal = options.forceLocal ?? state.stack.some((f) => f.localScope);

  let containerFqName: string;
  if (parent >= 0) {
    containerFqName = state.decls[parent].fqName;
  } else {
    containerFqName = state.packageName;
  }
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
    receiverType: spec.receiverType,
    isCompanion: spec.isCompanion,
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
  if (isLocal) {
    const fn = nearestFunctionFrame(state);
    if (fn >= 0) {
      decl.enclosingFunction = fn;
    }
    // Kotlin scoping is block based, so a local is visible from its enclosing
    // `{` to the matching `}` - recorded here and closed when the frame pops.
    const frame = options.noBlockScope ? undefined : state.stack[state.stack.length - 1];
    if (frame) {
      decl.scopeStart = frame.braceOffset;
      frame.scopedDecls.push(index);
    }
  }
  return index;
}

/** Nearest enclosing frame that corresponds to a real declaration. */
function nearestDeclFrame(state: ParseState): number {
  for (let k = state.stack.length - 1; k >= 0; k--) {
    if (state.stack[k].declIndex >= 0) {
      return state.stack[k].declIndex;
    }
  }
  return -1;
}

function nearestFunctionFrame(state: ParseState): number {
  for (let k = state.stack.length - 1; k >= 0; k--) {
    const idx = state.stack[k].declIndex;
    if (idx >= 0) {
      const kind = state.decls[idx].kind;
      if (kind === 'function' || kind === 'constructor') {
        return idx;
      }
    }
  }
  return -1;
}

function currentTypeFrame(state: ParseState): number {
  for (let k = state.stack.length - 1; k >= 0; k--) {
    const idx = state.stack[k].declIndex;
    if (idx >= 0) {
      const kind = state.decls[idx].kind;
      if (kind === 'class' || kind === 'object' || kind === 'interface' || kind === 'enum' || kind === 'annotationClass') {
        return idx;
      }
    }
  }
  return -1;
}

/** True when an identifier is a modifier rather than a plain reference. */
function isModifierPosition(masked: string, tok: IdentToken): boolean {
  // `foo.data` or `x.internal` - a qualified reference, not a modifier.
  let k = tok.start - 1;
  while (k >= 0 && (masked[k] === ' ' || masked[k] === '\t')) {
    k--;
  }
  if (k >= 0 && (masked[k] === '.' || masked[k] === '?')) {
    return false;
  }
  // A modifier is always followed by another identifier or an annotation.
  let j = skipWhitespace(masked, tok.end);
  if (masked[j] === '@') {
    return true;
  }
  const next = readIdentifier(masked, j);
  if (!next) {
    return false;
  }
  return MODIFIERS.has(next.name) || DECL_KEYWORDS.has(next.name) || next.name === 'interface';
}

function skipAnnotation(masked: string, i: number): number {
  let j = i + 1;
  // Use-site targets: `@field:Inject`, `@get:JvmName`, `@file:JvmName`.
  const first = readIdentifier(masked, j);
  if (!first) {
    return i + 1;
  }
  j = first.end;
  if (masked[j] === ':') {
    j++;
    const second = readIdentifier(masked, j);
    if (second) {
      j = second.end;
    }
  }
  // Qualified annotation names.
  while (masked[j] === '.') {
    const seg = readIdentifier(masked, j + 1);
    if (!seg) {
      break;
    }
    j = seg.end;
  }
  j = matchAngles(masked, j);
  if (masked[j] === '[') {
    const after = matchBracket(masked, j, '[', ']');
    if (after > 0) {
      j = after;
    }
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
  const start = skipWhitespace(masked, i);
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
  let alias: string | undefined;
  const afterPath = j;
  const asTok = readIdentifier(masked, skipWhitespace(masked, j));
  if (asTok?.name === 'as') {
    const aliasTok = readIdentifier(masked, skipWhitespace(masked, asTok.end));
    if (aliasTok) {
      alias = aliasTok.name;
      j = aliasTok.end;
    }
  }
  return {
    fqName: parts.join('.'),
    alias,
    isStar,
    offset: start,
    length: Math.max(afterPath, j) - start,
  };
}

interface CallableName {
  receiver?: string;
  name: IdentToken;
  end: number;
}

/** Parses `[Receiver<T>.]name`, as written on functions and extension properties. */
function parseCallableName(masked: string, i: number): CallableName | undefined {
  const start = skipWhitespace(masked, i);
  let j = start;
  let lastDot = -1;
  let nameTok: IdentToken | undefined;

  for (let guard = 0; guard < 32; guard++) {
    const tok = readIdentifier(masked, j);
    if (!tok) {
      return undefined;
    }
    j = matchAngles(masked, tok.end);
    if (masked[j] === '?' && masked[j + 1] === '.') {
      j++;
    }
    if (masked[j] === '.') {
      lastDot = j;
      j++;
      continue;
    }
    nameTok = tok;
    break;
  }
  if (!nameTok) {
    return undefined;
  }
  const receiver = lastDot > start ? masked.substring(start, lastDot).trim() : undefined;
  return { receiver: receiver || undefined, name: nameTok, end: nameTok.end };
}

/**
 * Reads forward until one of `stops` is hit at nesting depth zero, or until a
 * line break that cannot be a continuation.
 */
function readUntil(masked: string, i: number, stops: Set<string>, hardEnd?: number): { text: string; end: number } {
  const limit = hardEnd ?? masked.length;
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let j = i;
  while (j < limit) {
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
      if (masked[j - 1] !== '-' && depthAngle > 0) {
        depthAngle--;
      }
    } else if (c === '{' && !stops.has('{') && depthParen === 0 && depthAngle === 0 && depthBracket === 0) {
      // A trailing lambda is part of the expression: an expression body such as
      // `= withContext(IO) { ... }` runs to the matching brace, and the
      // parameters stay in scope across all of it.
      depthBrace++;
    } else if (c === '}' && depthBrace > 0) {
      depthBrace--;
    } else if (depthParen === 0 && depthAngle === 0 && depthBracket === 0 && depthBrace === 0) {
      if (stops.has(c)) {
        break;
      }
      if (c === '\n') {
        // A line break ends the construct unless the line clearly continues.
        const before = lastNonSpace(masked, i, j);
        const after = firstNonSpace(masked, j, limit);
        const continues =
          // Nothing has been consumed yet, so the construct has not started:
          // `fun f(): T =` with the body on the following line.
          before === '' ||
          before === ',' || before === '.' || before === ':' || before === '&' || before === '|' || before === '>' ||
          before === '=' || before === '(' || before === '{' ||
          after === ',' || after === '.' || after === '?' || after === '&' || after === '|';
        if (!continues) {
          break;
        }
      }
    }
    j++;
  }
  return { text: masked.substring(i, j), end: j };
}

function lastNonSpace(masked: string, from: number, to: number): string {
  for (let k = to - 1; k >= from; k--) {
    if (!/\s/.test(masked[k])) {
      return masked[k];
    }
  }
  return '';
}

function firstNonSpace(masked: string, from: number, to: number): string {
  for (let k = from; k < to; k++) {
    if (!/\s/.test(masked[k])) {
      return masked[k];
    }
  }
  return '';
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
      if (masked[k - 1] !== '-') {
        depthAngle--;
      }
    } else if (c === ',' && depthParen === 0 && depthAngle === 0 && depthBracket === 0 && depthBrace === 0) {
      out.push({ text: masked.substring(last, k), start: last, end: k });
      last = k + 1;
    }
  }
  if (last < end) {
    out.push({ text: masked.substring(last, end), start: last, end });
  }
  return out.filter((r) => r.text.trim().length > 0);
}

function cleanSupertype(text: string): string | undefined {
  let t = text.trim();
  if (!t) {
    return undefined;
  }
  // `by delegate` on an interface implementation.
  const byMatch = /\sby\s/.exec(t);
  if (byMatch) {
    t = t.substring(0, byMatch.index);
  }
  const paren = t.indexOf('(');
  if (paren >= 0) {
    t = t.substring(0, paren);
  }
  const angle = t.indexOf('<');
  if (angle >= 0) {
    t = t.substring(0, angle);
  }
  t = t.trim();
  return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(t) ? t : undefined;
}

/**
 * The dotted expression a property is initialised with, if it is a simple
 * chain: `Foo()` -> "Foo()", `FooBinding.inflate(x)` -> "FooBinding.inflate()",
 * `Repository.instance` -> "Repository.instance". Anything more involved is
 * left alone rather than guessed at.
 */
function readInitializerChain(masked: string, i: number): string | undefined {
  let j = skipWhitespace(masked, i);
  // `by lazy { ... }` and other delegates carry no usable type here.
  if (masked[j] !== '=') {
    return undefined;
  }
  j = skipWhitespace(masked, j + 1);
  const parts: string[] = [];
  for (let guard = 0; guard < 16; guard++) {
    const tok = readIdentifier(masked, j);
    if (!tok) {
      break;
    }
    parts.push(tok.name);
    j = matchAngles(masked, tok.end);
    if (masked[j] === '(') {
      const after = matchBracket(masked, j, '(', ')');
      if (after < 0) {
        break;
      }
      const next = skipWhitespace(masked, after);
      if (masked[next] === '.') {
        j = next + 1;
        parts[parts.length - 1] = `${parts[parts.length - 1]}()`;
        continue;
      }
      return `${parts.join('.')}()`;
    }
    if (masked[j] === '.') {
      j++;
      continue;
    }
    break;
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join('.');
}

function renderSignature(source: string, start: number, end: number): string {
  const raw = source.substring(start, Math.max(start, Math.min(end, start + 400)));
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.substring(0, 197)}...` : collapsed;
}

/** KDoc/Javadoc block immediately above the declaration. */
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

