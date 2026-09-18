import { IndexService } from '../src/index/indexService';
import { parseKotlin } from '../src/parser/kotlin';
import { parseJava } from '../src/parser/java';
import { Resolver, ResolveInput } from '../src/resolve/resolver';
import { maskSource } from '../src/util/text';

export interface TestFile {
  name: string;
  content: string;
}

/** Marks the cursor in a fixture. */
export const CURSOR = '/*^*/';

export class TestWorkspace {
  readonly service = new IndexService();
  readonly resolver = new Resolver(this.service);
  private readonly sources = new Map<string, string>();

  add(name: string, content: string): void {
    const clean = content.split(CURSOR).join('');
    this.sources.set(name, clean);
    const parsed = name.endsWith('.java') ? parseJava(name, clean) : parseKotlin(name, clean);
    this.service.setWorkspaceFile(parsed, name.includes('/build/') ? 'generated' : 'workspace', 1);
  }

  /** Resolves at the `/*^*\/` marker in the named file's original text. */
  resolveAt(name: string, markedContent: string): ReturnType<Resolver['resolve']> {
    const offset = markedContent.indexOf(CURSOR);
    if (offset < 0) {
      throw new Error(`no ${CURSOR} marker in fixture ${name}`);
    }
    return this.resolver.resolve(this.inputAt(name, offset));
  }

  inputAt(name: string, offset: number): ResolveInput {
    const raw = this.sources.get(name);
    if (raw === undefined) {
      throw new Error(`unknown fixture ${name}`);
    }
    const parsed = this.service.getParsed(name);
    if (!parsed) {
      throw new Error(`fixture ${name} was not indexed`);
    }
    const { masked, kinds } = maskSource(raw, { templates: !name.endsWith('.java') });
    return { file: name, raw, masked, kinds, parsed, offset };
  }

  text(name: string): string {
    return this.sources.get(name) ?? '';
  }
}

// ---------------------------------------------------------------------------
// A very small test runner - enough structure to keep failures readable.
// ---------------------------------------------------------------------------

interface Failure {
  suite: string;
  test: string;
  message: string;
}

const failures: Failure[] = [];
let currentSuite = '';
let passed = 0;

export function suite(name: string, body: () => void): void {
  currentSuite = name;
  body();
  currentSuite = '';
}

export function test(name: string, body: () => void): void {
  try {
    body();
    passed++;
  } catch (error) {
    failures.push({
      suite: currentSuite,
      test: name,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function report(): number {
  if (failures.length === 0) {
    console.log(`\n${passed} tests passed.`);
    return 0;
  }
  console.log(`\n${passed} passed, ${failures.length} failed:\n`);
  for (const failure of failures) {
    console.log(`  x ${failure.suite} > ${failure.test}`);
    console.log(`      ${failure.message}`);
  }
  return 1;
}
