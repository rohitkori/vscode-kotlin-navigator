import { Declaration, ParsedFile } from '../parser/types';

export type Origin = 'workspace' | 'generated' | 'library';

/** Higher wins when several declarations match a reference equally well. */
export const ORIGIN_RANK: Record<Origin, number> = {
  workspace: 3,
  generated: 2,
  library: 1,
};

export interface IndexedFile {
  file: string;
  parsed: ParsedFile;
  origin: Origin;
  /** mtime for files on disk, document version for unsaved editors. */
  version: number;
}

/**
 * The in-memory symbol table for fully parsed sources (the workspace and any
 * library file that has been opened). Library sources that have only been
 * discovered by path live in `LibraryIndex` instead, and are folded in here as
 * they get parsed.
 */
export class SymbolIndex {
  private readonly files = new Map<string, IndexedFile>();
  private readonly bySimpleName = new Map<string, Declaration[]>();
  private readonly byFqName = new Map<string, Declaration[]>();
  private readonly byContainer = new Map<string, Declaration[]>();
  /** Container FQ name -> its companion objects. */
  private readonly companionsByContainer = new Map<string, Declaration[]>();
  private readonly byPackage = new Map<string, Declaration[]>();
  /** Identifier -> files that mention it, for Find All References. */
  private readonly filesByWord = new Map<string, Set<string>>();

  get size(): number {
    return this.files.size;
  }

  getFile(file: string): IndexedFile | undefined {
    return this.files.get(file);
  }

  allFiles(): IterableIterator<IndexedFile> {
    return this.files.values();
  }

  has(file: string): boolean {
    return this.files.has(file);
  }

  setFile(parsed: ParsedFile, origin: Origin, version: number): void {
    this.deleteFile(parsed.file);
    const entry: IndexedFile = { file: parsed.file, parsed, origin, version };
    this.files.set(parsed.file, entry);

    for (const decl of parsed.declarations) {
      if (decl.isLocal) {
        continue; // locals are resolved from the file's own parse, never globally
      }
      push(this.bySimpleName, decl.name, decl);
      push(this.byFqName, decl.fqName, decl);
      push(this.byContainer, decl.containerFqName, decl);
      if (decl.isCompanion || (decl.kind === 'object' && decl.name === 'Companion')) {
        push(this.companionsByContainer, decl.containerFqName, decl);
      }
    }
    for (const index of parsed.topLevel) {
      push(this.byPackage, parsed.packageName, parsed.declarations[index]);
    }
    if (origin !== 'library') {
      for (const word of parsed.identifiers) {
        const files = this.filesByWord.get(word);
        if (files) {
          files.add(parsed.file);
        } else {
          this.filesByWord.set(word, new Set([parsed.file]));
        }
      }
    }
  }

  deleteFile(file: string): void {
    const existing = this.files.get(file);
    if (!existing) {
      return;
    }
    this.files.delete(file);
    for (const decl of existing.parsed.declarations) {
      if (decl.isLocal) {
        continue;
      }
      remove(this.bySimpleName, decl.name, decl);
      remove(this.byFqName, decl.fqName, decl);
      remove(this.byContainer, decl.containerFqName, decl);
      if (decl.isCompanion || (decl.kind === 'object' && decl.name === 'Companion')) {
        remove(this.companionsByContainer, decl.containerFqName, decl);
      }
    }
    for (const index of existing.parsed.topLevel) {
      remove(this.byPackage, existing.parsed.packageName, existing.parsed.declarations[index]);
    }
    for (const word of existing.parsed.identifiers) {
      const files = this.filesByWord.get(word);
      if (files) {
        files.delete(file);
        if (files.size === 0) {
          this.filesByWord.delete(word);
        }
      }
    }
  }

  clear(): void {
    this.files.clear();
    this.bySimpleName.clear();
    this.byFqName.clear();
    this.byContainer.clear();
    this.companionsByContainer.clear();
    this.byPackage.clear();
    this.filesByWord.clear();
  }

  /** Workspace files that mention `word` anywhere in their code. */
  filesMentioning(word: string): readonly string[] {
    const files = this.filesByWord.get(word);
    return files ? [...files] : [];
  }

  originOf(file: string): Origin {
    return this.files.get(file)?.origin ?? 'library';
  }

  bySimple(name: string): readonly Declaration[] {
    return this.bySimpleName.get(name) ?? [];
  }

  byFq(fqName: string): readonly Declaration[] {
    return this.byFqName.get(fqName) ?? [];
  }

  /** Declarations whose immediate container is `containerFqName`. */
  membersOf(containerFqName: string): readonly Declaration[] {
    return this.byContainer.get(containerFqName) ?? [];
  }

  companionsOf(containerFqName: string): readonly Declaration[] {
    return this.companionsByContainer.get(containerFqName) ?? [];
  }

  topLevelInPackage(packageName: string): readonly Declaration[] {
    return this.byPackage.get(packageName) ?? [];
  }

  /** Every distinct simple name, for workspace-symbol search. */
  *simpleNames(): IterableIterator<[string, readonly Declaration[]]> {
    for (const [name, decls] of this.bySimpleName) {
      yield [name, decls];
    }
  }

  stats(): { files: number; declarations: number; names: number } {
    let declarations = 0;
    for (const list of this.bySimpleName.values()) {
      declarations += list.length;
    }
    return { files: this.files.size, declarations, names: this.bySimpleName.size };
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function remove(map: Map<string, Declaration[]>, key: string, value: Declaration): void {
  const list = map.get(key);
  if (!list) {
    return;
  }
  const idx = list.indexOf(value);
  if (idx >= 0) {
    list.splice(idx, 1);
  }
  if (list.length === 0) {
    map.delete(key);
  }
}
