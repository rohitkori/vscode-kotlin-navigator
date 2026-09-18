import * as fs from 'fs';
import * as path from 'path';
import { readFileSafe, statSafe, walkFiles } from '../util/fsWalk';
import { log } from '../util/log';

/** Resource folder names whose files are themselves the resource. */
const FILE_RESOURCE_TYPES = new Set([
  'layout', 'drawable', 'mipmap', 'menu', 'anim', 'animator', 'xml', 'raw',
  'font', 'navigation', 'transition', 'interpolator', 'color',
]);

/** Tags inside `res/values` that declare a resource named by `name=`. */
const VALUE_TAGS: Record<string, string> = {
  string: 'string',
  color: 'color',
  dimen: 'dimen',
  integer: 'integer',
  bool: 'bool',
  fraction: 'fraction',
  style: 'style',
  array: 'array',
  'string-array': 'array',
  'integer-array': 'array',
  plurals: 'plurals',
  attr: 'attr',
  'declare-styleable': 'styleable',
  'font-family': 'font',
};

export interface ResourceEntry {
  type: string;
  name: string;
  file: string;
  /** Offset to jump to inside `file`. */
  offset: number;
  length: number;
}

export interface BindingView {
  /** The generated binding field name, e.g. `addCp` for `@+id/add_cp`. */
  field: string;
  id: string;
  entry: ResourceEntry;
}

/**
 * Knows about `res/` so that `R.layout.foo`, `R.string.bar`, `@color/baz` and
 * `binding.someView` become real jump targets.
 *
 * Android Studio gets this from the Gradle model; here it is read straight off
 * disk, which is both faster and works with no build at all.
 */
export class ResourceIndex {
  private readonly byTypeName = new Map<string, ResourceEntry[]>();
  /** `ActivityMainBinding` -> the layout file it was generated from. */
  private readonly layoutByBindingClass = new Map<string, string>();
  /** layout file -> binding field name -> the `@+id/...` that produced it. */
  private readonly viewsByLayout = new Map<string, Map<string, BindingView>>();
  private readonly resDirs: string[] = [];
  private fileCount = 0;

  get stats(): { resDirs: number; files: number; resources: number } {
    let resources = 0;
    for (const list of this.byTypeName.values()) {
      resources += list.length;
    }
    return { resDirs: this.resDirs.length, files: this.fileCount, resources };
  }

  clear(): void {
    this.byTypeName.clear();
    this.layoutByBindingClass.clear();
    this.viewsByLayout.clear();
    this.resDirs.length = 0;
    this.fileCount = 0;
  }

