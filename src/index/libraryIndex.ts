import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ParsedFile } from '../parser/types';
import { parseKotlin } from '../parser/kotlin';
import { parseJava } from '../parser/java';
import { listZipEntries, readZipEntry, ZipEntry } from '../util/zip';
import { statSafe, walkFiles } from '../util/fsWalk';
import { log, logError } from '../util/log';

export const LIB_SCHEME = 'ktnav';

/** A source file that exists inside a jar, or as a plain file outside the workspace. */
export interface LibrarySource {
  /** Value stored in `Declaration.file`; parses back to a URI. */
  key: string;
  /** Fully qualified name implied by the file's path inside the archive. */
  fqNameGuess: string;
  simpleName: string;
  language: 'kotlin' | 'java';
  jarPath?: string;
  entry?: ZipEntry;
  filePath?: string;
  /** Human-readable origin, shown in the picker when a name is ambiguous. */
  artifact: string;
}

export interface LibraryRoot {
  dir: string;
  kind: 'jars' | 'sources';
  label: string;
}

/**
 * A *path-level* index of every library source file we can find.
 *
 * Listing a jar's central directory is cheap, so all of them get indexed up
 * front; the file itself is only inflated and parsed when the user actually
 * navigates into it. That is what makes "jump into okhttp/retrofit/the Android
 * framework" feel instant without a Gradle sync.
 */
export class LibraryIndex {
  private readonly byFqName = new Map<string, LibrarySource>();
  private readonly bySimpleName = new Map<string, LibrarySource[]>();
  private readonly byPackage = new Map<string, LibrarySource[]>();
  private readonly byKey = new Map<string, LibrarySource>();
  /** Package names in sort order, so a package sub-tree is a contiguous range. */
  private sortedPackages?: string[];
  private readonly parsed = new Map<string, ParsedFile>();
  private readonly sourceText = new Map<string, string>();
  private jarCount = 0;
  private entryCount = 0;
  ready = false;

  get stats(): { jars: number; entries: number; names: number; parsed: number } {
    return { jars: this.jarCount, entries: this.entryCount, names: this.bySimpleName.size, parsed: this.parsed.size };
  }

  clear(): void {
    this.byFqName.clear();
    this.bySimpleName.clear();
    this.byPackage.clear();
    this.byKey.clear();
    this.sortedPackages = undefined;
    this.parsed.clear();
    this.sourceText.clear();
    this.jarCount = 0;
    this.entryCount = 0;
    this.ready = false;
  }

  /**
   * Sources jars under the given roots, newest first so that when two versions
   * of a library are cached the newer one wins the fully-qualified-name slot.
   */
  collectSourceJars(roots: LibraryRoot[]): string[] {
    const jars: Array<{ file: string; mtime: number }> = [];
    for (const root of roots) {
      if (root.kind !== 'jars' || !statSafe(root.dir)?.isDirectory()) {
        continue;
      }
      for (const file of walkFiles(root.dir, { maxDepth: 8, extensions: new Set(['.jar']) })) {
        if (file.endsWith('-sources.jar')) {
          jars.push({ file, mtime: statSafe(file)?.mtimeMs ?? 0 });
        }
      }
    }
    jars.sort((a, b) => b.mtime - a.mtime);
    return jars.map((j) => j.file);
  }

  markReady(): void {
    this.ready = true;
    log(
      `library index ready: ${this.jarCount} sources jars, ${this.entryCount} source files, ` +
        `${this.bySimpleName.size} distinct names`,
    );
  }

  /** Synchronous build, used by tests and the headless benchmark. */
  build(roots: LibraryRoot[], shouldCancel: () => boolean): void {
    const started = Date.now();
    for (const root of roots) {
      if (shouldCancel()) {
        return;
      }
      if (root.kind === 'sources' && statSafe(root.dir)?.isDirectory()) {
        this.indexSourceDirectory(root.dir, root.label);
      }
    }
    for (const file of this.collectSourceJars(roots)) {
      if (shouldCancel()) {
        return;
      }
      this.indexJar(file);
    }
    this.ready = true;
    log(
      `library index ready: ${this.jarCount} sources jars, ${this.entryCount} source files, ` +
        `${this.bySimpleName.size} distinct names (${Date.now() - started}ms)`,
    );
  }

