/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Just enough of the `vscode` module to run `activate()` and call the providers
 * outside an editor. Anything the extension touches has to exist here, so this
 * doubles as a check that the extension only uses API it declares.
 */
import * as fs from 'fs';
import * as pathModule from 'path';

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position) {
    this.start = start;
    this.end = end;
  }
}

export class Location {
  constructor(readonly uri: Uri, readonly range: Range) {}
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}
  static file(p: string): Uri {
    return new Uri('file', '', p, '', '');
  }
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!match) {
      return Uri.file(value);
    }
    return new Uri(match[1], match[2] ?? '', match[3] ?? '', match[4] ?? '', match[5] ?? '');
  }
  static from(parts: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '', parts.fragment ?? '');
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

export class MarkdownString {
  value = '';
  constructor(_v?: string, _supportThemeIcons?: boolean) {}
  appendCodeblock(code: string, _lang?: string): void {
    this.value += `\n\`\`\`\n${code}\n\`\`\`\n`;
  }
  appendMarkdown(text: string): void {
    this.value += text;
  }
}

export class Hover {
  constructor(readonly contents: MarkdownString, readonly range?: Range) {}
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: number,
    readonly range: Range,
    readonly selectionRange: Range,
  ) {}
}

export class SymbolInformation {
  constructor(
    readonly name: string,
    readonly kind: number,
    readonly containerName: string,
    readonly location: Location,
  ) {}
}

export const SymbolKind = {
  Class: 4, Interface: 10, Object: 18, Enum: 9, EnumMember: 21, Method: 5,
  Constructor: 8, Property: 6, Variable: 12, TypeParameter: 25, Package: 3,
};

export const ProgressLocation = { Window: 10, Notification: 15 };

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(value: T): void {
    for (const l of this.listeners) {
      l(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const CancellationTokenNone = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

export class MockTextDocument {
  readonly version = 1;
  private readonly lineStarts: number[] = [0];
  constructor(readonly uri: Uri, private readonly content: string) {
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        this.lineStarts.push(i + 1);
      }
    }
  }
  getText(): string {
    return this.content;
  }
  offsetAt(position: Position): number {
    return this.lineStarts[Math.min(position.line, this.lineStarts.length - 1)] + position.character;
  }
  positionAt(offset: number): Position {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return new Position(low, offset - this.lineStarts[low]);
  }
  lineAt(line: number): { range: Range } {
    const start = this.lineStarts[line] ?? 0;
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.content.length;
    return { range: new Range(this.positionAt(start), this.positionAt(end)) };
  }
  getWordRangeAtPosition(position: Position, pattern: RegExp): Range | undefined {
    const offset = this.offsetAt(position);
    const lineStart = this.lineStarts[position.line];
    const lineEnd = position.line + 1 < this.lineStarts.length ? this.lineStarts[position.line + 1] - 1 : this.content.length;
    const line = this.content.substring(lineStart, lineEnd);
    const global = new RegExp(pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = global.exec(line)) !== null) {
      const start = lineStart + match.index;
      if (offset >= start && offset <= start + match[0].length) {
        return new Range(this.positionAt(start), this.positionAt(start + match[0].length));
      }
    }
    return undefined;
  }
}

// --- captured registrations ------------------------------------------------

export const registry = {
  definition: [] as any[],
  xmlDefinition: [] as any[],
  typeDefinition: [] as any[],
  implementation: [] as any[],
  reference: [] as any[],
  documentSymbol: [] as any[],
  workspaceSymbol: [] as any[],
  hover: [] as any[],
  contentProviders: new Map<string, any>(),
  commands: new Map<string, (...args: any[]) => any>(),
  configuration: {} as Record<string, unknown>,
  workspaceRoots: [] as string[],
  reset(): void {
    this.definition = [];
    this.xmlDefinition = [];
    this.typeDefinition = [];
    this.implementation = [];
    this.reference = [];
    this.documentSymbol = [];
    this.workspaceSymbol = [];
    this.hover = [];
    this.contentProviders.clear();
    this.commands.clear();
  },
};

function selectorIsXml(selector: any): boolean {
  return JSON.stringify(selector).includes('xml');
}

export const languages = {
  registerDefinitionProvider(selector: any, provider: any) {
    (selectorIsXml(selector) ? registry.xmlDefinition : registry.definition).push(provider);
    return { dispose() {} };
  },
  registerTypeDefinitionProvider(_s: any, p: any) {
    registry.typeDefinition.push(p);
    return { dispose() {} };
  },
  registerImplementationProvider(_s: any, p: any) {
    registry.implementation.push(p);
    return { dispose() {} };
  },
  registerReferenceProvider(_s: any, p: any) {
    registry.reference.push(p);
    return { dispose() {} };
  },
  registerDocumentSymbolProvider(_s: any, p: any) {
    registry.documentSymbol.push(p);
    return { dispose() {} };
  },
  registerWorkspaceSymbolProvider(p: any) {
    registry.workspaceSymbol.push(p);
    return { dispose() {} };
  },
  registerHoverProvider(_s: any, p: any) {
    registry.hover.push(p);
    return { dispose() {} };
  },
};

const noopEvent = () => ({ dispose() {} });

export const workspace = {
  get workspaceFolders() {
    return registry.workspaceRoots.map((p) => ({ uri: Uri.file(p), name: pathModule.basename(p), index: 0 }));
  },
  getConfiguration(_section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = registry.configuration[key];
        return value === undefined ? fallback : (value as T);
      },
    };
  },
  createFileSystemWatcher() {
    return { onDidCreate: noopEvent, onDidChange: noopEvent, onDidDelete: noopEvent, dispose() {} };
  },
  onDidChangeTextDocument: noopEvent,
  onDidSaveTextDocument: noopEvent,
  onDidChangeWorkspaceFolders: noopEvent,
  onDidChangeConfiguration: noopEvent,
  registerTextDocumentContentProvider(scheme: string, provider: any) {
    registry.contentProviders.set(scheme, provider);
    return { dispose() {} };
  },
  async openTextDocument(uri: Uri): Promise<MockTextDocument> {
    if (uri.scheme === 'file') {
      return new MockTextDocument(uri, fs.readFileSync(uri.fsPath, 'utf8'));
    }
    const provider = registry.contentProviders.get(uri.scheme);
    if (!provider) {
      throw new Error(`no content provider for ${uri.scheme}`);
    }
    return new MockTextDocument(uri, provider.provideTextDocumentContent(uri));
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      if (uri.scheme === 'file') {
        return fs.readFileSync(uri.fsPath);
      }
      const provider = registry.contentProviders.get(uri.scheme);
      return Buffer.from(provider.provideTextDocumentContent(uri), 'utf8');
    },
  },
};

export const window = {
  createOutputChannel(_name: string) {
    return { appendLine(_line: string) {}, show() {}, dispose() {} };
  },
  showInformationMessage(_message: string) {
    return Promise.resolve(undefined);
  },
  async withProgress<T>(_options: unknown, task: (progress: any) => Promise<T>): Promise<T> {
    return task({ report() {} });
  },
};

export const commands = {
  registerCommand(name: string, handler: (...args: any[]) => any) {
    registry.commands.set(name, handler);
    return { dispose() {} };
  },
};

export const env = { appName: 'Mock Editor' };
