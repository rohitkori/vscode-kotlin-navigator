/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activate } from '../src/extension';
import { CancellationTokenNone, MockTextDocument, Position, registry, Uri } from './vscodeMock';
import { assert, assertEqual, suite, test } from './harness';

/** A miniature Android module on disk, so the real file walkers run. */
function createFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-navigator-'));
  const write = (relative: string, content: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  write('app/build.gradle', 'android {\n  compileSdk 34\n}\n');
  write(
    'app/src/main/java/com/demo/Repo.kt',
    `package com.demo

open class Repo {
    fun load(): String = "data"
}

object Config {
    const val BASE_URL = "https://example.com"
}
`,
  );
  write(
    'app/src/main/java/com/demo/MainActivity.kt',
    `package com.demo

import com.demo.databinding.ActivityMainBinding

class MainActivity : Repo() {
    private val binding = ActivityMainBinding.inflate(layoutInflater)

    fun start() {
        val url = Config.BASE_URL
        load()
        binding.submitButton
        setContentView(R.layout.activity_main)
        title = getString(R.string.app_title)
    }
}
`,
  );
  write(
    'app/build/generated/data_binding_base_class_source_out/debug/out/com/demo/databinding/ActivityMainBinding.java',
    `package com.demo.databinding;

public class ActivityMainBinding {
    public Button submitButton;
    public static ActivityMainBinding inflate(LayoutInflater inflater) { return null; }
}
`,
  );
  write(
    'app/src/main/res/layout/activity_main.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    tools:context=".MainActivity">
    <Button android:id="@+id/submit_button" android:text="@string/app_title" />
</LinearLayout>
`,
  );
  write(
    'app/src/main/res/values/strings.xml',
    `<resources>
    <string name="app_title">Demo</string>
</resources>
`,
  );
  return root;
}

function documentFor(file: string): MockTextDocument {
  return new MockTextDocument(Uri.file(file), fs.readFileSync(file, 'utf8'));
}

function positionOf(document: MockTextDocument, needle: string, occurrence = 0): Position {
  const text = document.getText();
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
  }
  if (index < 0) {
    throw new Error(`"${needle}" not found in fixture`);
  }
  return document.positionAt(index);
}

export async function run(): Promise<void> {
  const root = createFixtureProject();
  registry.reset();
  registry.workspaceRoots = [root];
  // Library indexing is slow and machine dependent; this fixture exercises the
  // workspace, generated-source and resource paths.
  registry.configuration = { indexLibrarySources: false, indexAndroidSdkSources: false };

  const subscriptions: any[] = [];
  activate({ subscriptions } as any);
  // `activate` kicks indexing off without blocking; let it finish.
  await new Promise((resolve) => setTimeout(resolve, 600));

  const mainFile = path.join(root, 'app/src/main/java/com/demo/MainActivity.kt');
  const document = documentFor(mainFile);
  const definitionProvider = registry.definition[0];
  const define = (needle: string, occurrence = 0) =>
    definitionProvider.provideDefinition(document as any, positionOf(document, needle, occurrence), CancellationTokenNone);

  suite('integration (mock editor)', () => {
    test('registers every provider the manifest promises', () => {
      assertEqual(registry.definition.length, 1, 'one source definition provider');
      assertEqual(registry.xmlDefinition.length, 1, 'one xml definition provider');
      assertEqual(registry.reference.length, 1);
      assertEqual(registry.documentSymbol.length, 1);
      assertEqual(registry.workspaceSymbol.length, 1);
      assertEqual(registry.hover.length, 1);
      assert(registry.contentProviders.has('ktnav'), 'library content provider registered');
      for (const command of [
        'kotlinNavigator.rebuildIndex',
        'kotlinNavigator.showStats',
        'kotlinNavigator.showOutput',
        'kotlinNavigator.clearLibraryCache',
      ]) {
        assert(registry.commands.has(command), `${command} registered`);
      }
    });
  });

  const results = {
    supertype: await define('Repo()'),
    inherited: await define('load()'),
    objectMember: await define('BASE_URL'),
    bindingField: await define('submitButton'),
    layout: await define('activity_main'),
    stringResource: await define('app_title'),
  };

  suite('integration: go to definition', () => {
    test('a supertype in the same package', () => {
      assertEqual(results.supertype?.length, 1);
      assert(results.supertype[0].targetUri.fsPath.endsWith('Repo.kt'), 'lands in Repo.kt');
    });

    test('an inherited function', () => {
      assert(results.inherited?.length >= 1, 'resolved');
      assert(results.inherited[0].targetUri.fsPath.endsWith('Repo.kt'), 'lands on Repo.load');
    });

    test('a member of an object declaration', () => {
      assert(results.objectMember?.length >= 1, 'resolved');
      assert(results.objectMember[0].targetUri.fsPath.endsWith('Repo.kt'), 'lands on Config.BASE_URL');
    });

    test('a ViewBinding field jumps to the layout, not the generated Java', () => {
      assert(results.bindingField?.length >= 1, 'resolved');
      assert(
        results.bindingField[0].targetUri.fsPath.endsWith('activity_main.xml'),
        `expected the layout, got ${results.bindingField[0]?.targetUri.fsPath}`,
      );
    });

    test('R.layout.activity_main opens the layout file', () => {
      assert(results.layout?.length >= 1, 'resolved');
      assert(results.layout[0].targetUri.fsPath.endsWith('activity_main.xml'), 'lands on the layout');
    });

    test('R.string.app_title lands on the string resource', () => {
      assert(results.stringResource?.length >= 1, 'resolved');
      assert(results.stringResource[0].targetUri.fsPath.endsWith('strings.xml'), 'lands in values/strings.xml');
    });
  });

  const outline = registry.documentSymbol[0].provideDocumentSymbols(document as any);
  const hover = registry.hover[0].provideHover(document as any, positionOf(document, 'load()'));
  const workspaceSymbols = await registry.workspaceSymbol[0].provideWorkspaceSymbols('Repo', CancellationTokenNone);
  const references = await registry.reference[0].provideReferences(
    document as any,
    positionOf(document, 'Repo()'),
    { includeDeclaration: true },
    CancellationTokenNone,
  );

  suite('integration: other providers', () => {
    test('the outline nests members under their class', () => {
      assertEqual(outline.length, 1);
      assertEqual(outline[0].name, 'MainActivity');
      assert(
        outline[0].children.some((c: any) => c.name === 'start'),
        'start() appears under MainActivity',
      );
    });

    test('hover shows the resolved signature', () => {
      assert(!!hover, 'hover produced');
      assert(hover.contents.value.includes('load'), 'signature mentions the function');
    });

    test('workspace symbols find the class by name', () => {
      assert(
        workspaceSymbols.some((s: any) => s.name === 'Repo'),
        'Repo listed',
      );
    });

    test('find references reports the declaration and its use', () => {
      const files = references.map((r: any) => path.basename(r.uri.fsPath));
      assert(files.includes('Repo.kt'), 'declaration included');
      assert(files.includes('MainActivity.kt'), 'usage included');
    });
  });

  const xmlFile = path.join(root, 'app/src/main/res/layout/activity_main.xml');
  const xmlDocument = documentFor(xmlFile);
  const xmlString = await registry.xmlDefinition[0].provideDefinition(
    xmlDocument as any,
    positionOf(xmlDocument, 'app_title', 0),
    CancellationTokenNone,
  );
  const xmlContext = await registry.xmlDefinition[0].provideDefinition(
    xmlDocument as any,
    positionOf(xmlDocument, 'MainActivity'),
    CancellationTokenNone,
  );

  suite('integration: xml navigation', () => {
    test('@string/app_title resolves from a layout', () => {
      assert(xmlString?.length >= 1, 'resolved');
      assert(xmlString[0].targetUri.fsPath.endsWith('strings.xml'), 'lands in strings.xml');
    });

    test('tools:context resolves the activity class', () => {
      assert(xmlContext?.length >= 1, 'resolved');
      assert(xmlContext[0].targetUri.fsPath.endsWith('MainActivity.kt'), 'lands on the activity');
    });
  });

  fs.rmSync(root, { recursive: true, force: true });
}
