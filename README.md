# Kotlin Navigator

Go to Definition, Find References and symbol search for Kotlin and Android projects
in **Cursor** and **VS Code** — without a Gradle sync, a language server, or a JVM.

Built because the available Kotlin extensions resolve *some* symbols and silently
give up on the rest, which makes Cmd+Click unreliable exactly when you need it.

## What it does

| Feature | Shortcut |
| --- | --- |
| Go to Definition / Peek Definition | `Cmd+Click`, `F12`, `Alt+F12` |
| Go to Type Definition | `Cmd+F12` |
| Find All References | `Shift+F12` |
| Go to Symbol in File (outline, breadcrumbs) | `Cmd+Shift+O` |
| Go to Symbol in Workspace | `Cmd+T` |
| Hover with signature and KDoc | hover |

It resolves:

- **Your own code** — classes, objects, interfaces, enums and their entries,
  functions, properties, constructors, type aliases, type parameters, locals,
  function parameters, **lambda parameters**, destructured names.
- **Inherited members**, through as many supertypes as it takes, including into
  library and Android framework classes.
- **Extension functions and properties**, including generic ones such as `let`,
  `also` and `joinToString`, and the implicit receiver inside
  `fun Fragment.show() { requireActivity() }`.
- **Java getters as Kotlin properties** — `fragment.viewLifecycleOwner` lands on
  `getViewLifecycleOwner()`.
- **Named arguments** — `show(title = "x")` jumps to the `title` parameter.
- **String templates** — `"${user.name}"` is navigable; comments and plain
  string contents are not.
- **KDoc links** — `[SomeClass]` in a doc comment.
- **Third-party libraries** — every `-sources.jar` in your Gradle/Maven cache is
  indexed, and its files open as read-only virtual documents straight out of the
  archive. Nothing is extracted to disk.
- **The Android framework** — `android.app.Activity` and friends, read from the
  Android SDK's `sources/android-<level>` directory.
- **Generated sources** — `*Binding`, `*Directions`, `*Args`, `BuildConfig`,
  Room and KSP/KAPT output under `build/generated`.

### Android specifics

- `R.layout.activity_main` → the layout file.
- `R.string.title`, `R.color.accent`, `R.dimen.*`, `R.style.*` → the exact
  `<string name="title">` line in `res/values`.
- `R.id.submit` → the `@+id/submit` that declares it.
- `binding.recyclerView` → the `@+id/recycler_view` in the layout that generated
  the field (not the generated Java, which is rarely what you want to read).
- Inside layout XML: `@color/white`, `@drawable/ic_back`, `@style/AppTheme`,
  `@id/…`, custom view tags such as `<com.example.views.FancyView>`,
  `tools:context=".MainActivity"`, `android:name="…"` and data-binding
  `<variable type="…">`.

## How it works

There is no JVM and no build. The extension does three things at startup:

1. **Parses your sources** with a purpose-built scanner. Comments and string
   literals are blanked out first — preserving every offset — so a `class`
   inside a KDoc block is never mistaken for a declaration. Kotlin string
   templates are deliberately left visible.
2. **Reads the central directory of every `-sources.jar`** it can find. That is
   a few kilobytes per archive, so all of them get indexed by path in about a
   second. A file is only inflated and parsed the first time you navigate into
   it. Multiplatform artifacts that publish under `commonMain/` or drop package
   directories entirely are handled by reading one file's `package` line and
   recovering the prefix for the whole archive.
3. **Scans `res/`** for resources, ids, and the layout → binding-class mapping.

Everything is incremental afterwards: saving a file re-parses that file, and
editing one re-parses the buffer so offsets stay in step with what you see.

### Measured on a real project

A 957-file Android app (Compose + ViewBinding + DataBinding + Room + SafeArgs,
309 sources jars, Android SDK 36):

```
workspace index          957 files            ~0.5 s
library index            309 jars / 58,928 source files   ~1.2 s
resource index           240 files / 1,612 resources      instant
go to definition         0.09 ms per lookup
references resolved      98.3 % of 40,872 real code references
```

The 1.8 % that does not resolve is mostly `_` placeholders, the type segment of
`R.drawable.x`, and members of libraries that ship no sources jar.

## Install

```bash
npm install
npm run package          # produces kotlin-navigator-<version>.vsix
```

Then in Cursor or VS Code: **Extensions → ⋯ → Install from VSIX…**, or

```bash
cursor --install-extension kotlin-navigator-0.1.0.vsix
code   --install-extension kotlin-navigator-0.1.0.vsix
```

### If you also have a Kotlin language server installed

`fwcd.kotlin` and `jetbrains.kotlin-server` both register their own definition
providers. When several providers answer, the editor shows a picker instead of
jumping, so it is worth deciding which one you want:

- Keep **Kotlin Navigator** for navigation.
- Keep the JetBrains server for diagnostics and completion if you use it.
- Disable `fwcd.kotlin`, whose language server needs a resolved Gradle classpath
  and tends to return nothing on Android projects.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `kotlinNavigator.enable` | `true` | Master switch. |
| `kotlinNavigator.indexLibrarySources` | `true` | Index `-sources.jar` from `~/.gradle` and `~/.m2`. |
| `kotlinNavigator.indexAndroidSdkSources` | `true` | Index the Android SDK sources. |
| `kotlinNavigator.androidSdkPath` | auto | Override SDK detection. |
| `kotlinNavigator.gradleCachePaths` | `[]` | Extra directories to scan for sources jars. |
| `kotlinNavigator.indexGeneratedSources` | `true` | Index `build/generated`. |
| `kotlinNavigator.androidResources` | `true` | Resolve `R.*`, bindings and XML. |
| `kotlinNavigator.excludeGlobs` | see settings | Paths to skip. |
| `kotlinNavigator.maxResults` | `12` | Cap on ambiguous definition results. |
| `kotlinNavigator.enableHover` | `true` | Signature + KDoc hover card. |
| `kotlinNavigator.trace` | `false` | Log every resolution step. |

## Commands

- **Kotlin Navigator: Rebuild Index**
- **Kotlin Navigator: Show Index Statistics**
- **Kotlin Navigator: Show Log**
- **Kotlin Navigator: Clear Extracted Library Source Cache**

## Limitations

Worth knowing before you file a bug:

- Resolution is name- and type-based, not a full type inference. An expression
  whose type comes from a generic call chain (`list.map { … }.first().foo`) may
  fall back to a name match, which can offer more than one candidate.
- Implicit receivers introduced by `with`, `apply` and `run` are not modelled.
- Libraries with no `-sources.jar` in the cache cannot be navigated into. Adding
  `downloadSources` to your Gradle IDE config fixes that for the next sync.
- Java support is good enough for the Android framework, generated binding
  classes and mixed projects, but Kotlin is the primary target.

## Development

```bash
npm run build        # bundle into dist/
npm run watch        # rebuild on change
npm run typecheck
npm test             # 44 parser and resolution tests, no editor needed
```

`npm test` runs headlessly because the indexer and resolver have no `vscode`
import — only the thin provider layer does.
