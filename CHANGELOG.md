# Changelog

All notable changes to Kotlin Navigator are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-19

First release.

### Added

- **Go to Definition** for Kotlin and Java, resolving 98.5% of real code
  references on a 957-file Android project, in about 0.09 ms per lookup.
  Covers classes, objects, interfaces, enums and their entries, functions,
  properties, constructors, type aliases, type parameters, locals, function
  parameters, lambda parameters and destructured names.
- **Inherited members** through any number of supertypes, including into
  library and Android framework classes.
- **Extension functions and properties**, including generic ones such as `let`
  and `joinToString`, and the implicit receiver inside
  `fun Fragment.show() { requireActivity() }`.
- **Java getters as Kotlin properties**, so `fragment.viewLifecycleOwner` lands
  on `getViewLifecycleOwner()`.
- **Named arguments**, **string templates** and **KDoc links**.
- **Third-party library sources**: every `-sources.jar` in the Gradle and Maven
  caches is indexed by path, and files open as read-only virtual documents
  straight out of the archive. Nothing is extracted to disk.
- **Android framework sources** from the SDK's `sources/android-<level>`.
- **Generated sources** under `build/generated`: `*Binding`, `*Directions`,
  `*Args`, `BuildConfig`, Room and KSP/KAPT output.
- **Android resources**: `R.layout.x` opens the layout, `R.string.x` lands on
  the `<string name="x">` line, `R.id.x` on the `@+id/x` that declares it, and
  `binding.recyclerView` on the view that generated the field.
- **XML navigation**: `@color/…`, `@drawable/…`, `@style/…`, custom view tags,
  `tools:context` and data-binding `<variable type="…">`.
- **Semantic highlighting** driven by resolution rather than regex, so classes,
  interfaces, methods, properties, parameters and locals each get their own
  colour. Suspending functions are marked `async` and `val` bindings `readonly`.
  About 25 ms for a 700-line file, cached per document version.
- **Find All References**, **Go to Symbol in File**, **Go to Symbol in
  Workspace**, **Go to Type Definition** and a hover card with the resolved
  signature and KDoc.

### Notes

- No JVM, no language server and no Gradle sync. Indexing a 957-file project
  takes about half a second; indexing 309 sources jars takes about one second.
- Contributes no TextMate grammar, deliberately, so it composes with whichever
  Kotlin grammar you already have rather than conflicting with it.