  indexJar(jarPath: string): void {
    let entries: ZipEntry[];
    try {
      entries = listZipEntries(jarPath);
    } catch (error) {
      logError(`could not read ${path.basename(jarPath)}`, error);
      return;
    }
    const artifact = path.basename(jarPath).replace(/-sources\.jar$/, '');
    const sourceEntries = entries.filter((e) => e.name.endsWith('.kt') || e.name.endsWith('.java'));
    if (sourceEntries.length === 0) {
      return;
    }
    const basePackage = this.detectBasePackage(jarPath, sourceEntries);

    let added = false;
    for (const entry of sourceEntries) {
      const language = entry.name.endsWith('.kt') ? 'kotlin' : 'java';
      const { dirs, simpleName } = splitEntryPath(entry.name);
      if (!simpleName || simpleName === 'package-info' || simpleName === 'module-info') {
        continue;
      }
      const fqNameGuess = [basePackage, ...dirs, simpleName].filter((p) => p.length > 0).join('.');
      const source: LibrarySource = {
        key: makeJarKey(jarPath, entry.name),
        fqNameGuess,
        simpleName,
        language,
        jarPath,
        entry,
        artifact,
      };
      this.register(source);
      added = true;
      this.entryCount++;
    }
    if (added) {
      this.jarCount++;
    }
  }

  /**
   * Works out the package prefix that the entry paths omit.
   *
   * Multiplatform artifacts publish sources under a source-set root
   * (`commonMain/`, `jvmMain/`, ...), and some - kotlinx.coroutines being the
   * notable one - drop the package directories entirely, so
   * `jvmMain/flow/Flow.kt` really holds `package kotlinx.coroutines.flow`.
   * Reading the `package` line out of one file recovers the missing prefix for
   * the whole archive at the cost of a single inflate.
   */
  private detectBasePackage(jarPath: string, entries: ZipEntry[]): string {
    const samples = pickSamples(entries, 2);
    let agreed: string | undefined;
    for (const entry of samples) {
      let declared: string | undefined;
      try {
        declared = readPackageDeclaration(readZipEntry(jarPath, entry));
      } catch {
        return '';
      }
      if (declared === undefined) {
        continue;
      }
      const { dirs } = splitEntryPath(entry.name);
      const suffix = dirs.join('.');
      let base: string;
      if (suffix.length === 0) {
        base = declared;
      } else if (declared === suffix) {
        base = '';
      } else if (declared.endsWith(`.${suffix}`)) {
        base = declared.substring(0, declared.length - suffix.length - 1);
      } else {
        return '';
      }
      if (agreed === undefined) {
        agreed = base;
      } else if (agreed !== base) {
        return '';
      }
    }
    return agreed ?? '';
  }

