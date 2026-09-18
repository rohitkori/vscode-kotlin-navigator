import * as vscode from 'vscode';
import { AndroidResolver, ResourceTarget } from '../android/androidResolver';
import { IndexService } from '../index/indexService';
import { Declaration } from '../parser/types';
import { Candidate, Resolver } from '../resolve/resolver';
import { LineMap } from '../util/text';
import { trace } from '../util/log';
import { DocumentStore } from './documentStore';
import { uriForFileKey } from './uriMapping';

export interface ProviderSettings {
  maxResults: number;
  androidResources: boolean;
}

/**
 * Go to Definition for Kotlin and Java.
 *
 * Returns `LocationLink`s rather than plain locations so the peek window can
 * show the whole declaration while the cursor lands on its name.
 */
export class KotlinDefinitionProvider implements vscode.DefinitionProvider {
  constructor(
    private readonly documents: DocumentStore,
    private readonly resolver: Resolver,
    private readonly android: AndroidResolver,
    private readonly index: IndexService,
    private readonly settings: () => ProviderSettings,
  ) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | undefined> {
    const model = this.documents.get(document);
    if (!model) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const input = this.documents.toResolveInput(model, offset);
    const settings = this.settings();

    const chain = this.resolver.referenceAtCursor(input);
    if (!chain) {
      return undefined;
    }
    const originSelectionRange = rangeFor(document, chain.segments[chain.targetIndex]);

    if (settings.androidResources) {
      const resourceTargets = this.android.resolveInSource(input, chain);
      if (resourceTargets.length > 0) {
        trace(`android resource -> ${resourceTargets.map((t) => t.label).join(', ')}`);
        return await targetsToLinks(resourceTargets, originSelectionRange, token);
      }
    }

    const candidates = this.resolver.resolve(input);
    if (candidates.length === 0) {
      return undefined;
    }
    return await candidatesToLinks(candidates, originSelectionRange, settings.maxResults, this.index, token);
  }
}

/** Go to Type Definition: the type of the expression, not the expression. */
export class KotlinTypeDefinitionProvider implements vscode.TypeDefinitionProvider {
  constructor(
    private readonly documents: DocumentStore,
    private readonly resolver: Resolver,
    private readonly index: IndexService,
    private readonly settings: () => ProviderSettings,
  ) {}

  async provideTypeDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | undefined> {
    const model = this.documents.get(document);
    if (!model) {
      return undefined;
    }
    const input = this.documents.toResolveInput(model, document.offsetAt(position));
    const chain = this.resolver.referenceAtCursor(input);
    if (!chain) {
      return undefined;
    }
    const candidates = this.resolver.resolve(input);
    const types: Candidate[] = [];
    for (const candidate of candidates.slice(0, 4)) {
      const parsed = this.index.getParsed(candidate.decl.file);
      const typeText = candidate.decl.typeText;
      if (!parsed || !typeText) {
        continue;
      }
      for (const decl of this.resolver.resolveTypeName(typeText, parsed)) {
        types.push({ decl, score: candidate.score, reason: 'type of expression' });
      }
    }
    if (types.length === 0) {
      return undefined;
    }
    return await candidatesToLinks(
      types,
      rangeFor(document, chain.segments[chain.targetIndex]),
      this.settings().maxResults,
      this.index,
      token,
    );
  }
}

function rangeFor(document: vscode.TextDocument, segment: { start: number; end: number }): vscode.Range {
  return new vscode.Range(document.positionAt(segment.start), document.positionAt(segment.end));
}

async function candidatesToLinks(
  candidates: Candidate[],
  originSelectionRange: vscode.Range,
  maxResults: number,
  index: IndexService,
  token: vscode.CancellationToken,
): Promise<vscode.LocationLink[]> {
  // Keep only the candidates that are as good as the best one. When the best
  // answer is unambiguous this makes Ctrl-click jump straight there instead of
  // opening a picker.
  const best = candidates[0].score;
  const kept = candidates.filter((c) => c.score >= best - 0.001).slice(0, maxResults);
  const chosen = kept.length > 0 ? kept : candidates.slice(0, maxResults);

  const links: vscode.LocationLink[] = [];
  for (const candidate of chosen) {
    if (token.isCancellationRequested) {
      break;
    }
    const link = await declarationToLink(candidate.decl, originSelectionRange, index);
    if (link) {
      links.push(link);
    }
  }
  return links;
}

async function declarationToLink(
  decl: Declaration,
  originSelectionRange: vscode.Range,
  index: IndexService,
): Promise<vscode.LocationLink | undefined> {
  const uri = uriForFileKey(decl.file);
  const map = await lineMapFor(decl, index);
  if (!map) {
    return undefined;
  }
  const nameStart = toPosition(map, decl.nameOffset);
  const nameEnd = toPosition(map, decl.nameOffset + decl.nameLength);
  const declStart = toPosition(map, Math.min(decl.startOffset, decl.nameOffset));
  const declEnd = toPosition(map, Math.max(decl.endOffset, decl.nameOffset + decl.nameLength));
  return {
    originSelectionRange,
    targetUri: uri,
    targetRange: new vscode.Range(declStart, declEnd),
    targetSelectionRange: new vscode.Range(nameStart, nameEnd),
  };
}

const lineMapCache = new Map<string, { length: number; map: LineMap }>();

async function lineMapFor(decl: Declaration, index: IndexService): Promise<LineMap | undefined> {
  const source = index.libraries.bySourceKey(decl.file);
  const text = source
    ? index.libraries.getSource(source)
    : await readTextForKey(decl.file);
  if (text === undefined) {
    return undefined;
  }
  const cached = lineMapCache.get(decl.file);
  if (cached && cached.length === text.length) {
    return cached.map;
  }
  const map = new LineMap(text);
  if (lineMapCache.size > 64) {
    lineMapCache.clear();
  }
  lineMapCache.set(decl.file, { length: text.length, map });
  return map;
}

async function readTextForKey(key: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uriForFileKey(key));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

export function invalidateLineMap(key: string): void {
  lineMapCache.delete(key);
}

function toPosition(map: LineMap, offset: number): vscode.Position {
  const p = map.positionAt(offset);
  return new vscode.Position(p.line, p.character);
}

export async function targetsToLinks(
  targets: ResourceTarget[],
  originSelectionRange: vscode.Range,
  token: vscode.CancellationToken,
): Promise<vscode.LocationLink[]> {
  const links: vscode.LocationLink[] = [];
  for (const target of targets) {
    if (token.isCancellationRequested) {
      break;
    }
    try {
      const uri = vscode.Uri.file(target.file);
      const document = await vscode.workspace.openTextDocument(uri);
      const start = document.positionAt(target.offset);
      const end = document.positionAt(target.offset + target.length);
      links.push({
        originSelectionRange,
        targetUri: uri,
        targetRange: new vscode.Range(document.lineAt(start.line).range.start, document.lineAt(end.line).range.end),
        targetSelectionRange: new vscode.Range(start, end),
      });
    } catch {
      // The resource file disappeared between indexing and navigation.
    }
  }
  return links;
}
