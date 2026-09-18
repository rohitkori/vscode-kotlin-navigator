import * as vscode from 'vscode';
import { ContainerTraits, IndexService } from '../index/indexService';
import { Declaration } from '../parser/types';
import { Resolver } from '../resolve/resolver';
import {
  classifyDeclaration,
  classifyUnresolved,
  Classification,
  TOKEN_MODIFIERS,
  TOKEN_TYPES,
} from '../resolve/classify';
import { isIdentStart, KIND_CODE, readIdentifier } from '../util/text';
import { log } from '../util/log';
import { DocumentModel, DocumentStore } from './documentStore';

export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

/**
 * Words that are always keywords in Kotlin or Java. Soft keywords such as
 * `data`, `value` and `by` are left out on purpose: they are ordinary
 * identifiers in most positions, and the TextMate grammar already colours them
 * where they are not.
 */
const HARD_KEYWORDS = new Set([
  'package', 'import', 'class', 'interface', 'object', 'fun', 'val', 'var', 'typealias',
  'if', 'else', 'when', 'for', 'while', 'do', 'return', 'break', 'continue', 'try', 'catch',
  'finally', 'throw', 'is', 'as', 'in', 'out', 'this', 'super', 'null', 'true', 'false',
  'typeof', 'public', 'private', 'protected', 'internal', 'open', 'final', 'abstract',
  'sealed', 'override', 'lateinit', 'const', 'inline', 'noinline', 'crossinline', 'reified',
  'vararg', 'suspend', 'tailrec', 'operator', 'infix', 'external', 'annotation', 'enum',
  'inner', 'companion', 'expect', 'actual', 'constructor', 'init', 'where', 'by', 'get', 'set',
  'static', 'void', 'new', 'extends', 'implements', 'synchronized', 'native', 'transient',
  'volatile', 'strictfp', 'throws', 'default', 'instanceof', 'switch', 'case', 'boolean',
  'byte', 'short', 'int', 'long', 'float', 'double', 'char',
]);

interface CachedTokens {
  version: number;
  tokens: vscode.SemanticTokens;
}

/**
 * Semantic highlighting driven by real resolution.
 *
 * A TextMate grammar can only colour keywords, strings and punctuation, which
 * is why an untouched Kotlin file is mostly white: every identifier looks the
 * same to a regex. Because this extension already resolves each reference to a
 * declaration, it can say whether a name is a class, an interface, a method, a
 * property, a parameter or a local - and mark suspending calls and immutable
 * bindings while it is at it.
 */
export class KotlinSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider, vscode.DocumentRangeSemanticTokensProvider
{
  private readonly cache = new Map<string, CachedTokens>();

