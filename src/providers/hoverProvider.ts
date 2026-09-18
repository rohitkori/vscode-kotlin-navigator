import * as vscode from 'vscode';
import { IndexService } from '../index/indexService';
import { Declaration } from '../parser/types';
import { Resolver } from '../resolve/resolver';
import { DocumentStore } from './documentStore';

/** A hover card with the resolved declaration's signature and doc comment. */
export class KotlinHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly documents: DocumentStore,
    private readonly resolver: Resolver,
    private readonly index: IndexService,
    private readonly enabled: () => boolean,
  ) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.enabled()) {
      return undefined;
    }
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
    if (candidates.length === 0) {
      return undefined;
    }
    const decl = candidates[0].decl;
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendCodeblock(decl.signature || `${decl.kind} ${decl.name}`, languageOf(decl));

    const origin = this.index.symbols.originOf(decl.file);
    const container = decl.containerFqName || '(top level)';
    markdown.appendMarkdown(`\n_${decl.kind}_ in \`${container}\``);
    if (origin === 'library') {
      const source = this.index.libraries.bySourceKey(decl.file);
      markdown.appendMarkdown(source ? ` &nbsp;·&nbsp; from \`${source.artifact}\`` : ' &nbsp;·&nbsp; from a library');
    } else if (origin === 'generated') {
      markdown.appendMarkdown(' &nbsp;·&nbsp; generated source');
    }
    if (decl.doc) {
      markdown.appendMarkdown(`\n\n${escapeDoc(decl.doc)}`);
    }

    const target = chain.segments[chain.targetIndex];
    return new vscode.Hover(
      markdown,
      new vscode.Range(document.positionAt(target.start), document.positionAt(target.end)),
    );
  }
}

function languageOf(decl: Declaration): string {
  return decl.file.endsWith('.java') ? 'java' : 'kotlin';
}

/** KDoc is mostly Markdown already; `[Foo]` links are the main exception. */
function escapeDoc(doc: string): string {
  return doc
    .split('\n')
    .map((line) => line.replace(/^@(param|return|throws|see|since|sample)\b/, '**@$1**'))
    .join('\n')
    .substring(0, 1000);
}
