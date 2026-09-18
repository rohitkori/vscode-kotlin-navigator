import * as vscode from 'vscode';
import { LibraryIndex, LIB_SCHEME } from '../index/libraryIndex';
import { readZipEntry, listZipEntries } from '../util/zip';
import { logError } from '../util/log';
import { fileKeyForUri } from './uriMapping';

/**
 * Serves source files that live inside a `-sources.jar` as read-only virtual
 * documents, so jumping into a library needs no extraction to disk and leaves
 * nothing to clean up.
 */
export class LibraryContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = LIB_SCHEME;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly libraries: LibraryIndex) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = fileKeyForUri(uri);
    const known = this.libraries.bySourceKey(key);
    if (known) {
      const text = this.libraries.getSource(known);
      if (text !== undefined) {
        return text;
      }
    }
    // The index may not hold this entry (a jar added after startup); read it
    // straight out of the archive.
    const jarPath = decodeURIComponent(uri.query.replace(/^jar=/, ''));
    const entryName = uri.path.replace(/^\//, '');
    try {
      const entry = listZipEntries(jarPath).find((e) => e.name === entryName);
      if (entry) {
        return readZipEntry(jarPath, entry);
      }
    } catch (error) {
      logError(`could not open ${entryName} in ${jarPath}`, error);
    }
    return `// Kotlin Navigator could not read ${entryName} from ${jarPath}`;
  }
}
