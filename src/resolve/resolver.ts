import { IndexService } from '../index/indexService';
import { ORIGIN_RANK } from '../index/symbolIndex';
import { baseTypeName, Declaration, ParsedFile, TYPE_KINDS } from '../parser/types';
import { identifierEndingAt, skipWhitespaceBackwards } from '../util/text';
import { trace } from '../util/log';
import { RefSegment, ReferenceChain, referenceAt } from './reference';

/** Packages Kotlin imports into every file implicitly. */
const DEFAULT_IMPORTS = [
  'kotlin',
  'kotlin.annotation',
  'kotlin.collections',
  'kotlin.comparisons',
  'kotlin.io',
  'kotlin.ranges',
  'kotlin.sequences',
  'kotlin.text',
  'kotlin.jvm',
  'java.lang',
];

export interface Candidate {
  decl: Declaration;
  score: number;
  reason: string;
}

export interface ResolveInput {
  /** The file the cursor is in - an absolute path, or a library source key. */
  file: string;
  raw: string;
  masked: string;
  kinds: Uint8Array;
  parsed: ParsedFile;
  offset: number;
}

interface Scored {
  decls: readonly Declaration[];
  score: number;
  reason: string;
}

/** One lazily evaluated lookup strategy in `resolveHead`. */
interface Branch {
  /** Highest score this branch can produce, used to decide when to stop. */
  max: number;
  run: () => Scored[];
}

/**
 * Most that origin and kind can add to a branch's base score in `rank`.
 * A branch whose ceiling is more than this below the best hit cannot win, so
 * it never has to run.
 */
const MAX_RANK_BONUS = 4;

export class Resolver {
  constructor(private readonly index: IndexService) {}

  /**
   * Resolves the reference under the cursor to zero or more declarations,
   * best first.
   */
  resolve(input: ResolveInput): Candidate[] {
    const chain = referenceAt(input.masked, input.kinds, input.raw, input.offset);
    if (!chain) {
      return [];
    }
    return this.resolveChain(input, chain);
  }

  /** Resolves a reference whose chain has already been extracted. */
  resolveChain(input: ResolveInput, chain: ReferenceChain): Candidate[] {
    trace(
      `reference ${chain.kind} [${chain.segments.map((s) => s.name).join('.')}] target=${chain.segments[chain.targetIndex]?.name}`,
    );

    const candidates =
      chain.kind === 'import' || chain.kind === 'package'
        ? this.resolveImport(chain)
        : chain.kind === 'namedArgument'
          ? this.resolveNamedArgument(chain, input)
          : this.resolveExpression(chain, input);

    return this.rank(candidates);
  }

  /** The reference the cursor is on, without resolving it. */
  referenceAtCursor(input: ResolveInput): ReferenceChain | undefined {
    return referenceAt(input.masked, input.kinds, input.raw, input.offset);
  }

  /**
   * The type(s) of the qualifier in front of the cursor.
   *
   * Used by the Android layer to notice that `binding.someView` has a
   * `*Binding` receiver and should therefore jump to the layout XML rather than
   * to a generated Java field.
   */
  receiverTypesAt(input: ResolveInput, chain: ReferenceChain): Declaration[] {
    if (chain.targetIndex < 1) {
      return [];
    }
    const receivers = this.resolveQualifier(chain.segments, chain.targetIndex - 1, input);
    const types: Declaration[] = [];
    for (const receiver of receivers.slice(0, 4)) {
      types.push(...this.typeOf(receiver, 0));
    }
    return types;
  }

  // -------------------------------------------------------------------------
  // Entry points per reference kind
  // -------------------------------------------------------------------------

  private resolveImport(chain: ReferenceChain): Scored[] {
    const prefix = chain.segments
      .slice(0, chain.targetIndex + 1)
      .map((s) => s.name)
      .join('.');
    const hits = this.index.findByFq(prefix);
    if (hits.length > 0) {
      return [{ decls: hits, score: 100, reason: 'import path' }];
    }
    // A package segment: offer the package's own declarations so the jump is
    // still useful rather than doing nothing.
    const members = this.index.symbols.topLevelInPackage(prefix);
    if (members.length > 0) {
      return [{ decls: [...members].slice(0, 1), score: 20, reason: 'package' }];
    }
    return [];
  }

