import * as path from 'path';
import { ParsedFile } from '../parser/types';
import { parseJava } from '../parser/java';
import { parseKotlin } from '../parser/kotlin';
import { readFileSafe, statSafe, walkFiles } from '../util/fsWalk';
import { Origin } from './symbolIndex';
import { IndexService } from './indexService';

export const SOURCE_EXTENSIONS = new Set(['.kt', '.kts', '.java']);

export interface ScanOptions {
  /** Index `build/generated`, where ViewBinding/SafeArgs/Room/KSP output lands. */
  includeGenerated: boolean;
  /** Glob-ish patterns; `**` matches any depth, `*` any run of non-separators. */
  excludeGlobs: string[];
  maxFiles?: number;
}

/** Finds the source files worth indexing under a workspace folder. */
export function discoverSourceFiles(root: string, options: ScanOptions): string[] {
  const excludes = options.excludeGlobs.map(globToRegExp);
  const files = walkFiles(root, {
    extensions: SOURCE_EXTENSIONS,
    maxFiles: options.maxFiles ?? 200000,
    shouldEnter: (dir) => shouldEnterDirectory(root, dir, options.includeGenerated),
  });
  if (excludes.length === 0) {
    return files;
  }
  return files.filter((file) => {
    const normalized = file.split(path.sep).join('/');
    return !excludes.some((re) => re.test(normalized));
  });
}

/**
 * Build output is skipped except for `build/generated`, which is where the
 * Android plugins put the classes people most often need to jump into:
 * `*Binding`, `*Directions`, `*Args`, `BuildConfig`, Room and KSP output.
 */
function shouldEnterDirectory(root: string, dir: string, includeGenerated: boolean): boolean {
  const relative = path.relative(root, dir);
  const segments = relative.split(path.sep);
  const buildIndex = segments.findIndex((s) => s === 'build' || s === 'out' || s === 'bin');
  if (buildIndex < 0) {
    return true;
  }
  if (!includeGenerated) {
    return false;
  }
  const next = segments[buildIndex + 1];
  if (next === undefined) {
    return true;
  }
  if (next !== 'generated') {
    return false;
  }
  const third = segments[buildIndex + 2];
  return third === undefined || (third !== 'res' && third !== 'assets' && third !== 'renderscript');
}

export function parseSource(file: string, text: string): ParsedFile | undefined {
  if (file.endsWith('.kt') || file.endsWith('.kts')) {
    return parseKotlin(file, text);
  }
  if (file.endsWith('.java')) {
    return parseJava(file, text);
  }
  return undefined;
}

export function originForFile(file: string): Origin {
  const normalized = file.split(path.sep).join('/');
  return /\/(build|out|bin)\//.test(normalized) ? 'generated' : 'workspace';
}

export interface IndexFilesResult {
  indexed: number;
  skipped: number;
  elapsedMs: number;
}

/** Parses and indexes files that changed since the last pass. */
export function indexFilesSync(
  service: IndexService,
  files: string[],
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): IndexFilesResult {
  const started = Date.now();
  let indexed = 0;
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    if (shouldCancel?.()) {
      break;
    }
    const file = files[i];
    const stats = statSafe(file);
    if (!stats) {
      skipped++;
      continue;
    }
    const existing = service.symbols.getFile(file);
    if (existing && existing.version === stats.mtimeMs) {
      skipped++;
      continue;
    }
    const text = readFileSafe(file);
    if (text === undefined || text.length > 4_000_000) {
      skipped++;
      continue;
    }
    const parsed = parseSource(file, text);
    if (!parsed) {
      skipped++;
      continue;
    }
    service.setWorkspaceFile(parsed, originForFile(file), stats.mtimeMs);
    indexed++;
    if (onProgress && i % 200 === 0) {
      onProgress(i, files.length);
    }
  }
  return { indexed, skipped, elapsedMs: Date.now() - started };
}

const DOUBLE_STAR_SLASH = 'KNAVDSS';
const DOUBLE_STAR = 'KNAVDS';

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DOUBLE_STAR_SLASH)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(DOUBLE_STAR_SLASH)
    .join('(?:.*/)?')
    .split(DOUBLE_STAR)
    .join('.*');
  return new RegExp(`^${escaped}$`);
}
