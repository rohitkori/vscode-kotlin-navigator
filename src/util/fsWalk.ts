import * as fs from 'fs';
import * as path from 'path';

export interface WalkOptions {
  /** Directory names skipped wholesale, matched case-sensitively. */
  skipDirs?: ReadonlySet<string>;
  /** Called for every file whose extension is in `extensions`. */
  extensions?: ReadonlySet<string>;
  maxFiles?: number;
  /** Maximum directory levels below `root` to descend into. */
  maxDepth?: number;
  /** Return false to skip a directory. */
  shouldEnter?: (dir: string) => boolean;
}

const DEFAULT_SKIP = new Set([
  '.git', '.gradle', '.idea', 'node_modules', '.svn', '.hg', '.cxx',
  'DerivedData', '.dart_tool', 'Pods', '.next', '.venv', '__pycache__',
]);

/** Iterative recursive walk; avoids blowing the stack on deep source trees. */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const skip = options.skipDirs ?? DEFAULT_SKIP;
  const exts = options.extensions;
  const maxFiles = options.maxFiles ?? Number.MAX_SAFE_INTEGER;
  const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && out.length < maxFiles) {
    const { dir, depth } = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) {
          continue;
        }
        if (options.shouldEnter && !options.shouldEnter(full)) {
          continue;
        }
        if (depth < maxDepth) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        if (!exts || exts.has(path.extname(entry.name))) {
          out.push(full);
          if (out.length >= maxFiles) {
            break;
          }
        }
      }
    }
  }
  return out;
}

export function statSafe(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

export function readFileSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
