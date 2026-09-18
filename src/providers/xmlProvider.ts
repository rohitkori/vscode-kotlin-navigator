import * as vscode from 'vscode';
import { AndroidResolver } from '../android/androidResolver';
import { targetsToLinks } from './definitionProvider';

/**
 * Go to Definition inside Android XML: `@color/white`, `@drawable/ic_back`,
 * `@style/AppTheme`, custom view tags, `tools:context`, `android:name` and
 * data-binding `<variable type="...">`.
 */
export class XmlDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly android: AndroidResolver, private readonly enabled: () => boolean) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | undefined> {
    if (!this.enabled()) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);
    const targets = this.android.resolveInXml(text, offset, document.uri.fsPath);
    if (targets.length === 0) {
      return undefined;
    }
    const wordRange = document.getWordRangeAtPosition(position, /[@?]?\+?[\w.]+(\/[\w.]+)?/);
    return await targetsToLinks(targets, wordRange ?? new vscode.Range(position, position), token);
  }
}
