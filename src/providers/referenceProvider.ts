import * as vscode from 'vscode';
import { IndexService } from '../index/indexService';
import { Declaration } from '../parser/types';
import { parseSource } from '../index/sourceScanner';
import { Resolver } from '../resolve/resolver';
import { collectIdentifiers, identifierAt, KIND_CODE, maskSource } from '../util/text';
import { log } from '../util/log';
import { DocumentStore } from './documentStore';
import { uriForFileKey } from './uriMapping';

/**
 * Find All References.
 *
 * Candidate files come from the identifier index, and every occurrence in them
 * is resolved and kept only when it lands back on the same declaration - so a
 * `name` on an unrelated class is not reported.
 */
export class KotlinReferenceProvider implements vscode.ReferenceProvider {
  constructor(
    private readonly documents: DocumentStore,
    private readonly resolver: Resolver,
    private readonly index: IndexService,
  ) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const model = this.documents.get(document);
    if (!model) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const target = identifierAt(model.masked, offset);
    if (!target) {
      return undefined;
    }

    // Which declaration are we looking for? Either the one under the cursor, or
    // the one the reference under the cursor points at.
    const declaration = this.declarationAt(model.parsed.declarations, offset) ??
      this.resolver.resolve(this.documents.toResolveInput(model, offset))[0]?.decl;
    if (!declaration) {
      return undefined;
    }

    const started = Date.now();
    const wanted = keyOf(declaration);
    const locations: vscode.Location[] = [];

    if (context.includeDeclaration) {
      const declarationLocation = await this.locationFor(declaration, declaration.nameOffset, declaration.nameLength);
      if (declarationLocation) {
        locations.push(declarationLocation);
      }
    }

    const files = this.index.symbols.filesMentioning(declaration.name);
    for (const file of files) {
      if (token.isCancellationRequested) {
        break;
      }
      const hits = await this.referencesInFile(file, declaration, wanted, document);
      locations.push(...hits);
    }
    log(`references to ${declaration.fqName}: ${locations.length} in ${files.length} files (${Date.now() - started}ms)`);
    return locations;
  }

  private async referencesInFile(
    file: string,
    declaration: Declaration,
    wanted: string,
    activeDocument: vscode.TextDocument,
  ): Promise<vscode.Location[]> {
    const uri = uriForFileKey(file);
    let text: string;
    let parsed = this.index.getParsed(file);
    if (uri.toString() === activeDocument.uri.toString()) {
      text = activeDocument.getText();
    } else {
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        return [];
      }
    }
    if (!parsed || parsed.sourceLength !== text.length) {
      parsed = parseSource(file, text);
    }
    if (!parsed) {
      return [];
    }
    const { masked, kinds } = maskSource(text, { templates: !file.endsWith('.java') });
    const out: vscode.Location[] = [];
    const name = declaration.name;

    let from = 0;
    for (;;) {
      const at = masked.indexOf(name, from);
      if (at < 0) {
        break;
      }
      from = at + name.length;
      if (kinds[at] !== KIND_CODE) {
        continue;
      }
      const token = identifierAt(masked, at);
      if (!token || token.name !== name || token.start !== at) {
        continue;
      }
      if (file === declaration.file && token.start === declaration.nameOffset) {
        continue; // the declaration itself, handled separately
      }
      const resolved = this.resolver.resolve({ file, raw: text, masked, kinds, parsed, offset: token.start });
      if (resolved.length === 0 || keyOf(resolved[0].decl) !== wanted) {
        continue;
      }
      const document = await this.openIfNeeded(uri, activeDocument);
      if (!document) {
        continue;
      }
      out.push(
        new vscode.Location(
          uri,
          new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)),
        ),
      );
    }
    return out;
  }

  private async openIfNeeded(uri: vscode.Uri, active: vscode.TextDocument): Promise<vscode.TextDocument | undefined> {
    if (uri.toString() === active.uri.toString()) {
      return active;
    }
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return undefined;
    }
  }

  private declarationAt(declarations: Declaration[], offset: number): Declaration | undefined {
    return declarations.find((d) => offset >= d.nameOffset && offset <= d.nameOffset + d.nameLength);
  }

  private async locationFor(decl: Declaration, offset: number, length: number): Promise<vscode.Location | undefined> {
    const uri = uriForFileKey(decl.file);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return new vscode.Location(
        uri,
        new vscode.Range(document.positionAt(offset), document.positionAt(offset + length)),
      );
    } catch {
      return undefined;
    }
  }
}

function keyOf(decl: Declaration): string {
  return `${decl.file}:${decl.nameOffset}`;
}

export { collectIdentifiers };
