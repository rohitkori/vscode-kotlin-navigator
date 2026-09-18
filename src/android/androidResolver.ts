import * as path from 'path';
import { IndexService } from '../index/indexService';
import { Declaration } from '../parser/types';
import { ReferenceChain } from '../resolve/reference';
import { ResolveInput, Resolver } from '../resolve/resolver';
import { ResourceIndex, bindingFieldName } from './resourceIndex';

export interface ResourceTarget {
  file: string;
  offset: number;
  length: number;
  label: string;
}

/**
 * Navigation for the Android-specific references that no Kotlin language server
 * models: `R.layout.foo`, `binding.someView`, and the `@type/name` and class
 * references inside layout XML.
 */
export class AndroidResolver {
  constructor(
    private readonly resources: ResourceIndex,
    private readonly resolver: Resolver,
    private readonly index: IndexService,
  ) {}

  /** Android-aware targets for a reference in Kotlin or Java source. */
  resolveInSource(input: ResolveInput, chain: ReferenceChain): ResourceTarget[] {
    return this.resolveResourceReference(chain) ?? this.resolveBindingField(input, chain) ?? [];
  }

  /**
   * `R.layout.activity_main`, `android.R.color.white`,
   * `com.example.R.string.title` - the cursor may be on any segment.
   */
  private resolveResourceReference(chain: ReferenceChain): ResourceTarget[] | undefined {
    const names = chain.segments.map((s) => s.name);
    const rIndex = names.lastIndexOf('R');
    if (rIndex < 0 || rIndex + 2 >= names.length) {
      return undefined;
    }
    // Only when the cursor is on the resource name itself; the type segment is
    // not a navigable thing of its own.
    if (chain.targetIndex !== rIndex + 2) {
      return undefined;
    }
    const type = names[rIndex + 1];
    const name = names[rIndex + 2];
    if (!this.resources.isKnownResourceType(type)) {
      return undefined;
    }
    const entries = this.resources.lookup(type, name);
    if (entries.length === 0) {
      return undefined;
    }
    return entries.map((entry) => ({
      file: entry.file,
      offset: entry.offset,
      length: entry.length,
      label: `${type}/${name} - ${path.basename(entry.file)}`,
    }));
  }

  /**
   * `binding.recyclerView` jumps to the `@+id/recycler_view` that generated the
   * field, which is nearly always what the reader wants to see.
   */
  private resolveBindingField(input: ResolveInput, chain: ReferenceChain): ResourceTarget[] | undefined {
    if (chain.targetIndex < 1) {
      return undefined;
    }
    const field = chain.segments[chain.targetIndex].name;
    const types = this.resolver.receiverTypesAt(input, chain);
    for (const type of types) {
      if (!type.name.endsWith('Binding')) {
        continue;
      }
      const entries = this.resources.lookupBindingField(type.name, field);
      if (entries.length > 0) {
        return entries.map((entry) => ({
          file: entry.file,
          offset: entry.offset,
          length: entry.length,
          label: `@+id/${entry.name} - ${path.basename(entry.file)}`,
        }));
      }
    }
    return undefined;
  }

  /**
   * References inside a layout, menu, navigation or values XML file:
   * `@color/white`, `@drawable/ic_back`, custom view tags, `tools:context`,
   * `android:name`, and data-binding `<variable type="...">`.
   */
  resolveInXml(text: string, offset: number, file: string): ResourceTarget[] {
    const resource = resourceReferenceAt(text, offset);
    if (resource) {
      const entries = this.resources.lookup(resource.type, resource.name);
      if (entries.length > 0) {
        return entries
          .filter((entry) => !(entry.file === file && entry.offset === resource.nameStart))
          .map((entry) => ({
            file: entry.file,
            offset: entry.offset,
            length: entry.length,
            label: `${resource.type}/${resource.name} - ${path.basename(entry.file)}`,
          }));
      }
      return [];
    }

    const dotted = dottedNameAt(text, offset);
    if (!dotted) {
      return [];
    }
    const decls = this.resolveClassName(dotted, file);
    return decls.map((decl) => ({
      file: decl.file,
      offset: decl.nameOffset,
      length: decl.nameLength,
      label: decl.fqName,
    }));
  }