  /** Finds every `res/` directory under a workspace folder. */
  static findResourceDirs(root: string): string[] {
    const out: string[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.pop()!;
      if (depth > 8) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const name = entry.name;
        if (name === 'node_modules' || name === '.git' || name === 'build' || name === '.gradle' || name === '.idea') {
          continue;
        }
        const full = path.join(dir, name);
        if (name === 'res' && looksLikeResourceDir(full)) {
          out.push(full);
          continue;
        }
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
    return out;
  }

  build(roots: string[]): void {
    const started = Date.now();
    this.clear();
    for (const root of roots) {
      for (const dir of ResourceIndex.findResourceDirs(root)) {
        this.resDirs.push(dir);
        this.indexResourceDir(dir);
      }
    }
    log(
      `resource index ready: ${this.resDirs.length} res directories, ${this.fileCount} files, ` +
        `${this.stats.resources} resources (${Date.now() - started}ms)`,
    );
  }

  private indexResourceDir(resDir: string): void {
    let folders: fs.Dirent[];
    try {
      folders = fs.readdirSync(resDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const folder of folders) {
      if (!folder.isDirectory()) {
        continue;
      }
      // `layout-land` and `values-night` declare the same resources as their
      // unqualified counterparts.
      const resType = folder.name.split('-')[0];
      const folderPath = path.join(resDir, folder.name);
      const files = walkFiles(folderPath, { maxDepth: 2 });
      for (const file of files) {
        this.fileCount++;
        const extension = path.extname(file);
        const baseName = path.basename(file, extension);

        if (FILE_RESOURCE_TYPES.has(resType)) {
          this.add({ type: resType, name: baseName, file, offset: 0, length: 0 });
          if (resType === 'layout') {
            this.layoutByBindingClass.set(bindingClassName(baseName), file);
          }
        }
        if (extension === '.xml') {
          const text = readFileSafe(file);
          if (text !== undefined) {
            if (resType === 'values') {
              this.indexValuesFile(file, text);
            }
            this.indexIds(file, text, resType === 'layout');
          }
        }
      }
    }
  }

  private indexValuesFile(file: string, text: string): void {
    const tagPattern = /<\s*([A-Za-z][\w-]*)([^>]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(text)) !== null) {
      const tag = match[1];
      const attributes = match[2];
      const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(attributes);
      if (!nameMatch) {
        continue;
      }
      const nameOffset = match.index + match[1].length + 1 + (nameMatch.index ?? 0) + nameMatch[0].indexOf('"') + 1;

      let type = VALUE_TAGS[tag];
      if (tag === 'item') {
        const typeMatch = /\btype\s*=\s*"([^"]+)"/.exec(attributes);
        type = typeMatch ? typeMatch[1] : '';
      }
      if (!type) {
        continue;
      }
      this.add({ type, name: nameMatch[1], file, offset: nameOffset, length: nameMatch[1].length });
    }
  }

  /** `@+id/foo` declares `R.id.foo`, and in a layout also a binding field. */
  private indexIds(file: string, text: string, isLayout: boolean): void {
    const pattern = /@\+id\/([A-Za-z_][\w.]*)/g;
    let match: RegExpExecArray | null;
    let views: Map<string, BindingView> | undefined;
    while ((match = pattern.exec(text)) !== null) {
      const id = match[1];
      const offset = match.index + match[0].length - id.length;
      const entry: ResourceEntry = { type: 'id', name: id, file, offset, length: id.length };
      this.add(entry);
      if (isLayout) {
        views ??= this.viewsByLayout.get(file) ?? new Map<string, BindingView>();
        const field = bindingFieldName(id);
        if (!views.has(field)) {
          views.set(field, { field, id, entry });
        }
      }
    }
    if (views) {
      this.viewsByLayout.set(file, views);
    }
  }

  private add(entry: ResourceEntry): void {
    const key = `${entry.type}/${entry.name}`;
    const list = this.byTypeName.get(key);
    if (list) {
      if (!list.some((e) => e.file === entry.file && e.offset === entry.offset)) {
        list.push(entry);
      }
    } else {
      this.byTypeName.set(key, [entry]);
    }
  }

  lookup(type: string, name: string): readonly ResourceEntry[] {
    return this.byTypeName.get(`${type}/${name}`) ?? [];
  }

  hasType(type: string): boolean {
    for (const key of this.byTypeName.keys()) {
      if (key.startsWith(`${type}/`)) {
        return true;
      }
    }
    return false;
  }

  /** Every layout file declaring a view whose binding field has this name. */
  lookupBindingField(bindingClass: string, field: string): ResourceEntry[] {
    const layout = this.layoutByBindingClass.get(bindingClass);
    const out: ResourceEntry[] = [];
    if (layout) {
      const view = this.viewsByLayout.get(layout)?.get(field);
      if (view) {
        out.push(view.entry);
      }
      // `layout-land/foo.xml` declares the same ids in a different file.
      for (const [file, views] of this.viewsByLayout) {
        if (file !== layout && path.basename(file) === path.basename(layout)) {
          const alternate = views.get(field);
          if (alternate) {
            out.push(alternate.entry);
          }
        }
      }
    }
    return out;
  }

  layoutForBindingClass(bindingClass: string): string | undefined {
    return this.layoutByBindingClass.get(bindingClass);
  }

  isKnownResourceType(type: string): boolean {
    return FILE_RESOURCE_TYPES.has(type) || Object.values(VALUE_TAGS).includes(type) || type === 'id';
  }
}

function looksLikeResourceDir(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && (e.name.startsWith('values') || e.name.startsWith('layout') || e.name.startsWith('drawable')));
  } catch {
    return false;
  }
}

/** `fragment_project_list` -> `FragmentProjectListBinding`. */
export function bindingClassName(layoutName: string): string {
  return `${layoutName
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.substring(1))
    .join('')}Binding`;
}

/** `add_cp` -> `addCp`, matching what ViewBinding generates. */
export function bindingFieldName(id: string): string {
  const parts = id.split('_').filter((part) => part.length > 0);
  if (parts.length === 0) {
    return id;
  }
  return parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.substring(1)).join('');
}

export function isResourceDirectory(file: string): boolean {
  const normalized = file.split(path.sep).join('/');
  return /\/res\/[^/]+\/[^/]+$/.test(normalized) && statSafe(file) !== undefined;
}