  indexSourceDirectory(dir: string, label: string): void {
    const files = walkFiles(dir, { extensions: new Set(['.java', '.kt']), maxFiles: 60000 });
    for (const file of files) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      const { dirs, simpleName } = splitEntryPath(rel);
      const fqNameGuess = [...dirs, simpleName].filter((p) => p.length > 0).join('.');
      if (!simpleName || simpleName === 'package-info' || simpleName === 'module-info') {
        continue;
      }
      this.register({
        key: file,
        fqNameGuess,
        simpleName,
        language: file.endsWith('.kt') ? 'kotlin' : 'java',
        filePath: file,
        artifact: label,
      });
      this.entryCount++;
    }
  }

  private register(source: LibrarySource): void {
    this.byKey.set(source.key, source);
    if (!this.byFqName.has(source.fqNameGuess)) {
      this.byFqName.set(source.fqNameGuess, source);
    }
    const dot = source.fqNameGuess.lastIndexOf('.');
    if (dot > 0) {
      const packageName = source.fqNameGuess.substring(0, dot);
      const inPackage = this.byPackage.get(packageName);
      if (inPackage) {
        if (inPackage.length < 800) {
          inPackage.push(source);
        }
      } else {
        this.byPackage.set(packageName, [source]);
        this.sortedPackages = undefined;
      }
    }
    const list = this.bySimpleName.get(source.simpleName);
    if (list) {
      // Cap the fan-out for names such as `Builder` that appear everywhere.
      if (list.length < 40) {
        list.push(source);
      }
    } else {
      this.bySimpleName.set(source.simpleName, [source]);
    }
  }

  lookupFq(fqName: string): LibrarySource | undefined {
    const direct = this.byFqName.get(fqName);
    if (direct) {
      return direct;
    }
    // Nested types share their outer class's file: a.b.Outer.Inner -> a/b/Outer.kt
    let name = fqName;
    for (let depth = 0; depth < 4; depth++) {
      const cut = name.lastIndexOf('.');
      if (cut <= 0) {
        return undefined;
      }
      name = name.substring(0, cut);
      const found = this.byFqName.get(name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  lookupSimple(name: string): readonly LibrarySource[] {
    return this.bySimpleName.get(name) ?? [];
  }

  /**
   * Every known source file in a package.
   *
   * Kotlin libraries put top-level and extension declarations in files named
   * after nothing in particular - `padding` lives in `Padding.kt`, `let` in
   * `Standard.kt` - so a path-level index cannot find them. Parsing the whole
   * package on first use is what makes Compose, coroutines and the standard
   * library navigable.
   */
  lookupPackage(packageName: string): readonly LibrarySource[] {
    const sources = this.byPackage.get(packageName);
    if (!sources) {
      return [];
    }
    // Kotlin first: those are the files that can hold declarations whose name
    // does not match the file name.
    return [...sources].sort((a, b) => (a.language === b.language ? 0 : a.language === 'kotlin' ? -1 : 1));
  }

  /** All indexed files whose package matches, used to resolve star imports. */
  lookupInPackage(packageName: string, simpleName: string): LibrarySource | undefined {
    return this.byFqName.get(`${packageName}.${simpleName}`);
  }

  /**
   * Sources in `packageName` and every package nested under it.
   *
   * Package names are kept sorted so the sub-tree is a contiguous range found
   * by binary search - scanning the whole map here was, at one point, most of
   * the extension's CPU time.
   */
  lookupPackageTree(packageName: string, limit: number): LibrarySource[] {
    const packages = this.packagesSorted();
    let low = lowerBound(packages, packageName);
    const upper = `${packageName}.\uffff`;
    const out: LibrarySource[] = [];
    for (let i = low; i < packages.length && packages[i] <= upper; i++) {
      const pkg = packages[i];
      if (pkg !== packageName && !pkg.startsWith(`${packageName}.`)) {
        continue;
      }
      for (const source of this.byPackage.get(pkg) ?? []) {
        if (source.language === 'kotlin') {
          out.push(source);
        }
      }
      if (out.length >= limit * 2) {
        break;
      }
    }
    // Shallower packages first - that is where a library's own top-level
    // declarations almost always live.
    out.sort((a, b) => a.fqNameGuess.split('.').length - b.fqNameGuess.split('.').length);
    return out.slice(0, limit);
  }

  private packagesSorted(): string[] {
    if (!this.sortedPackages) {
      this.sortedPackages = [...this.byPackage.keys()].sort();
    }
    return this.sortedPackages;
  }

  getSource(source: LibrarySource): string | undefined {
    const cached = this.sourceText.get(source.key);
    if (cached !== undefined) {
      return cached;
    }
    let text: string | undefined;
    try {
      if (source.jarPath && source.entry) {
        text = readZipEntry(source.jarPath, source.entry);
      } else if (source.filePath) {
        text = fs.readFileSync(source.filePath, 'utf8');
      }
    } catch (error) {
      logError(`could not read library source ${source.key}`, error);
      return undefined;
    }
    if (text !== undefined) {
      if (this.sourceText.size > 400) {
        const oldest = this.sourceText.keys().next().value;
        if (oldest !== undefined) {
          this.sourceText.delete(oldest);
        }
      }
      this.sourceText.set(source.key, text);
    }
    return text;
  }

  getParsed(source: LibrarySource): ParsedFile | undefined {
    const cached = this.parsed.get(source.key);
    if (cached) {
      return cached;
    }
    const text = this.getSource(source);
    if (text === undefined) {
      return undefined;
    }
    const parsed = source.language === 'kotlin' ? parseKotlin(source.key, text) : parseJava(source.key, text);
    this.parsed.set(source.key, parsed);
    return parsed;
  }

  bySourceKey(key: string): LibrarySource | undefined {
    return this.byKey.get(key);
  }

  /** Keys that have been parsed, so callers can fold them into the symbol index. */
  parsedKeys(): IterableIterator<string> {
    return this.parsed.keys();
  }
}

/** First index whose value is >= `target`. */
function lowerBound(sorted: string[], target: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Multiplatform source-set roots such as `commonMain` or `androidMain`.
 *
 * Deliberately narrow: `java` and `kotlin` are *not* stripped on their own,
 * because `java/util/concurrent/TimeUnit.java` is a package path, not a build
 * directory. They are only skipped as part of an explicit `src/<variant>/java`
 * prefix.
 */
const SOURCE_SET_PATTERN = /^[a-z][A-Za-z0-9]*(Main|Test)$/;
const SOURCE_ROOT_SEGMENTS = new Set(['java', 'kotlin']);

/** Platform suffixes Kotlin multiplatform adds before the extension. */
const PLATFORM_SUFFIXES = new Set([
  'android', 'jvm', 'common', 'js', 'native', 'ios', 'desktop', 'linux',
  'macos', 'mingw', 'apple', 'wasm', 'skiko', 'nonJvm',
]);

export function splitEntryPath(entryName: string): { dirs: string[]; simpleName: string } {
  const parts = entryName.split('/').filter((p) => p.length > 0);
  const fileName = parts.pop() ?? '';
  while (parts.length > 0) {
    const head = parts[0];
    if (SOURCE_SET_PATTERN.test(head)) {
      parts.shift();
      continue;
    }
    if (head === 'src') {
      parts.shift();
      // `src/main/java`, `src/debug/kotlin`, or just `src/java`.
      if (parts.length > 0 && !SOURCE_ROOT_SEGMENTS.has(parts[0])) {
        parts.shift();
      }
      if (parts.length > 0 && SOURCE_ROOT_SEGMENTS.has(parts[0])) {
        parts.shift();
      }
      continue;
    }
    break;
  }
  let simpleName = fileName.replace(/\.(kt|java)$/, '');
  const suffixDot = simpleName.lastIndexOf('.');
  if (suffixDot > 0 && PLATFORM_SUFFIXES.has(simpleName.substring(suffixDot + 1))) {
    simpleName = simpleName.substring(0, suffixDot);
  }
  return { dirs: parts, simpleName };
}

/** First `package` declaration in a Kotlin or Java source file. */
export function readPackageDeclaration(text: string): string | undefined {
  const match = /^[\t ]*package[\t ]+([A-Za-z_$][\w$]*(?:[\t ]*\.[\t ]*[A-Za-z_$][\w$]*)*)/m.exec(
    text.substring(0, 8000),
  );
  return match ? match[1].replace(/[\t ]/g, '') : undefined;
}

/** Entries spread across the archive, so a sample is representative. */
function pickSamples(entries: ZipEntry[], count: number): ZipEntry[] {
  if (entries.length <= count) {
    return entries;
  }
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push(entries[Math.floor((entries.length * i) / count)]);
  }
  return out;
}

export function makeJarKey(jarPath: string, entryName: string): string {
  return `${LIB_SCHEME}://jar/${entryName}?jar=${encodeURIComponent(jarPath)}`;
}

export function isLibraryKey(file: string): boolean {
  return file.startsWith(`${LIB_SCHEME}://`);
}

export function parseJarKey(key: string): { jarPath: string; entryName: string } | undefined {
  if (!isLibraryKey(key)) {
    return undefined;
  }
  const queryIndex = key.indexOf('?jar=');
  if (queryIndex < 0) {
    return undefined;
  }
  const entryName = key.substring(`${LIB_SCHEME}://jar/`.length, queryIndex);
  const jarPath = decodeURIComponent(key.substring(queryIndex + 5));
  return { jarPath, entryName };
}

/** Default places to look for library sources on this machine. */
export function defaultLibraryRoots(options: {
  extraDirs: string[];
  androidSdkPath?: string;
  includeJars: boolean;
  includeAndroidSdk: boolean;
  compileSdkVersions: number[];
}): LibraryRoot[] {
  const roots: LibraryRoot[] = [];
  const home = os.homedir();

  if (options.includeJars) {
    const candidates = [
      process.env.GRADLE_USER_HOME ? path.join(process.env.GRADLE_USER_HOME, 'caches', 'modules-2') : undefined,
      path.join(home, '.gradle', 'caches', 'modules-2'),
      path.join(home, '.m2', 'repository'),
      ...options.extraDirs,
    ].filter((d): d is string => !!d);
    for (const dir of candidates) {
      if (statSafe(dir)?.isDirectory()) {
        roots.push({ dir, kind: 'jars', label: path.basename(dir) });
      }
    }
  }

  if (options.includeAndroidSdk) {
    const sdk = resolveAndroidSdk(options.androidSdkPath);
    if (sdk) {
      const sourcesRoot = path.join(sdk, 'sources');
      const available = listAndroidSourceDirs(sourcesRoot);
      // Prefer the SDK levels the project actually compiles against; fall back
      // to the newest installed.
      const wanted = options.compileSdkVersions.filter((v) => available.includes(v));
      const chosen = wanted.length > 0 ? wanted : available.slice(-1);
      for (const level of chosen) {
        roots.push({ dir: path.join(sourcesRoot, `android-${level}`), kind: 'sources', label: `android-${level}` });
      }
    }
  }

  return roots;
}

export function resolveAndroidSdk(configured?: string): string | undefined {
  const candidates = [
    configured,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter((d): d is string => !!d);
  for (const dir of candidates) {
    if (statSafe(dir)?.isDirectory()) {
      return dir;
    }
  }
  return undefined;
}

function listAndroidSourceDirs(sourcesRoot: string): number[] {
  try {
    return fs
      .readdirSync(sourcesRoot)
      .map((name) => /^android-(\d+)$/.exec(name))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