  private resolveNamedArgument(chain: ReferenceChain, input: ResolveInput): Scored[] {
    const target = chain.segments[chain.targetIndex];
    const open = enclosingCallParen(input.masked, target.start);
    if (open < 0) {
      return this.resolveExpression(chain, input);
    }
    const calleeEnd = skipWhitespaceBackwards(input.masked, open);
    const callee = identifierEndingAt(input.masked, calleeEnd);
    if (!callee) {
      return this.resolveExpression(chain, input);
    }
    const calleeChain = referenceAt(input.masked, input.kinds, input.raw, callee.start);
    if (!calleeChain) {
      return this.resolveExpression(chain, input);
    }
    const functions = this.rank(this.resolveExpression(calleeChain, input)).map((c) => c.decl);
    const params: Declaration[] = [];
    for (const fn of functions) {
      const parsed = this.index.ensureDeclarationFile(fn) ?? this.index.getParsed(fn.file);
      if (!parsed) {
        continue;
      }
      const fnIndex = parsed.declarations.indexOf(fn);
      const owners = fnIndex >= 0 ? [fn] : [];
      for (const owner of owners) {
        const ownerIndex = parsed.declarations.indexOf(owner);
        for (const childIndex of parsed.declarations[ownerIndex].children) {
          const child = parsed.declarations[childIndex];
          if (child.name === target.name && (child.kind === 'parameter' || child.kind === 'property')) {
            params.push(child);
          }
        }
      }
      // A constructor call: look at the class's primary-constructor properties.
      if (TYPE_KINDS.has(fn.kind)) {
        for (const member of this.index.membersOf(fn.fqName)) {
          if (member.name === target.name) {
            params.push(member);
          }
        }
      }
    }
    if (params.length > 0) {
      return [{ decls: params, score: 95, reason: 'named argument' }];
    }
    return this.resolveExpression(chain, input);
  }

