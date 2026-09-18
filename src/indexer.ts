import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NavigatorConfig } from './config';
import { IndexService } from './index/indexService';
import { defaultLibraryRoots, LibraryRoot } from './index/libraryIndex';
import { discoverSourceFiles, originForFile, parseSource } from './index/sourceScanner';
import { ResourceIndex } from './android/resourceIndex';
import { readFileSafe, statSafe } from './util/fsWalk';
import { log, logError } from './util/log';

/** Packages worth having ready before the first click, whatever the project. */
const WARM_PACKAGES = ['kotlin', 'kotlin.collections', 'kotlin.text', 'kotlinx.coroutines'];

/** How many of the workspace's most-imported packages to pre-parse. */
const WARM_IMPORTED_PACKAGES = 60;

/** Time budget for warm-up; it is a nicety, not a correctness requirement. */
const WARM_BUDGET_MS = 6000;

const YIELD_EVERY = 40;

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Drives indexing in small batches so the extension host stays responsive.
 * Everything here is incremental: re-running it only re-parses what changed.
 */
export class Indexer {
  private generation = 0;
  private running = false;

  constructor(
    private readonly service: IndexService,
    private readonly resources: ResourceIndex,
    private readonly config: () => NavigatorConfig,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  cancel(): void {
    this.generation++;
  }

  async rebuild(reason: string): Promise<void> {
    this.cancel();
    const generation = ++this.generation;
    const cancelled = (): boolean => generation !== this.generation;
    this.running = true;
    const started = Date.now();

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Kotlin Navigator: indexing' },
        async (progress) => {
          const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
          const config = this.config();

          // 1. Workspace sources - the ones the user is actually editing.
          progress.report({ message: 'scanning sources' });
          const files: string[] = [];
          for (const root of roots) {
            files.push(
              ...discoverSourceFiles(root, {
                includeGenerated: config.indexGeneratedSources,
                excludeGlobs: config.excludeGlobs,
              }),
            );
          }
          log(`indexing ${files.length} workspace source files (${reason})`);
          let done = 0;
          for (const file of files) {
            if (cancelled()) {
              return;
            }
            this.indexOne(file);
            if (++done % YIELD_EVERY === 0) {
              progress.report({ message: `sources ${done}/${files.length}` });
              await yieldToHost();
            }
          }
          log(`workspace index: ${this.service.symbols.size} files (${Date.now() - started}ms)`);

          // 2. Android resources - cheap, and needed for R.* and bindings.
          if (config.androidResources) {
            progress.report({ message: 'scanning resources' });
            await yieldToHost();
            this.resources.build(roots);
          }

          // 3. Library sources. Only the jar directories are read here; the
          //    files inside are parsed the first time someone navigates in.
          if (config.indexLibrarySources || config.indexAndroidSdkSources) {
            progress.report({ message: 'scanning library sources' });
            await yieldToHost();
            const libraryRoots = defaultLibraryRoots({
              extraDirs: config.gradleCachePaths,
              androidSdkPath: config.androidSdkPath || undefined,
              includeJars: config.indexLibrarySources,
              includeAndroidSdk: config.indexAndroidSdkSources,
              compileSdkVersions: detectCompileSdkVersions(roots),
            });
            await this.buildLibraryIndex(libraryRoots, cancelled, progress);
          }

          if (cancelled()) {
            return;
          }
          // Parsing a library package happens on first use, which would
          // otherwise land on whoever opens the first file - as a pause before
          // the syntax colours appear. Doing it here moves that cost into
          // start-up, where nothing is waiting on it.
          progress.report({ message: 'warming up' });
          await yieldToHost();
          const warmStarted = Date.now();
          let warmed = 0;
          for (const packageName of [...WARM_PACKAGES, ...this.mostImportedPackages(WARM_IMPORTED_PACKAGES)]) {
            if (cancelled() || Date.now() - warmStarted > WARM_BUDGET_MS) {
              break;
            }
            if (this.service.ensurePackageParsed(packageName)) {
              warmed++;
            }
            if (warmed % 4 === 0) {
              await yieldToHost();
            }
          }
          // The Kotlin standard library files its sources by concern rather than
          // by package, so reaching `kotlin.let` means widening to the sub-tree.
          // Every Kotlin file needs it, so pay for it here, once.
          if (!cancelled()) {
            this.service.ensurePackageTreeParsed('kotlin');
            await yieldToHost();
          }
          log(`warmed ${warmed} library packages in ${Date.now() - warmStarted}ms`);
          log(`index ready in ${Date.now() - started}ms`);
        },
      );
    } catch (error) {
      logError('indexing failed', error);
    } finally {
      if (generation === this.generation) {
        this.running = false;
      }
    }
  }

  private async buildLibraryIndex(
    roots: LibraryRoot[],
    cancelled: () => boolean,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    this.service.libraries.clear();
    for (const root of roots) {
      if (cancelled()) {
        return;
      }
      if (root.kind === 'sources') {
        progress.report({ message: `scanning ${root.label}` });
        await yieldToHost();
        this.service.libraries.indexSourceDirectory(root.dir, root.label);
      }
    }
    const jars = this.service.libraries.collectSourceJars(roots);
    log(`found ${jars.length} sources jars`);
    let done = 0;
    for (const jar of jars) {
      if (cancelled()) {
        return;
      }
      this.service.libraries.indexJar(jar);
      if (++done % 25 === 0) {
        progress.report({ message: `library sources ${done}/${jars.length}` });
        await yieldToHost();
      }
    }
    this.service.libraries.markReady();
  }

  /**
   * Packages the workspace imports from, most used first. A project's own
   * dependencies are exactly the library code its developers navigate into.
   */
  private mostImportedPackages(limit: number): string[] {
    const counts = new Map<string, number>();
    for (const indexed of this.service.symbols.allFiles()) {
      if (indexed.origin === 'library') {
        continue;
      }
      for (const entry of indexed.parsed.imports) {
        const packageName = entry.isStar ? entry.fqName : entry.fqName.substring(0, entry.fqName.lastIndexOf('.'));
        if (packageName) {
          counts.set(packageName, (counts.get(packageName) ?? 0) + 1);
        }
      }
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([packageName]) => packageName);
  }

  /** Re-index a single file, e.g. after it was saved or created. */
  indexOne(file: string): boolean {
    const stats = statSafe(file);
    if (!stats) {
      this.service.removeFile(file);
      return false;
    }
    const existing = this.service.symbols.getFile(file);
    if (existing && existing.version === stats.mtimeMs) {
      return false;
    }
    const text = readFileSafe(file);
    if (text === undefined || text.length > 4_000_000) {
      return false;
    }
    const parsed = parseSource(file, text);
    if (!parsed) {
      return false;
    }
    this.service.setWorkspaceFile(parsed, originForFile(file), stats.mtimeMs);
    return true;
  }

  /** Index the in-memory contents of a document that has unsaved changes. */
  indexDocument(document: vscode.TextDocument, key: string): void {
    const text = document.getText();
    const parsed = parseSource(key, text);
    if (parsed) {
      this.service.setWorkspaceFile(parsed, originForFile(key), -document.version);
    }
  }
}

/**
 * `compileSdk 36` in any build file tells us which Android SDK sources are
 * worth indexing; without it the newest installed platform is used.
 */
function detectCompileSdkVersions(roots: string[]): number[] {
  const versions = new Set<number>();
  for (const root of roots) {
    for (const name of ['app/build.gradle', 'app/build.gradle.kts', 'build.gradle', 'build.gradle.kts']) {
      const file = path.join(root, name);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const pattern = /compileSdk(?:Version)?\s*[= (]\s*"?(\d{2})"?/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        versions.add(Number(match[1]));
      }
    }
  }
  return [...versions].sort((a, b) => b - a);
}
