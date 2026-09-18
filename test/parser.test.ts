import { parseKotlin } from '../src/parser/kotlin';
import { parseJava } from '../src/parser/java';
import { maskSource, KIND_CODE, KIND_COMMENT, KIND_STRING } from '../src/util/text';
import { assert, assertEqual, suite, test } from './harness';

export function run(): void {
  suite('masking', () => {
    test('blanks comments and strings but keeps offsets', () => {
      const source = 'val a = "class X" // class Y\nclass Z';
      const { masked, kinds } = maskSource(source);
      assertEqual(masked.length, source.length, 'length preserved');
      assert(!masked.substring(0, 28).includes('class'), 'class inside string/comment is hidden');
      assert(masked.includes('class Z'), 'real declaration survives');
      assertEqual(kinds[source.indexOf('class X')], KIND_STRING);
      assertEqual(kinds[source.indexOf('class Y')], KIND_COMMENT);
      assertEqual(kinds[source.indexOf('class Z')], KIND_CODE);
    });

    test('keeps string template expressions visible', () => {
      const source = 'val s = "hello ${user.name} and $other"';
      const { masked, kinds } = maskSource(source);
      assert(masked.includes('user.name'), 'template body stays as code');
      assert(masked.includes('other'), 'simple template stays as code');
      assertEqual(kinds[source.indexOf('user')], KIND_CODE);
      assertEqual(kinds[source.indexOf('hello')], KIND_STRING);
    });

    test('handles raw strings and nested block comments', () => {
      const source = 'val r = """\nclass Hidden\n""" /* /* nested */ class AlsoHidden */ class Real';
      const { masked } = maskSource(source);
      assert(!masked.includes('Hidden'), 'raw string contents hidden');
      assert(!masked.includes('AlsoHidden'), 'nested comment fully consumed');
      assert(masked.includes('class Real'), 'code after nested comment survives');
    });
  });

  suite('kotlin parser', () => {
    const source = `package com.example.app

import android.app.Activity
import com.example.other.Helper as Aid
import kotlinx.coroutines.*

/**
 * Docs for Screen.
 */
data class Screen(val title: String, private var count: Int = 0) : Activity(), Named {
    companion object {
        const val TAG = "Screen"
        fun create(): Screen = Screen("x")
    }

    val derived: List<String> get() = listOf(title)

    fun render(items: List<String>, onClick: (String) -> Unit) {
        val local = items.first()
        items.forEach { item -> println(item + local) }
    }

    enum class Mode { LIGHT, DARK }

    class Inner {
        fun ping() {}
    }
}

fun String.shout(): String = uppercase()

typealias Callback = (Int) -> Unit
`;
    const parsed = parseKotlin('Screen.kt', source);
    const byName = (name: string) => parsed.declarations.filter((d) => d.name === name);

    test('reads package and imports including aliases and stars', () => {
      assertEqual(parsed.packageName, 'com.example.app');
      assertEqual(parsed.imports.length, 3);
      assertEqual(parsed.imports[1].alias, 'Aid');
      assertEqual(parsed.imports[2].isStar, true);
      assertEqual(parsed.imports[2].fqName, 'kotlinx.coroutines');
    });

    test('records the class, its supertypes and its doc comment', () => {
      const screen = byName('Screen').find((d) => d.kind === 'class');
      assert(!!screen, 'Screen class found');
      assertEqual(screen!.fqName, 'com.example.app.Screen');
      assertEqual((screen!.supertypes ?? []).join(','), 'Activity,Named');
      assert((screen!.doc ?? '').includes('Docs for Screen'), 'doc comment captured');
    });

    test('primary constructor val/var become properties, plain params do not', () => {
      const title = byName('title')[0];
      assertEqual(title.kind, 'property');
      assertEqual(title.containerFqName, 'com.example.app.Screen');
      assertEqual(title.typeText, 'String');
      assertEqual(byName('count')[0].kind, 'property');
    });

    test('companion objects and their members are nested correctly', () => {
      const tag = byName('TAG')[0];
      assertEqual(tag.containerFqName, 'com.example.app.Screen.Companion');
      const companion = byName('Companion')[0];
      assertEqual(companion.isCompanion, true);
    });

    test('nested classes and enum entries', () => {
      assertEqual(byName('Inner')[0].fqName, 'com.example.app.Screen.Inner');
      assertEqual(byName('ping')[0].containerFqName, 'com.example.app.Screen.Inner');
      assertEqual(byName('LIGHT')[0].kind, 'enumEntry');
      assertEqual(byName('LIGHT')[0].containerFqName, 'com.example.app.Screen.Mode');
    });

    test('locals and lambda parameters are marked local and scoped', () => {
      const local = byName('local')[0];
      assertEqual(local.isLocal, true);
      const item = byName('item')[0];
      assertEqual(item.kind, 'parameter');
      assert(item.scopeStart !== undefined && item.scopeEnd !== undefined, 'lambda parameter is block scoped');
      assert(item.scopeEnd! > item.scopeStart!, 'lambda scope is non-empty');
    });

    test('extension functions record their receiver', () => {
      const shout = byName('shout')[0];
      assertEqual(shout.receiverType, 'String');
      assertEqual(shout.typeText, 'String');
      assertEqual(shout.containerFqName, 'com.example.app');
    });

    test('typealias is indexed', () => {
      assertEqual(byName('Callback')[0].kind, 'typealias');
    });

    test('type parameters are navigable declarations', () => {
      const generic = parseKotlin('G.kt', 'class Box<T : Any>(val value: T)\nfun <R> make(): R? = null');
      const t = generic.declarations.find((d) => d.name === 'T');
      const r = generic.declarations.find((d) => d.name === 'R');
      assert(!!t && !!r, 'both type parameters indexed');
      assertEqual(t!.containerFqName, 'Box');
    });

    test('annotated and explicit primary constructors', () => {
      const parsedCtor = parseKotlin(
        'C.kt',
        'class Repo @Inject internal constructor(private val api: Api) { fun go() {} }',
      );
      const api = parsedCtor.declarations.find((d) => d.name === 'api');
      assert(!!api, 'constructor property found');
      assertEqual(api!.kind, 'property');
      assertEqual(parsedCtor.declarations.find((d) => d.name === 'go')!.containerFqName, 'Repo');
    });

    test('object expressions are not mistaken for declarations', () => {
      const parsedObject = parseKotlin('O.kt', 'val listener = object : Runnable { override fun run() {} }\nclass After');
      assert(!!parsedObject.declarations.find((d) => d.name === 'After' && d.kind === 'class'), 'later class still parsed');
    });
  });

  suite('java parser', () => {
    const source = `package androidx.demo;

import android.view.View;

public class Widget extends View implements Clickable {
    private static final String TAG = "Widget";
    Runnable task = new Runnable() {
        @Override
        public void run() { int ignored = 1; }
    };
    int a, b;

    public Widget(Context context) { super(context); }

    public LifecycleOwner getViewLifecycleOwner() { return null; }

    static class Helper {
        void help() {}
    }

    enum Mode { ON, OFF }
}
`;
    const parsed = parseJava('Widget.java', source);
    const byName = (name: string) => parsed.declarations.filter((d) => d.name === name);

    test('package, supertypes and members', () => {
      assertEqual(parsed.packageName, 'androidx.demo');
      const widget = byName('Widget').find((d) => d.kind === 'class')!;
      assertEqual((widget.supertypes ?? []).join(','), 'View,Clickable');
      assertEqual(byName('TAG')[0].containerFqName, 'androidx.demo.Widget');
    });

    test('anonymous class in a field initialiser does not derail the scanner', () => {
      // Everything after `task` used to be lost when the scanner stopped at the
      // first `;` inside the anonymous class body.
      assertEqual(byName('a').length, 1);
      assertEqual(byName('b').length, 1);
      assert(byName('getViewLifecycleOwner').length === 1, 'method after the anonymous class is indexed');
      assertEqual(byName('Helper')[0].fqName, 'androidx.demo.Widget.Helper');
      assertEqual(byName('ON')[0].kind, 'enumEntry');
    });

    test('constructors are distinguished from methods', () => {
      const ctor = parsed.declarations.find((d) => d.kind === 'constructor');
      assert(!!ctor, 'constructor found');
      assertEqual(ctor!.name, 'Widget');
    });
  });
}
