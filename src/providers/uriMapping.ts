import * as vscode from 'vscode';
import { LIB_SCHEME, makeJarKey, parseJarKey } from '../index/libraryIndex';

/**
 * Declarations are keyed by a plain string so the indexer stays free of
 * `vscode`. These two functions are the only place that mapping is defined,
 * and they round-trip exactly.
 */

export function uriForFileKey(key: string): vscode.Uri {
  const jar = parseJarKey(key);
  if (!jar) {
    return vscode.Uri.file(key);
  }
  return vscode.Uri.from({
    scheme: LIB_SCHEME,
    authority: 'jar',
    path: `/${jar.entryName}`,
    query: `jar=${encodeURIComponent(jar.jarPath)}`,
  });
}

export function fileKeyForUri(uri: vscode.Uri): string {
  if (uri.scheme !== LIB_SCHEME) {
    return uri.fsPath;
  }
  const jarPath = decodeURIComponent(uri.query.replace(/^jar=/, ''));
  return makeJarKey(jarPath, uri.path.replace(/^\//, ''));
}

export function isLibraryUri(uri: vscode.Uri): boolean {
  return uri.scheme === LIB_SCHEME;
}
