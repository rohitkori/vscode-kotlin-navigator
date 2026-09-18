import { assert, assertEqual, CURSOR, suite, test, TestWorkspace } from './harness';
import { ResourceIndex } from '../src/android/resourceIndex';
import { bindingClassName, bindingFieldName } from '../src/android/resourceIndex';
import { resourceReferenceAt, dottedNameAt } from '../src/android/androidResolver';

function workspaceWithLibrary(): TestWorkspace {
  const workspace = new TestWorkspace();
  workspace.add(
    'lib/Base.kt',
    `package com.lib

open class Base {
    fun shared(): String = ""
    val flag: Boolean = true
}

interface Named {
    val displayName: String
}
`,
  );
  workspace.add(
    'lib/JavaBase.java',
    `package com.lib;

public class JavaBase {
    public LifecycleOwner getViewLifecycleOwner() { return null; }
    public String getTitle() { return null; }
}
`,
  );
  workspace.add(
    'lib/Utils.kt',
    `package com.lib

object Constants {
    const val TENANT = "acme"
}

fun String.shout(): String = uppercase()

fun <T> T.twice(block: (T) -> Unit) { block(this); block(this) }
`,
  );
  return workspace;
}

export function run(): void {
  suite('resolution', () => {
    test('resolves a same-file top-level declaration', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
fun helper() {}
fun main() { ${CURSOR}helper() }
`;
      workspace.add('a/Main.kt', marked);
      const results = workspace.resolveAt('a/Main.kt', marked);
      assertEqual(results[0]?.decl.fqName, 'a.helper');
    });

    test('resolves an explicitly imported symbol', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.Constants
fun go() { ${CURSOR}Constants.TENANT }
`;
      workspace.add('app/Go.kt', marked);
      assertEqual(workspace.resolveAt('app/Go.kt', marked)[0]?.decl.fqName, 'com.lib.Constants');
    });

    test('resolves a member through an explicit receiver', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.Constants
fun go() = Constants.${CURSOR}TENANT
`;
      workspace.add('app/Go.kt', marked);
      assertEqual(workspace.resolveAt('app/Go.kt', marked)[0]?.decl.fqName, 'com.lib.Constants.TENANT');
    });

    test('resolves a fully qualified reference with no import', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
fun go() = com.lib.Constants.${CURSOR}TENANT
`;
      workspace.add('app/Fq.kt', marked);
      assertEqual(workspace.resolveAt('app/Fq.kt', marked)[0]?.decl.fqName, 'com.lib.Constants.TENANT');
    });

    test('resolves an inherited member from a supertype', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.Base
class Screen : Base() {
    fun use() { ${CURSOR}shared() }
}
`;
      workspace.add('app/Screen.kt', marked);
      assertEqual(workspace.resolveAt('app/Screen.kt', marked)[0]?.decl.fqName, 'com.lib.Base.shared');
    });

    test('maps a Kotlin property access onto a Java getter', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.JavaBase
class Screen : JavaBase() {
    fun use() { ${CURSOR}viewLifecycleOwner }
}
`;
      workspace.add('app/Screen2.kt', marked);
      assertEqual(workspace.resolveAt('app/Screen2.kt', marked)[0]?.decl.name, 'getViewLifecycleOwner');
    });

    test('an extension receiver acts as an implicit scope', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.Base
fun Base.extend() { ${CURSOR}shared() }
`;
      workspace.add('app/Ext.kt', marked);
      assertEqual(workspace.resolveAt('app/Ext.kt', marked)[0]?.decl.fqName, 'com.lib.Base.shared');
    });

    test('resolves an extension function on the receiver type', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.shout
fun go(name: String) = name.${CURSOR}shout()
`;
      workspace.add('app/Shout.kt', marked);
      assertEqual(workspace.resolveAt('app/Shout.kt', marked)[0]?.decl.fqName, 'com.lib.shout');
    });

    test('resolves a generic extension whose receiver is a type parameter', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.twice
import com.lib.Base
fun go(b: Base) = b.${CURSOR}twice { }
`;
      workspace.add('app/Twice.kt', marked);
      assertEqual(workspace.resolveAt('app/Twice.kt', marked)[0]?.decl.fqName, 'com.lib.twice');
    });

    test('a lambda parameter shadows an outer local', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
fun go(items: List<String>) {
    val item = "outer"
    items.forEach { item -> println(${CURSOR}item) }
}
`;
      workspace.add('a/Shadow.kt', marked);
      const top = workspace.resolveAt('a/Shadow.kt', marked)[0];
      assertEqual(top?.decl.kind, 'parameter');
      assert(top!.decl.scopeStart !== undefined, 'the lambda binding won, not the outer val');
    });

    test('a local declared in another block is not in scope', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
fun one() { val secret = 1 }
fun two() { println(${CURSOR}secret) }
`;
      workspace.add('a/Scope.kt', marked);
      const results = workspace.resolveAt('a/Scope.kt', marked);
      assert(
        results.length === 0 || results[0].reason !== 'local declaration',
        'a local from a sibling function must not win',
      );
    });

    test('infers a property type from its initialiser to resolve members', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.Base
class Holder {
    val base = Base()
    fun use() = base.${CURSOR}flag
}
`;
      workspace.add('app/Holder.kt', marked);
      assertEqual(workspace.resolveAt('app/Holder.kt', marked)[0]?.decl.fqName, 'com.lib.Base.flag');
    });

    test('follows a factory call to the type it returns', () => {
      const workspace = new TestWorkspace();
      workspace.add(
        'app/build/generated/FooBinding.java',
        `package app.databinding;
public class FooBinding {
    public TextView title;
    public static FooBinding inflate(LayoutInflater i) { return null; }
}
`,
      );
      const marked = `package app
import app.databinding.FooBinding
class Screen {
    val binding = FooBinding.inflate(layoutInflater)
    fun use() = binding.${CURSOR}title
}
`;
      workspace.add('app/Screen3.kt', marked);
      assertEqual(workspace.resolveAt('app/Screen3.kt', marked)[0]?.decl.fqName, 'app.databinding.FooBinding.title');
    });

    test('resolves a named argument to the parameter it names', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
fun show(title: String, count: Int) {}
fun go() { show(${CURSOR}title = "x", count = 1) }
`;
      workspace.add('a/Named.kt', marked);
      const top = workspace.resolveAt('a/Named.kt', marked)[0];
      assertEqual(top?.decl.name, 'title');
      assertEqual(top?.decl.kind, 'parameter');
    });

    test('resolves an identifier inside a string template', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
fun go(name: String) = "hello \${${CURSOR}name}"
`;
      workspace.add('a/Template.kt', marked);
      assertEqual(workspace.resolveAt('a/Template.kt', marked)[0]?.decl.name, 'name');
    });

    test('ignores identifiers inside comments and plain strings', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
class Target
// see ${CURSOR}Target here
`;
      workspace.add('a/Comment.kt', marked);
      const results = workspace.resolveAt('a/Comment.kt', marked);
      assertEqual(results.length, 0, 'a bare word in a line comment is not a reference');
    });

    test('resolves a KDoc link', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
class Target
/** See [${CURSOR}Target] for details. */
fun go() {}
`;
      workspace.add('a/Kdoc.kt', marked);
      assertEqual(workspace.resolveAt('a/Kdoc.kt', marked)[0]?.decl.fqName, 'a.Target');
    });

    test('resolves the target of an import statement', () => {
      const workspace = workspaceWithLibrary();
      const marked = `package app
import com.lib.${CURSOR}Constants
`;
      workspace.add('app/Import.kt', marked);
      assertEqual(workspace.resolveAt('app/Import.kt', marked)[0]?.decl.fqName, 'com.lib.Constants');
    });

    test('this resolves to the enclosing class', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
class Holder { fun go() = ${CURSOR}this }
`;
      workspace.add('a/This.kt', marked);
      assertEqual(workspace.resolveAt('a/This.kt', marked)[0]?.decl.fqName, 'a.Holder');
    });

    test('same package needs no import', () => {
      const workspace = new TestWorkspace();
      workspace.add('a/Other.kt', 'package a\nclass Other');
      const marked = `package a
fun go(): ${CURSOR}Other? = null
`;
      workspace.add('a/Use.kt', marked);
      assertEqual(workspace.resolveAt('a/Use.kt', marked)[0]?.decl.fqName, 'a.Other');
    });

    test('a parameter stays in scope across an expression body with a trailing lambda', () => {
      const workspace = new TestWorkspace();
      const marked = `package a
fun run(block: () -> Unit) {}
suspend fun load(agentId: Long): String =
    run {
        fetch(${CURSOR}agentId)
    }
`;
      workspace.add('a/Expr.kt', marked);
      const top = workspace.resolveAt('a/Expr.kt', marked)[0];
      assertEqual(top?.decl.name, 'agentId');
      assertEqual(top?.decl.kind, 'parameter');
    });

    test('`it` never resolves to an unrelated symbol that shares the name', () => {
      const workspace = new TestWorkspace();
      workspace.add('a/Stray.kt', 'package other\nval it = 3');
      const marked = `package a
fun go(values: List<String>) {
    values.forEach { println(${CURSOR}it) }
}
`;
      workspace.add('a/It.kt', marked);
      const results = workspace.resolveAt('a/It.kt', marked);
      assert(
        results.every((c) => c.decl.file !== 'a/Stray.kt'),
        'the implicit lambda parameter must not resolve to a stray top-level `it`',
      );
    });

    test('prefers the workspace declaration over a generated one', () => {
      const workspace = new TestWorkspace();
      workspace.add('a/Thing.kt', 'package a\nclass Thing');
      workspace.add('a/build/generated/Thing.java', 'package a;\npublic class Thing {}');
      const marked = `package a
fun go(): ${CURSOR}Thing? = null
`;
      workspace.add('a/UseThing.kt', marked);
      const top = workspace.resolveAt('a/UseThing.kt', marked)[0];
      assertEqual(top.decl.file, 'a/Thing.kt');
    });
  });

  suite('android resources', () => {
    test('derives binding class and field names', () => {
      assertEqual(bindingClassName('fragment_project_list'), 'FragmentProjectListBinding');
      assertEqual(bindingClassName('activity_main'), 'ActivityMainBinding');
      assertEqual(bindingFieldName('add_cp'), 'addCp');
      assertEqual(bindingFieldName('recycler_view'), 'recyclerView');
      assertEqual(bindingFieldName('alreadyCamel'), 'alreadyCamel');
    });

    test('recognises resource references in xml', () => {
      const line = '<TextView android:textColor="@color/base_blue_100" />';
      const at = line.indexOf('base_blue');
      const reference = resourceReferenceAt(line, at);
      assertEqual(reference?.type, 'color');
      assertEqual(reference?.name, 'base_blue_100');
    });

    test('ignores framework resources', () => {
      const line = '<TextView android:text="@android:string/ok" />';
      assertEqual(resourceReferenceAt(line, line.indexOf('ok')), undefined);
    });

    test('picks up declared ids', () => {
      const line = '  <Button android:id="@+id/submit_button" />';
      const reference = resourceReferenceAt(line, line.indexOf('submit'));
      assertEqual(reference?.type, 'id');
      assertEqual(reference?.name, 'submit_button');
    });

    test('finds dotted class names in xml', () => {
      const tag = '<com.example.views.FancyView android:layout_width="0dp" />';
      assertEqual(dottedNameAt(tag, tag.indexOf('FancyView')), 'com.example.views.FancyView');
      const context = 'tools:context=".MainActivity"';
      assertEqual(dottedNameAt(context, context.indexOf('MainActivity')), '.MainActivity');
    });

    test('resource index type recognition', () => {
      const index = new ResourceIndex();
      assert(index.isKnownResourceType('layout'), 'layout is a resource type');
      assert(index.isKnownResourceType('id'), 'id is a resource type');
      assert(index.isKnownResourceType('string'), 'string is a resource type');
      assert(!index.isKnownResourceType('nonsense'), 'unknown types are rejected');
    });
  });
}
