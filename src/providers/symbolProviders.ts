import * as vscode from 'vscode';
import { IndexService } from '../index/indexService';
import { Declaration, DeclKind } from '../parser/types';
import { DocumentStore } from './documentStore';
import { uriForFileKey } from './uriMapping';

const SYMBOL_KINDS: Record<DeclKind, vscode.SymbolKind> = {
  class: vscode.SymbolKind.Class,
  interface: vscode.SymbolKind.Interface,
  object: vscode.SymbolKind.Object,
  enum: vscode.SymbolKind.Enum,
  enumEntry: vscode.SymbolKind.EnumMember,
  annotationClass: vscode.SymbolKind.Interface,
  function: vscode.SymbolKind.Method,
  constructor: vscode.SymbolKind.Constructor,
  property: vscode.SymbolKind.Property,
  parameter: vscode.SymbolKind.Variable,
  typealias: vscode.SymbolKind.TypeParameter,
  package: vscode.SymbolKind.Package,
};

/** The outline view and breadcrumbs for a Kotlin file. */
export class KotlinDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly documents: DocumentStore) {}

  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] | undefined {
    const model = this.documents.get(document);
    if (!model) {
      return undefined;
    }
    const declarations = model.parsed.declarations;
    const built = new Map<number, vscode.DocumentSymbol>();

    const toSymbol = (index: number): vscode.DocumentSymbol | undefined => {
      const existing = built.get(index);
      if (existing) {
        return existing;
      }
      const decl = declarations[index];
      if (decl.kind === 'parameter' || decl.isLocal) {
        return undefined;
      }
      const start = document.positionAt(Math.min(decl.startOffset, decl.nameOffset));
      const end = document.positionAt(Math.max(decl.endOffset, decl.nameOffset + decl.nameLength));
      const nameStart = document.positionAt(decl.nameOffset);
      const nameEnd = document.positionAt(decl.nameOffset + decl.nameLength);
      const symbol = new vscode.DocumentSymbol(
        decl.name,
        detailFor(decl),
        SYMBOL_KINDS[decl.kind],
        new vscode.Range(start, end),
        new vscode.Range(nameStart, nameEnd),
      );
      built.set(index, symbol);
      for (const childIndex of decl.children) {
        const child = toSymbol(childIndex);
        if (child) {
          symbol.children.push(child);
        }
      }
      return symbol;
    };

    const roots: vscode.DocumentSymbol[] = [];
    for (const index of model.parsed.topLevel) {
      const symbol = toSymbol(index);
      if (symbol) {
        roots.push(symbol);
      }
    }
    return roots;
  }
}

/** Ctrl-T / Cmd-T across everything that has been indexed. */
export class KotlinWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly index: IndexService) {}

  async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
    if (query.length === 0) {
      return [];
    }
    const lowered = query.toLowerCase();
    const scored: Array<{ decl: Declaration; score: number }> = [];

    for (const [name, decls] of this.index.symbols.simpleNames()) {
      if (token.isCancellationRequested) {
        break;
      }
      const score = matchScore(name, lowered);
      if (score <= 0) {
        continue;
      }
      for (const decl of decls) {
        if (decl.kind === 'parameter' || decl.isLocal) {
          continue;
        }
        const origin = this.index.symbols.originOf(decl.file);
        scored.push({ decl, score: score + (origin === 'workspace' ? 20 : origin === 'generated' ? 5 : 0) });
      }
      if (scored.length > 4000) {
        break;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const out: vscode.SymbolInformation[] = [];
    for (const { decl } of scored.slice(0, 200)) {
      const uri = uriForFileKey(decl.file);
      let range: vscode.Range;
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        range = new vscode.Range(
          document.positionAt(decl.nameOffset),
          document.positionAt(decl.nameOffset + decl.nameLength),
        );
      } catch {
        continue;
      }
      out.push(
        new vscode.SymbolInformation(
          decl.name,
          SYMBOL_KINDS[decl.kind],
          decl.containerFqName,
          new vscode.Location(uri, range),
        ),
      );
    }
    return out;
  }
}

function detailFor(decl: Declaration): string {
  if (decl.receiverType) {
    return `${decl.receiverType}.${decl.name}${decl.typeText ? `: ${decl.typeText}` : ''}`;
  }
  if (decl.typeText) {
    return decl.typeText;
  }
  if (decl.supertypes?.length) {
    return `: ${decl.supertypes.join(', ')}`;
  }
  return '';
}

/** Exact > prefix > camel-hump > substring. */
function matchScore(name: string, loweredQuery: string): number {
  const lowered = name.toLowerCase();
  if (lowered === loweredQuery) {
    return 100;
  }
  if (lowered.startsWith(loweredQuery)) {
    return 80 - Math.min(20, name.length - loweredQuery.length);
  }
  const humps = name
    .split(/(?=[A-Z])|_/)
    .map((part) => part[0]?.toLowerCase() ?? '')
    .join('');
  if (humps.startsWith(loweredQuery)) {
    return 60;
  }
  if (lowered.includes(loweredQuery)) {
    return 40 - Math.min(20, name.length - loweredQuery.length);
  }
  return 0;
}
