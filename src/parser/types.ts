export type DeclKind =
  | 'class'
  | 'interface'
  | 'object'
  | 'enum'
  | 'enumEntry'
  | 'annotationClass'
  | 'function'
  | 'constructor'
  | 'property'
  | 'parameter'
  | 'typealias'
  | 'package';

/** Kinds that own a member scope (you can write `X.member`). */
export const TYPE_KINDS: ReadonlySet<DeclKind> = new Set<DeclKind>([
  'class',
  'interface',
  'object',
  'enum',
  'annotationClass',
]);

export interface Declaration {
  kind: DeclKind;
  name: string;
  /** Fully qualified name: package + enclosing type names + own name. */
  fqName: string;
  /** FQ name of the owner (package for top-level declarations). */
  containerFqName: string;
  /** Absolute path, or a `jar:<jarPath>!<entry>` pseudo-path for library sources. */
  file: string;
  /** Offset of the declaration's own identifier - where "go to definition" lands. */
  nameOffset: number;
  nameLength: number;
  /** Offsets spanning the whole declaration, used for the peek preview. */
  startOffset: number;
  endOffset: number;
  /** Single-line rendering of the declaration header, used in hovers and pickers. */
  signature: string;
  modifiers: string[];
  /** Declared type for properties/parameters, return type for functions. */
  typeText?: string;
  /**
   * Dotted initialiser expression for a property with no written type, with a
   * trailing `()` when the last step was a call - `FooBinding.inflate()`.
   * The resolver evaluates it to work out the property's type.
   */
  initializer?: string;
  /** Receiver type of an extension declaration. */
  receiverType?: string;
  /** Base classes and interfaces, by simple or qualified name as written. */
  supertypes?: string[];
  /** Parameter type names, used to disambiguate overloads. */
  paramTypes?: string[];
  /** True for declarations inside a function body - only visible within their own file. */
  isLocal: boolean;
  /** True when the declaration is `companion object`. */
  isCompanion?: boolean;
  /** Index of the parent declaration in the file's flat declaration list, or -1. */
  parent: number;
  /** Indices of nested declarations in the file's flat declaration list. */
  children: number[];
  /** Enclosing function's flat index, when this is a local declaration. */
  enclosingFunction?: number;
  /** Block the declaration is visible in; set for locals and lambda parameters. */
  scopeStart?: number;
  scopeEnd?: number;
  /** Doc comment immediately preceding the declaration, if any. */
  doc?: string;
}

export interface ImportEntry {
  /** Fully qualified name as written, without a trailing `.*`. */
  fqName: string;
  alias?: string;
  isStar: boolean;
  offset: number;
  length: number;
}

export interface ParsedFile {
  file: string;
  language: 'kotlin' | 'java';
  packageName: string;
  imports: ImportEntry[];
  /** All declarations in the file, in source order; `parent`/`children` index into this. */
  declarations: Declaration[];
  /** Indices of top-level declarations. */
  topLevel: number[];
  /** Length of the source that produced this parse, used as a cheap change check. */
  sourceLength: number;
  /** Distinct identifiers occurring anywhere in the file's code. */
  identifiers: string[];
}

export function simpleName(fqName: string): string {
  const idx = fqName.lastIndexOf('.');
  return idx < 0 ? fqName : fqName.substring(idx + 1);
}

export function parentFqName(fqName: string): string {
  const idx = fqName.lastIndexOf('.');
  return idx < 0 ? '' : fqName.substring(0, idx);
}

/** Strips generics, nullability and array suffixes to leave a bare type name. */
export function baseTypeName(typeText: string | undefined): string | undefined {
  if (!typeText) {
    return undefined;
  }
  let t = typeText.trim();
  if (!t) {
    return undefined;
  }
  // `out T`, `in T`, `vararg T`
  t = t.replace(/^(out|in|vararg)\s+/, '');
  // Function types have no navigable name of their own.
  if (t.startsWith('(') || t.includes('->')) {
    return undefined;
  }
  const angle = t.indexOf('<');
  if (angle >= 0) {
    t = t.substring(0, angle);
  }
  t = t.replace(/[?!]+$/, '');
  t = t.replace(/(\[\])+$/, '');
  t = t.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(t)) {
    return undefined;
  }
  return t;
}