  constructor(
    private readonly documents: DocumentStore,
    private readonly resolver: Resolver,
    private readonly index: IndexService,
    private readonly enabled: () => boolean,
  ) {}

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.SemanticTokens | undefined {
    if (!this.enabled()) {
      return undefined;
    }
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === document.version) {
      return cached.tokens;
    }
    const tokens = this.build(document, 0, document.getText().length, token);
    if (!tokens) {
      return undefined;
    }
    if (this.cache.size > 8) {
      this.cache.clear();
    }
    this.cache.set(key, { version: document.version, tokens });
    return tokens;
  }

  provideDocumentRangeSemanticTokens(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): vscode.SemanticTokens | undefined {
    if (!this.enabled()) {
      return undefined;
    }
    return this.build(document, document.offsetAt(range.start), document.offsetAt(range.end), token);
  }

  invalidate(uri: string): void {
    this.cache.delete(uri);
  }

  private build(
    document: vscode.TextDocument,
    from: number,
    to: number,
    cancellation: vscode.CancellationToken,
  ): vscode.SemanticTokens | undefined {
    const model = this.documents.get(document);
    if (!model) {
      return undefined;
    }
    const started = Date.now();
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
    const declarationsByOffset = new Map<number, Declaration>();
    for (const decl of model.parsed.declarations) {
      declarationsByOffset.set(decl.nameOffset, decl);
    }

    // Unqualified names that resolve to something global resolve the same way
    // everywhere in the file; locals and members do not, so they are not cached.
    const simpleNameCache = new Map<string, Classification | undefined>();
    let emitted = 0;

    const { masked, kinds } = model;
    let i = from;
    while (i < to) {
      if (kinds[i] !== KIND_CODE || !isIdentStart(masked[i])) {
        i++;
        continue;
      }
      if (i > 0 && (isIdentStart(masked[i - 1]) || (masked[i - 1] >= '0' && masked[i - 1] <= '9'))) {
        i++;
        continue;
      }
      const identifier = readIdentifier(masked, i);
      if (!identifier) {
        i++;
        continue;
      }
      i = identifier.end;
      if (HARD_KEYWORDS.has(identifier.name)) {
        continue;
      }
      if (emitted % 128 === 0 && cancellation.isCancellationRequested) {
        return undefined;
      }

      const classification = this.classifyAt(model, identifier.start, declarationsByOffset, simpleNameCache);
      if (!classification) {
        continue;
      }
      const position = document.positionAt(identifier.start);
      builder.push(
        position.line,
        position.character,
        identifier.end - identifier.start,
        encodeType(classification.type),
        encodeModifiers(classification.modifiers),
      );
      emitted++;
    }

    const elapsed = Date.now() - started;
    if (elapsed > 200) {
      log(`semantic tokens for ${document.uri.path.split('/').pop()}: ${emitted} tokens in ${elapsed}ms`);
    }
    return builder.build();
  }

  private classifyAt(
    model: DocumentModel,
    offset: number,
    declarationsByOffset: Map<number, Declaration>,
    simpleNameCache: Map<string, Classification | undefined>,
  ): Classification | undefined {
    const declaredHere = declarationsByOffset.get(offset);
    if (declaredHere) {
      return classifyDeclaration(declaredHere, {
        isDeclaration: true,
        isAnnotationUse: false,
        origin: 'workspace',
        container: this.containerTraits(declaredHere),
      });
    }

    const input = this.documents.toResolveInput(model, offset);
    const chain = this.resolver.referenceAtCursor(input);
    if (!chain) {
      return undefined;
    }
    const segment = chain.segments[chain.targetIndex];
    const isAnnotationUse = chain.kind === 'annotation';

    // Every segment of a `package` declaration is a namespace; in an `import`
    // all but the last one are, the last being the symbol itself.
    if (chain.kind === 'package') {
      return { type: 'namespace', modifiers: [] };
    }
    if (chain.kind === 'import' && chain.targetIndex < chain.segments.length - 1) {
      return { type: 'namespace', modifiers: [] };
    }

    const cacheable = chain.targetIndex === 0 && !isAnnotationUse;
    const cacheKey = `${segment.name}:${segment.isCall ? 'call' : 'ref'}`;
    if (cacheable && simpleNameCache.has(cacheKey)) {
      return simpleNameCache.get(cacheKey);
    }

    const candidates = this.resolver.resolveChain(input, chain);
    let result: Classification | undefined;
    if (candidates.length > 0) {
      const decl = candidates[0].decl;
      result = classifyDeclaration(decl, {
        isDeclaration: false,
        isAnnotationUse,
        origin: this.index.symbols.originOf(decl.file),
        container: this.containerTraits(decl),
      });
    } else {
      result = classifyUnresolved(segment.name, segment.isCall, isAnnotationUse);
    }

    // A local or parameter is only correct at this position, so it must not be
    // reused for the same name elsewhere in the file.
    if (cacheable && result?.type !== 'variable' && result?.type !== 'parameter') {
      simpleNameCache.set(cacheKey, result);
    }
    return result;
  }

  private containerTraits(decl: Declaration): ContainerTraits {
    if (!decl.containerFqName) {
      return { isType: false, isObject: false };
    }
    return this.index.containerTraits(decl.containerFqName);
  }
}

function encodeType(type: string): number {
  return TOKEN_TYPES.indexOf(type as (typeof TOKEN_TYPES)[number]);
}

function encodeModifiers(modifiers: readonly string[]): number {
  let bits = 0;
  for (const modifier of modifiers) {
    const index = TOKEN_MODIFIERS.indexOf(modifier as (typeof TOKEN_MODIFIERS)[number]);
    if (index >= 0) {
      bits |= 1 << index;
    }
  }
  return bits;
}