  private resolveExpression(chain: ReferenceChain, input: ResolveInput): Scored[] {
    const target = chain.segments[chain.targetIndex];
    if (!target) {
      return [];
    }

    if (chain.targetIndex === 0) {
      return this.resolveHead(target, input);
    }

    // A fully-qualified reference written out in full.
    const fq = chain.segments
      .slice(0, chain.targetIndex + 1)
      .map((s) => s.name)
      .join('.');
    if (chain.targetIndex >= 1) {
      const direct = this.index.findByFq(fq);
      if (direct.length > 0) {
        return [{ decls: direct, score: 98, reason: 'fully qualified name' }];
      }
    }

    const receivers = this.resolveQualifier(chain.segments, chain.targetIndex - 1, input);
    if (receivers.length > 0) {
      const members = this.memberStep(receivers, target, input);
      if (members.length > 0) {
        return [{ decls: members, score: 90, reason: 'member of receiver' }];
      }
    }

    // The receiver could not be typed. An extension function the file imports is
    // the best remaining guess - `x.let { }` and `items.joinToString()` land
    // here whenever the receiver's own type could not be worked out.
    const extensions = this.resolveNameInFile(target.name, input.parsed).filter((d) => d.receiverType);
    if (extensions.length > 0) {
      return [{ decls: extensions, score: 34, reason: 'imported extension (receiver unknown)' }];
    }

    // Otherwise fall back to any member with this name - still far better than
    // doing nothing, and usually a single hit.
    const fallback = this.index
      .findBySimple(target.name)
      .filter((d) => d.kind !== 'parameter' && d.containerFqName.length > 0);
    if (fallback.length > 0) {
      return [{ decls: fallback, score: 30, reason: 'member by name (receiver unknown)' }];
    }
    const libraryFallback = this.index.findLibraryBySimple(target.name, 8);
    if (libraryFallback.length > 0) {
      return [{ decls: libraryFallback, score: 20, reason: 'library symbol by name' }];
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Scope walking
  // -------------------------------------------------------------------------

  private resolveHead(segment: RefSegment, input: ResolveInput): Scored[] {
    const { parsed, offset } = input;
    const name = segment.name;
    const out: Scored[] = [];

    if (name === 'this' || name === 'super') {
      const enclosing = this.enclosingTypes(parsed, offset);
      if (enclosing.length === 0) {
        const receivers = this.enclosingReceiverTypes(parsed, offset);
        return receivers.length > 0 ? [{ decls: [receivers[0]], score: 100, reason: 'extension receiver' }] : [];
      }
      if (name === 'this') {
        const receivers = this.enclosingReceiverTypes(parsed, offset);
        if (receivers.length > 0) {
          return [{ decls: [receivers[0]], score: 100, reason: 'extension receiver' }];
        }
        return [{ decls: [enclosing[0]], score: 100, reason: 'this' }];
      }
      const supertypes = enclosing[0].supertypes ?? [];
      const decls = supertypes.flatMap((st) => this.resolveTypeName(st, parsed));
      return decls.length > 0 ? [{ decls, score: 100, reason: 'super' }] : [];
    }

    // `it` is the implicit lambda parameter, which is not modelled. Letting it
    // fall through to a global name match would point at some unrelated symbol
    // that merely shares the name.
    if (name === 'it') {
      const locals = this.localsInScope(parsed, offset, name);
      return locals.length > 0 ? [{ decls: locals, score: 100, reason: 'local declaration' }] : [];
    }

    // The branches below are in descending order of confidence. Evaluating one
    // can mean parsing library sources, so each is a thunk and the loop stops
    // as soon as no remaining branch could beat what has already been found.
    const branches: Branch[] = [
      {
        max: 100,
        run: () => {
          const locals = this.localsInScope(parsed, offset, name);
          return locals.length > 0 ? [{ decls: locals, score: 100, reason: 'local declaration' }] : [];
        },
      },
      {
        // The receiver of an enclosing extension declaration. Inside
        // `fun Fragment.show() { requireActivity() }` the unqualified call is a
        // member of Fragment, which no lexical scope walk would ever find.
        max: 96,
        run: () => {
          for (const receiverType of this.enclosingReceiverTypes(parsed, offset)) {
            const members = this.membersOfType(receiverType, name, new Set(), 0);
            if (members.length > 0) {
              return [{ decls: members, score: 96, reason: 'member of extension receiver' }];
            }
          }
          return [];
        },
      },
      {
        max: 95,
        run: () => {
          const enclosingTypes = this.enclosingTypes(parsed, offset);
          for (let i = 0; i < enclosingTypes.length; i++) {
            const members = this.membersOfType(enclosingTypes[i], name, new Set(), 0);
            if (members.length > 0) {
              return [{ decls: members, score: 95 - i, reason: 'member of enclosing class' }];
            }
          }
          return [];
        },
      },
      {
        max: 92,
        run: () => {
          const sameFile = parsed.topLevel.map((i) => parsed.declarations[i]).filter((d) => d.name === name);
          return sameFile.length > 0 ? [{ decls: sameFile, score: 92, reason: 'top level in this file' }] : [];
        },
      },
      { max: 91, run: () => this.resolveViaImports(name, parsed) },
      { max: 85, run: () => this.resolveInSamePackage(name, parsed) },
      {
        max: 80,
        run: () => {
          const results: Scored[] = [];
          for (const entry of parsed.imports) {
            if (!entry.isStar) {
              continue;
            }
            const decls = this.index.findByFq(`${entry.fqName}.${name}`);
            if (decls.length > 0) {
              results.push({ decls, score: 80, reason: `import ${entry.fqName}.*` });
            }
          }
          return results;
        },
      },
      {
        max: 60,
        run: () => {
          const results: Scored[] = [];
          for (const pkg of DEFAULT_IMPORTS) {
            const decls = this.index.findByFq(`${pkg}.${name}`);
            if (decls.length > 0) {
              results.push({ decls, score: 60, reason: `default import ${pkg}` });
            }
          }
          return results;
        },
      },
      {
        max: 45,
        run: () => {
          const global = this.index.findBySimple(name).filter((d) => !d.isLocal);
          return global.length > 0 ? [{ decls: global, score: 45, reason: 'name match in workspace' }] : [];
        },
      },
      {
        max: 35,
        run: () => {
          const lib = this.index.findLibraryBySimple(name, 8);
          return lib.length > 0 ? [{ decls: lib, score: 35, reason: 'name match in libraries' }] : [];
        },
      },
    ];

    let best = Number.NEGATIVE_INFINITY;
    for (const branch of branches) {
      if (best >= branch.max + MAX_RANK_BONUS) {
        break;
      }
      const results = branch.run();
      for (const result of results) {
        out.push(result);
        best = Math.max(best, result.score);
      }
    }
    return out;
  }

  /** Explicit (non-star) imports, aliases first. */
  private resolveViaImports(name: string, parsed: ParsedFile): Scored[] {
    const out: Scored[] = [];
    for (const entry of parsed.imports) {
      if (entry.isStar) {
        continue;
      }
      const importedSimple = entry.fqName.substring(entry.fqName.lastIndexOf('.') + 1);
      if (entry.alias === name) {
        const decls = this.index.findByFq(entry.fqName);
        if (decls.length > 0) {
          out.push({ decls, score: 91, reason: `import alias ${entry.fqName}` });
        }
        continue;
      }
      if (entry.alias || importedSimple !== name) {
        continue;
      }
      const decls = this.index.findByFq(entry.fqName);
      if (decls.length > 0) {
        out.push({ decls, score: 90, reason: `import ${entry.fqName}` });
        continue;
      }
      // Imported but not indexed under that name: the import is still the
      // strongest signal we have about which file the name lives in.
      const lib = this.index.libraries.lookupFq(entry.fqName);
      if (lib) {
        const parsedLib = this.index.ensureLibraryParsed(lib);
        const match = parsedLib?.declarations.filter((d) => !d.isLocal && d.name === name) ?? [];
        if (match.length > 0) {
          out.push({ decls: match, score: 88, reason: `import ${entry.fqName}` });
        }
      }
    }
    return out;
  }

  private resolveInSamePackage(name: string, parsed: ParsedFile): Scored[] {
    if (!parsed.packageName) {
      return [];
    }
    const samePackage = this.index.symbols
      .topLevelInPackage(parsed.packageName)
      .filter((d) => d.name === name && d.file !== parsed.file);
    if (samePackage.length > 0) {
      return [{ decls: [...samePackage], score: 85, reason: 'same package' }];
    }
    if (this.index.libraries.lookupInPackage(parsed.packageName, name)) {
      const decls = this.index.findByFq(`${parsed.packageName}.${name}`);
      if (decls.length > 0) {
        return [{ decls, score: 84, reason: 'same package' }];
      }
    }
    return [];
  }

  /** Resolves `segments[0..upTo]`, returning the declarations the chain denotes. */
  private resolveQualifier(segments: RefSegment[], upTo: number, input: ResolveInput): Declaration[] {
    // Longest fully-qualified prefix wins, which is what makes
    // `com.example.Constants.FOO` work without any import.
    for (let k = upTo; k >= 1; k--) {
      const fq = segments
        .slice(0, k + 1)
        .map((s) => s.name)
        .join('.');
      const found = this.index.findByFq(fq);
      if (found.length > 0) {
        let current = found;
        for (let m = k + 1; m <= upTo; m++) {
          current = this.memberStep(current, segments[m], input);
        }
        return current;
      }
    }

    let current = this.rank(this.resolveHead(segments[0], input)).map((c) => c.decl);
    for (let m = 1; m <= upTo; m++) {
      current = this.memberStep(current, segments[m], input);
      if (current.length === 0) {
        return [];
      }
    }
    return current;
  }

  /** One `.name` step: members of the receiver's type, plus extensions on it. */
  private memberStep(receivers: Declaration[], segment: RefSegment, input: ResolveInput): Declaration[] {
    const out: Declaration[] = [];
    const seen = new Set<string>();
    for (const receiver of receivers.slice(0, 6)) {
      for (const type of this.typeOf(receiver, 0)) {
        for (const member of this.membersOfType(type, segment.name, new Set(), 0)) {
          pushUnique(out, seen, member);
        }
        for (const ext of this.extensionsOn(type, segment.name, input.parsed)) {
          pushUnique(out, seen, ext);
        }
      }
    }
    if (out.length > 0) {
      return out;
    }
    // Generic extensions - `let`, `also`, `joinToString` and friends declare
    // their receiver as a type parameter, so they can never be matched by
    // receiver name. Fall back to whatever the file's imports make visible.
    for (const decl of this.resolveNameInFile(segment.name, input.parsed)) {
      if (decl.receiverType) {
        pushUnique(out, seen, decl);
      }
    }
    return out;
  }

  /**
   * Members named `name` on `type`, following companion objects and
   * supertypes.
   */
  private membersOfType(type: Declaration, name: string, visited: Set<string>, depth: number): Declaration[] {
    if (depth > 6 || visited.has(type.fqName)) {
      return [];
    }
    visited.add(type.fqName);
    this.index.ensureDeclarationFile(type);

    const direct = this.index.membersOf(type.fqName).filter((d) => d.name === name);
    if (direct.length > 0) {
      return direct;
    }

    // Kotlin sees a Java getter as a property: `fragment.viewLifecycleOwner`
    // is really `getViewLifecycleOwner()`, and nothing else will find it.
    const accessors = accessorNames(name);
    if (accessors.length > 0) {
      const viaAccessor = this.index
        .membersOf(type.fqName)
        .filter((d) => d.kind === 'function' && accessors.includes(d.name));
      if (viaAccessor.length > 0) {
        return viaAccessor;
      }
    }

    // Companion members are reachable straight off the class.
    for (const companion of this.index.symbols.companionsOf(type.fqName)) {
      const inCompanion = this.index.membersOf(companion.fqName).filter((d) => d.name === name);
      if (inCompanion.length > 0) {
        return inCompanion;
      }
    }

    const parsed = this.index.getParsed(type.file);
    for (const supertype of type.supertypes ?? []) {
      const resolved = parsed ? this.resolveTypeName(supertype, parsed) : this.index.findByFq(supertype);
      for (const superDecl of resolved.slice(0, 3)) {
        const inherited = this.membersOfType(superDecl, name, visited, depth + 1);
        if (inherited.length > 0) {
          return inherited;
        }
      }
    }
    return [];
  }

  /** Extension functions and properties declared on `type`. */
  private extensionsOn(type: Declaration, name: string, from: ParsedFile): Declaration[] {
    const matches: Declaration[] = [];
    for (const decl of this.index.findBySimple(name)) {
      if (!decl.receiverType) {
        continue;
      }
      const receiver = baseTypeName(decl.receiverType);
      if (!receiver) {
        continue;
      }
      const simple = receiver.substring(receiver.lastIndexOf('.') + 1);
      if (simple === type.name) {
        matches.push(decl);
        continue;
      }
      // An extension on a supertype still applies.
      for (const supertype of type.supertypes ?? []) {
        if (supertype.substring(supertype.lastIndexOf('.') + 1) === simple) {
          matches.push(decl);
          break;
        }
      }
    }
    if (matches.length <= 1) {
      return matches;
    }
    // Prefer extensions that this file actually imports or shares a package with.
    const imported = matches.filter(
      (d) =>
        d.containerFqName === from.packageName ||
        from.imports.some((imp) => imp.fqName === d.fqName || (imp.isStar && imp.fqName === d.containerFqName)),
    );
    return imported.length > 0 ? imported : matches;
  }

  /** The type(s) a declaration denotes when used as a receiver. */
  private typeOf(decl: Declaration, depth: number): Declaration[] {
    if (depth > 5) {
      return [];
    }
    if (TYPE_KINDS.has(decl.kind)) {
      return [decl];
    }
    if (decl.kind === 'enumEntry') {
      const owner = this.index.findByFq(decl.containerFqName).filter((d) => TYPE_KINDS.has(d.kind));
      return owner;
    }
    const parsed = this.index.ensureDeclarationFile(decl) ?? this.index.getParsed(decl.file);

    if (decl.typeText) {
      const base = baseTypeName(decl.typeText);
      if (base) {
        const resolved = parsed ? this.resolveTypeName(base, parsed) : this.index.findByFq(base);
        if (resolved.length > 0) {
          return resolved.flatMap((r) => (r.kind === 'typealias' ? this.typeOf(r, depth + 1) : [r]));
        }
      }
      return [];
    }
    if (decl.kind === 'typealias') {
      return [];
    }
    if (decl.initializer && parsed) {
      return this.typeOfExpression(decl.initializer, parsed, depth + 1);
    }
    return [];
  }

  /** Evaluates a stored initialiser chain such as `FooBinding.inflate()`. */
  private typeOfExpression(expression: string, parsed: ParsedFile, depth: number): Declaration[] {
    if (depth > 5) {
      return [];
    }
    const parts = expression.split('.');
    let current: Declaration[] = [];
    for (let i = 0; i < parts.length; i++) {
      const isCall = parts[i].endsWith('()');
      const name = isCall ? parts[i].slice(0, -2) : parts[i];
      if (i === 0) {
        current = this.resolveTypeName(name, parsed);
        if (current.length === 0) {
          current = this.resolveNameInFile(name, parsed);
        }
      } else {
        const next: Declaration[] = [];
        for (const owner of current.slice(0, 4)) {
          for (const type of this.typeOf(owner, depth + 1)) {
            next.push(...this.membersOfType(type, name, new Set(), 0));
          }
        }
        current = next;
      }
      if (current.length === 0) {
        return [];
      }
      if (isCall) {
        const resolved: Declaration[] = [];
        for (const decl of current.slice(0, 4)) {
          if (TYPE_KINDS.has(decl.kind)) {
            resolved.push(decl); // constructor call
          } else if (decl.kind === 'function' && decl.typeText) {
            const base = baseTypeName(decl.typeText);
            const declParsed = this.index.getParsed(decl.file) ?? parsed;
            if (base) {
              resolved.push(...this.resolveTypeName(base, declParsed));
            }
          }
        }
        current = resolved;
        if (current.length === 0) {
          return [];
        }
      }
    }
    return current.flatMap((d) => this.typeOf(d, depth + 1));
  }

  /** Resolves a written type name (possibly dotted) in a file's import context. */
  resolveTypeName(typeName: string, parsed: ParsedFile): Declaration[] {
    const parts = typeName.split('.');
    if (parts.length > 1) {
      const direct = this.index.findByFq(typeName);
      if (direct.length > 0) {
        return direct.filter((d) => TYPE_KINDS.has(d.kind) || d.kind === 'typealias');
      }
    }
    let current = this.resolveNameInFile(parts[0], parsed).filter(
      (d) => TYPE_KINDS.has(d.kind) || d.kind === 'typealias' || d.kind === 'object',
    );
    for (let i = 1; i < parts.length && current.length > 0; i++) {
      const next: Declaration[] = [];
      for (const owner of current.slice(0, 4)) {
        next.push(...this.membersOfType(owner, parts[i], new Set(), 0).filter((d) => TYPE_KINDS.has(d.kind)));
      }
      current = next;
    }
    return current;
  }

  /** Name lookup using only a file's package and imports - no cursor scope. */
  private resolveNameInFile(name: string, parsed: ParsedFile): Declaration[] {
    const fromFile = parsed.topLevel.map((i) => parsed.declarations[i]).filter((d) => d.name === name);
    if (fromFile.length > 0) {
      return fromFile;
    }
    for (const entry of parsed.imports) {
      if (entry.isStar) {
        continue;
      }
      const simple = entry.alias ?? entry.fqName.substring(entry.fqName.lastIndexOf('.') + 1);
      if (simple === name) {
        const decls = this.index.findByFq(entry.fqName);
        if (decls.length > 0) {
          return decls;
        }
      }
    }
    if (parsed.packageName) {
      const samePackage = this.index.findByFq(`${parsed.packageName}.${name}`);
      if (samePackage.length > 0) {
        return samePackage;
      }
    }
    for (const entry of parsed.imports) {
      if (!entry.isStar) {
        continue;
      }
      const decls = this.index.findByFq(`${entry.fqName}.${name}`);
      if (decls.length > 0) {
        return decls;
      }
    }
    for (const pkg of DEFAULT_IMPORTS) {
      const decls = this.index.findByFq(`${pkg}.${name}`);
      if (decls.length > 0) {
        return decls;
      }
    }
    const global = this.index.findBySimple(name).filter((d) => !d.isLocal);
    if (global.length > 0) {
      return global;
    }
    return this.index.findLibraryBySimple(name, 4);
  }

  private rank(groups: Scored[]): Candidate[] {
    const seen = new Map<string, Candidate>();
    for (const group of groups) {
      for (const decl of group.decls) {
        const key = `${decl.file}:${decl.nameOffset}`;
        const score = group.score + ORIGIN_RANK[this.index.symbols.originOf(decl.file)] + kindBonus(decl);
        const existing = seen.get(key);
        if (!existing || existing.score < score) {
          seen.set(key, { decl, score, reason: group.reason });
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Receiver types of the extension declarations whose body contains the
   * cursor, innermost first.
   */
  private receiverTypesCache?: { parsed: ParsedFile; offset: number; result: Declaration[] };

  private enclosingReceiverTypes(parsed: ParsedFile, offset: number): Declaration[] {
    const cached = this.receiverTypesCache;
    if (cached && cached.parsed === parsed && cached.offset === offset) {
      return cached.result;
    }
    const owners = parsed.declarations
      .filter(
        (d) =>
          d.receiverType !== undefined &&
          (d.kind === 'function' || d.kind === 'property') &&
          d.startOffset <= offset &&
          offset <= d.endOffset,
      )
      .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset));
    const out: Declaration[] = [];
    for (const owner of owners) {
      const base = baseTypeName(owner.receiverType);
      if (base) {
        out.push(...this.resolveTypeName(base, parsed));
      }
    }
    this.receiverTypesCache = { parsed, offset, result: out };
    return out;
  }

  /**
   * Types whose body contains the cursor, innermost first.
   *
   * Memoised on the last (file, offset) pair: a single Ctrl-click asks for this
   * several times, and scanning every declaration in a 3,000-line file each
   * time is measurable.
   */
  private enclosingTypesCache?: { parsed: ParsedFile; offset: number; result: Declaration[] };

  private enclosingTypes(parsed: ParsedFile, offset: number): Declaration[] {
    const cached = this.enclosingTypesCache;
    if (cached && cached.parsed === parsed && cached.offset === offset) {
      return cached.result;
    }
    const result = parsed.declarations
      .filter((d) => TYPE_KINDS.has(d.kind) && d.startOffset <= offset && offset <= d.endOffset)
      .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset));
    this.enclosingTypesCache = { parsed, offset, result };
    return result;
  }

  /**
   * Locals and parameters visible at `offset`, nearest declaration first.
   * A local only counts when the cursor is inside the function that owns it.
   */
  private localsInScope(parsed: ParsedFile, offset: number, name: string): Declaration[] {
    const matches: Declaration[] = [];
    for (const decl of parsed.declarations) {
      if (decl.name !== name) {
        continue;
      }
      if (decl.kind !== 'parameter' && !decl.isLocal) {
        continue;
      }
      // Locals and lambda parameters carry the block they were bound in.
      if (decl.scopeStart !== undefined) {
        const scopeEnd = decl.scopeEnd ?? parsed.declarations.length;
        if (offset < decl.scopeStart || offset > scopeEnd) {
          continue;
        }
        matches.push(decl);
        continue;
      }
      const owner = decl.enclosingFunction !== undefined ? parsed.declarations[decl.enclosingFunction] : undefined;
      const scope = owner ?? (decl.parent >= 0 ? parsed.declarations[decl.parent] : undefined);
      if (!scope) {
        continue;
      }
      if (offset < scope.startOffset || offset > scope.endOffset) {
        continue;
      }
      matches.push(decl);
    }
    // The declaration closest above the cursor shadows the others.
    matches.sort((a, b) => {
      const aBefore = a.nameOffset <= offset;
      const bBefore = b.nameOffset <= offset;
      if (aBefore !== bBefore) {
        return aBefore ? -1 : 1;
      }
      // Innermost block wins: a lambda parameter shadows an outer local.
      const aScope = (a.scopeEnd ?? Number.MAX_SAFE_INTEGER) - (a.scopeStart ?? 0);
      const bScope = (b.scopeEnd ?? Number.MAX_SAFE_INTEGER) - (b.scopeStart ?? 0);
      if (aScope !== bScope) {
        return aScope - bScope;
      }
      return Math.abs(offset - a.nameOffset) - Math.abs(offset - b.nameOffset);
    });
    // Kotlin shadowing is unambiguous: only the innermost binding is visible,
    // so returning several would just produce a spurious picker.
    return matches.slice(0, 1);
  }
}

// ---------------------------------------------------------------------------

/** Java accessor spellings of a Kotlin-style property name. */
function accessorNames(name: string): string[] {
  if (name.length === 0 || name.startsWith('get') || name.startsWith('set') || name.startsWith('is')) {
    return [];
  }
  const capitalized = name[0].toUpperCase() + name.substring(1);
  return [`get${capitalized}`, `is${capitalized}`, `set${capitalized}`];
}

function pushUnique(out: Declaration[], seen: Set<string>, decl: Declaration): void {
  const key = `${decl.file}:${decl.nameOffset}`;
  if (!seen.has(key)) {
    seen.add(key);
    out.push(decl);
  }
}

function kindBonus(decl: Declaration): number {
  switch (decl.kind) {
    case 'parameter':
      return 0.5;
    case 'typealias':
      return 0.2;
    default:
      return 1;
  }
}

/** Offset of the `(` of the innermost call enclosing `offset`, or -1. */
function enclosingCallParen(masked: string, offset: number): number {
  let depth = 0;
  for (let k = offset - 1; k >= 0 && k > offset - 20000; k--) {
    const c = masked[k];
    if (c === ')') {
      depth++;
    } else if (c === '(') {
      if (depth === 0) {
        return k;
      }
      depth--;
    } else if (c === '{' && depth === 0) {
      return -1;
    }
  }
  return -1;
}
