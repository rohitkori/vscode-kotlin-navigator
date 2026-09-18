import { Declaration, ParsedFile, TYPE_KINDS } from '../parser/types';
import { LibraryIndex, LibrarySource } from './libraryIndex';
import { Origin, SymbolIndex } from './symbolIndex';

const MAX_PARSED_LIBRARY_FILES = 12000;
/** Upper bound on files parsed when a whole package is pulled in on demand. */
const MAX_FILES_PER_PACKAGE = 300;
/** Upper bound when widening to a whole package sub-tree. */
const MAX_FILES_PER_PACKAGE_TREE = 1500;

/**
 * Owns both indexes and the policy for pulling library sources into the symbol
 * table on demand. Everything above this layer asks questions in terms of
 * declarations and never has to care whether a file came from the workspace, a
 * generated-sources directory, or the inside of a jar.
 */
export class IndexService {
  readonly symbols = new SymbolIndex();
  readonly libraries = new LibraryIndex();
  /** Insertion order of parsed library files, for bounded memory use. */
  private readonly parsedLibraryQueue: string[] = [];
  /** Library packages already pulled in wholesale. */
  private readonly parsedPackages = new Set<string>();

  setWorkspaceFile(parsed: ParsedFile, origin: Origin, version: number): void {
    this.symbols.setFile(parsed, origin, version);
  }

  removeFile(file: string): void {
    this.symbols.deleteFile(file);
  }

  getParsed(file: string): ParsedFile | undefined {
    return this.symbols.getFile(file)?.parsed;
  }

  /** Declarations with exactly this fully qualified name, library sources included. */
  findByFq(fqName: string): Declaration[] {
    const direct = this.symbols.byFq(fqName);
    if (direct.length > 0) {
      return [...direct];
    }
    const source = this.libraries.lookupFq(fqName);
    if (!source) {
      // No file is named after this symbol. It may still be a top-level or
      // extension declaration inside some other file of the same package.
      const dot = fqName.lastIndexOf('.');
      if (dot > 0) {
        const packageName = fqName.substring(0, dot);
        this.ensurePackageParsed(packageName);
        let afterPackage = this.symbols.byFq(fqName);
        if (afterPackage.length > 0) {
          return [...afterPackage];
        }
        // Some libraries file sources under paths that do not match their
        // package - the Kotlin standard library declares `kotlin.let` inside
        // `kotlin/util/Standard.kt`. Widening to the sub-tree catches those.
        if (this.ensurePackageTreeParsed(packageName)) {
          afterPackage = this.symbols.byFq(fqName);
          if (afterPackage.length > 0) {
            return [...afterPackage];
          }
        }
      }
      return [];
    }
    const parsed = this.ensureLibraryParsed(source);
    if (!parsed) {
      return [];
    }
    const exact = this.symbols.byFq(fqName);
    if (exact.length > 0) {
      return [...exact];
    }
    // The file name did not match the declaration inside it (common for Kotlin
    // files holding top-level functions). Fall back to the simple name.
    const simple = fqName.substring(fqName.lastIndexOf('.') + 1);
    return parsed.declarations.filter((d) => !d.isLocal && d.name === simple);
  }

  /**
   * Parses every source file of a library package, once.
   * Returns true when the package was known (whether or not it was new).
   */
  ensurePackageParsed(packageName: string): boolean {
    if (this.parsedPackages.has(packageName)) {
      return true;
    }
    const sources = this.libraries.lookupPackage(packageName);
    if (sources.length === 0) {
      // Remember the miss too: without this, every unresolved name in the
      // workspace re-scans the library index.
      this.parsedPackages.add(packageName);
      return false;
    }
    this.parsedPackages.add(packageName);
    for (const source of sources.slice(0, MAX_FILES_PER_PACKAGE)) {
      this.ensureLibraryParsed(source);
    }
    return true;
  }

  /** Parses a package and everything nested below it, once and bounded. */
  ensurePackageTreeParsed(packageName: string): boolean {
    const key = `${packageName}.**`;
    if (this.parsedPackages.has(key)) {
      return true;
    }
    this.parsedPackages.add(key);
    const sources = this.libraries.lookupPackageTree(packageName, MAX_FILES_PER_PACKAGE_TREE);
    if (sources.length === 0) {
      return false;
    }
    for (const source of sources) {
      this.ensureLibraryParsed(source);
    }
    return true;
  }

  findBySimple(name: string): readonly Declaration[] {
    return this.symbols.bySimple(name);
  }

  /** Library files whose path suggests this simple name; parsed on demand. */
  findLibraryBySimple(name: string, limit: number): Declaration[] {
    const sources = this.libraries.lookupSimple(name);
    const out: Declaration[] = [];
    for (const source of sources.slice(0, limit)) {
      const parsed = this.ensureLibraryParsed(source);
      if (!parsed) {
        continue;
      }
      for (const decl of parsed.declarations) {
        // A constructor shares its class's name and would show up as a second,
        // less useful candidate for the same type.
        if (!decl.isLocal && decl.name === name && decl.kind !== 'constructor') {
          out.push(decl);
        }
      }
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  ensureLibraryParsed(source: LibrarySource): ParsedFile | undefined {
    const existing = this.symbols.getFile(source.key);
    if (existing) {
      return existing.parsed;
    }
    const parsed = this.libraries.getParsed(source);
    if (!parsed) {
      return undefined;
    }
    this.symbols.setFile(parsed, 'library', 0);
    this.parsedLibraryQueue.push(source.key);
    while (this.parsedLibraryQueue.length > MAX_PARSED_LIBRARY_FILES) {
      const oldest = this.parsedLibraryQueue.shift();
      if (oldest && this.symbols.originOf(oldest) === 'library') {
        this.symbols.deleteFile(oldest);
        // The package memo says "already parsed", so an evicted file would
        // otherwise be gone for good. Forgetting the memo lets it come back.
        this.parsedPackages.clear();
      }
    }
    return parsed;
  }

  /** Makes sure the file a declaration lives in is fully parsed. */
  ensureDeclarationFile(decl: Declaration): ParsedFile | undefined {
    const existing = this.symbols.getFile(decl.file);
    if (existing) {
      return existing.parsed;
    }
    const source = this.libraries.bySourceKey(decl.file);
    return source ? this.ensureLibraryParsed(source) : undefined;
  }

  membersOf(containerFqName: string): readonly Declaration[] {
    return this.symbols.membersOf(containerFqName);
  }

  isTypeDeclaration(decl: Declaration): boolean {
    return TYPE_KINDS.has(decl.kind);
  }

  stats(): string {
    const s = this.symbols.stats();
    const l = this.libraries.stats;
    return (
      `Indexed files: ${s.files}\n` +
      `Declarations: ${s.declarations}\n` +
      `Distinct names: ${s.names}\n` +
      `Library sources jars: ${l.jars}\n` +
      `Library source files known: ${l.entries}\n` +
      `Library files parsed so far: ${l.parsed}`
    );
  }
}
