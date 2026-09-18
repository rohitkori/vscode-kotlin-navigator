/**
 * Measures how much of a real project this extension can actually navigate.
 *
 * Walks every identifier in every Kotlin file, asks the resolver where it goes,
 * and reports the hit rate, the reasons behind the hits, and the names that
 * still fail - which is how the resolution rate got from 78% to 98%.
 *
 *   npm run bench -- /path/to/android-project
 */
import * as fs from 'fs';
import { IndexService } from '../src/index/indexService';
import { discoverSourceFiles, indexFilesSync } from '../src/index/sourceScanner';
import { defaultLibraryRoots } from '../src/index/libraryIndex';
import { Resolver } from '../src/resolve/resolver';
import { ResourceIndex } from '../src/android/resourceIndex';
import { AndroidResolver } from '../src/android/androidResolver';
import { isIdentStart, KIND_CODE, maskSource, readIdentifier } from '../src/util/text';

const KEYWORDS = new Set([
  'package', 'import', 'class', 'interface', 'object', 'fun', 'val', 'var', 'typealias', 'constructor', 'init',
  'if', 'else', 'when', 'for', 'while', 'do', 'return', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
  'is', 'as', 'in', 'out', 'by', 'where', 'this', 'super', 'null', 'true', 'false', 'it', 'get', 'set', 'field',
  'public', 'private', 'protected', 'internal', 'open', 'final', 'abstract', 'sealed', 'override', 'lateinit',
  'const', 'inline', 'noinline', 'crossinline', 'reified', 'vararg', 'suspend', 'tailrec', 'operator', 'infix',
  'external', 'annotation', 'data', 'enum', 'inner', 'companion', 'expect', 'actual', 'value', 'dynamic',
]);

const root = process.argv[2];
if (!root) {
  console.error('usage: npm run bench -- /path/to/project');
  process.exit(2);
}

const service = new IndexService();

let started = Date.now();
const files = discoverSourceFiles(root, { includeGenerated: true, excludeGlobs: [] });
const indexResult = indexFilesSync(service, files);
console.log(`workspace   ${files.length} files indexed in ${indexResult.elapsedMs}ms`);

started = Date.now();
const compileSdk = detectCompileSdk(root);
service.libraries.build(
  defaultLibraryRoots({
    extraDirs: [],
    includeJars: true,
    includeAndroidSdk: true,
    compileSdkVersions: compileSdk,
  }),
  () => false,
);
const libraryStats = service.libraries.stats;
console.log(
  `libraries   ${libraryStats.jars} sources jars, ${libraryStats.entries} source files in ${Date.now() - started}ms`,
);

const resources = new ResourceIndex();
resources.build([root]);
const resolver = new Resolver(service);
const android = new AndroidResolver(resources, resolver, service);

const kotlinFiles = files.filter((f) => f.endsWith('.kt') && !f.includes('/build/'));
const misses = new Map<string, number>();
const reasons = new Map<string, number>();
let attempted = 0;
let resolved = 0;

started = Date.now();
for (const file of kotlinFiles) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = service.getParsed(file);
  if (!parsed) {
    continue;
  }
  const { masked, kinds } = maskSource(raw);
  const declarationOffsets = new Set(parsed.declarations.map((d) => d.nameOffset));
  let i = 0;
  while (i < masked.length) {
    if (kinds[i] !== KIND_CODE || !isIdentStart(masked[i]) || (i > 0 && /[A-Za-z0-9_$]/.test(masked[i - 1]))) {
      i++;
      continue;
    }
    const token = readIdentifier(masked, i);
    if (!token) {
      i++;
      continue;
    }
    i = token.end;
    if (KEYWORDS.has(token.name) || declarationOffsets.has(token.start)) {
      continue;
    }
    // Import and package lines are declarations of intent, not references.
    const lineStart = raw.lastIndexOf('\n', token.start - 1) + 1;
    if (/^(import|package)\s/.test(raw.substring(lineStart, token.start).trimStart())) {
      continue;
    }

    attempted++;
    const input = { file, raw, masked, kinds, parsed, offset: token.start };
    const chain = resolver.referenceAtCursor(input);
    if (chain && android.resolveInSource(input, chain).length > 0) {
      resolved++;
      bump(reasons, 'android resource');
      continue;
    }
    const candidates = resolver.resolve(input);
    if (candidates.length > 0) {
      resolved++;
      bump(reasons, candidates[0].reason);
    } else {
      bump(misses, token.name);
    }
  }
}

const elapsed = Date.now() - started;
console.log(
  `\nresolved    ${resolved}/${attempted} = ${((resolved / attempted) * 100).toFixed(1)}%  ` +
    `(${(elapsed / attempted).toFixed(3)}ms per lookup)\n`,
);

console.log('by reason');
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(count).padStart(6)}  ${reason}`);
}
console.log('\nunresolved names');
for (const [name, count] of [...misses].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(count).padStart(6)}  ${name}`);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function detectCompileSdk(projectRoot: string): number[] {
  for (const name of ['app/build.gradle', 'app/build.gradle.kts', 'build.gradle', 'build.gradle.kts']) {
    try {
      const text = fs.readFileSync(`${projectRoot}/${name}`, 'utf8');
      const match = /compileSdk(?:Version)?\s*[= (]\s*"?(\d{2})"?/.exec(text);
      if (match) {
        return [Number(match[1])];
      }
    } catch {
      // try the next candidate
    }
  }
  return [];
}