  private resolveClassName(name: string, xmlFile: string): Declaration[] {
    if (name.startsWith('.')) {
      // `tools:context=".MainActivity"` is relative to the application id.
      const simple = name.substring(name.lastIndexOf('.') + 1);
      const applicationId = this.applicationIdFor(xmlFile);
      if (applicationId) {
        const qualified = this.index.findByFq(`${applicationId}${name}`);
        if (qualified.length > 0) {
          return qualified;
        }
      }
      return this.index.findBySimple(simple).filter((d) => !d.isLocal);
    }
    if (name.includes('.')) {
      const direct = this.index.findByFq(name);
      if (direct.length > 0) {
        return direct;
      }
    }
    const simple = name.substring(name.lastIndexOf('.') + 1);
    if (!/^[A-Z]/.test(simple)) {
      return [];
    }
    return this.index.findBySimple(simple).filter((d) => !d.isLocal);
  }

  /**
   * Best guess at the module's application id, taken from the package that most
   * of its Kotlin sources declare.
   */
  private applicationIdFor(xmlFile: string): string | undefined {
    const marker = `${path.sep}src${path.sep}`;
    const index = xmlFile.lastIndexOf(marker);
    const moduleRoot = index > 0 ? xmlFile.substring(0, index) : undefined;
    const counts = new Map<string, number>();
    for (const indexed of this.index.symbols.allFiles()) {
      if (indexed.origin !== 'workspace' || !indexed.parsed.packageName) {
        continue;
      }
      if (moduleRoot && !indexed.file.startsWith(moduleRoot)) {
        continue;
      }
      counts.set(indexed.parsed.packageName, (counts.get(indexed.parsed.packageName) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [pkg, count] of counts) {
      // Prefer the shortest package that dominates - that is the app id.
      const score = count / (pkg.split('.').length * pkg.split('.').length);
      if (score > bestCount) {
        bestCount = score;
        best = pkg;
      }
    }
    return best;
  }
}

interface ResourceReference {
  type: string;
  name: string;
  nameStart: number;
  nameEnd: number;
}

/** `@color/white`, `@+id/foo`, `@android:string/ok`, `?attr/colorPrimary`. */
export function resourceReferenceAt(text: string, offset: number): ResourceReference | undefined {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEndRaw = text.indexOf('\n', offset);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const line = text.substring(lineStart, lineEnd);
  const relative = offset - lineStart;

  const pattern = /[@?](\+?)(?:([A-Za-z_][\w.]*):)?([A-Za-z_][\w.]*)\/([A-Za-z_][\w.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (relative < start || relative > end) {
      continue;
    }
    // `@android:string/ok` points into the framework, which has no res dir here.
    if (match[2] === 'android') {
      return undefined;
    }
    const nameStart = lineStart + end - match[4].length;
    return { type: match[3], name: match[4], nameStart, nameEnd: nameStart + match[4].length };
  }
  return undefined;
}

/** The dotted identifier under the cursor, including a leading `.`. */
export function dottedNameAt(text: string, offset: number): string | undefined {
  const isPart = (c: string): boolean => /[A-Za-z0-9_$.]/.test(c);
  if (offset >= text.length || !isPart(text[offset])) {
    if (offset === 0 || !isPart(text[offset - 1])) {
      return undefined;
    }
  }
  let start = offset;
  while (start > 0 && isPart(text[start - 1])) {
    start--;
  }
  let end = offset;
  while (end < text.length && isPart(text[end])) {
    end++;
  }
  const token = text.substring(start, end);
  if (!/^\.?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(token)) {
    return undefined;
  }
  return token.includes('.') ? token : undefined;
}

export { bindingFieldName };
