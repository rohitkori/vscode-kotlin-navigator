import * as vscode from 'vscode';
import { affectsIndexing, NavigatorConfig, readConfig } from './config';
import { Indexer } from './indexer';
import { IndexService } from './index/indexService';
import { AndroidResolver } from './android/androidResolver';
import { ResourceIndex } from './android/resourceIndex';
import { Resolver } from './resolve/resolver';
import { DocumentStore } from './providers/documentStore';
import {
  KotlinDefinitionProvider,
  KotlinTypeDefinitionProvider,
  invalidateLineMap,
} from './providers/definitionProvider';
import { KotlinReferenceProvider } from './providers/referenceProvider';
import { KotlinDocumentSymbolProvider, KotlinWorkspaceSymbolProvider } from './providers/symbolProviders';
import { KotlinHoverProvider } from './providers/hoverProvider';
import { XmlDefinitionProvider } from './providers/xmlProvider';
import { LibraryContentProvider } from './providers/libraryContentProvider';
import { fileKeyForUri } from './providers/uriMapping';
import { log, logError, setLogSink, setTrace } from './util/log';

const SOURCE_SELECTOR: vscode.DocumentSelector = [
  { language: 'kotlin' },
  { language: 'java' },
  { pattern: '**/*.{kt,kts}' },
];

const XML_SELECTOR: vscode.DocumentSelector = [{ language: 'xml' }, { pattern: '**/res/**/*.xml' }];

const DOCUMENT_CHANGE_DEBOUNCE_MS = 250;
const RESOURCE_CHANGE_DEBOUNCE_MS = 800;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Kotlin Navigator');
  context.subscriptions.push(channel);
  setLogSink((line) => channel.appendLine(line));

  let config: NavigatorConfig = readConfig();
  setTrace(config.trace);
  log(`Kotlin Navigator activating (${vscode.env.appName})`);

  const service = new IndexService();
  const resources = new ResourceIndex();
  const resolver = new Resolver(service);
  const android = new AndroidResolver(resources, resolver, service);
  const documents = new DocumentStore();
  const indexer = new Indexer(service, resources, () => config);

  const providerSettings = () => ({ maxResults: config.maxResults, androidResources: config.androidResources });
  const enabled = () => config.enable;

  // Library sources are served straight out of their jars as read-only docs.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      LibraryContentProvider.scheme,
      new LibraryContentProvider(service.libraries),
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      SOURCE_SELECTOR,
      wrapDefinition(new KotlinDefinitionProvider(documents, resolver, android, service, providerSettings), enabled),
    ),
    vscode.languages.registerTypeDefinitionProvider(
      SOURCE_SELECTOR,
      new KotlinTypeDefinitionProvider(documents, resolver, service, providerSettings),
    ),
    vscode.languages.registerImplementationProvider(
      SOURCE_SELECTOR,
      wrapDefinition(new KotlinDefinitionProvider(documents, resolver, android, service, providerSettings), enabled),
    ),
    vscode.languages.registerReferenceProvider(
      SOURCE_SELECTOR,
      new KotlinReferenceProvider(documents, resolver, service),
    ),
    vscode.languages.registerDocumentSymbolProvider(SOURCE_SELECTOR, new KotlinDocumentSymbolProvider(documents)),
    vscode.languages.registerWorkspaceSymbolProvider(new KotlinWorkspaceSymbolProvider(service)),
    vscode.languages.registerHoverProvider(
      SOURCE_SELECTOR,
      new KotlinHoverProvider(documents, resolver, service, () => config.enable && config.enableHover),
    ),
    vscode.languages.registerDefinitionProvider(
      XML_SELECTOR,
      new XmlDefinitionProvider(android, () => config.enable && config.androidResources),
    ),
  );

  // ---- keeping the index current -----------------------------------------

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{kt,kts,java}');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => onSourceFileChanged(uri)),
    watcher.onDidChange((uri) => onSourceFileChanged(uri)),
    watcher.onDidDelete((uri) => {
      const key = uri.fsPath;
      service.removeFile(key);
      documents.invalidate(key);
      invalidateLineMap(key);
    }),
  );

  function onSourceFileChanged(uri: vscode.Uri): void {
    const key = uri.fsPath;
    documents.invalidate(key);
    invalidateLineMap(key);
    try {
      indexer.indexOne(key);
    } catch (error) {
      logError(`failed to index ${key}`, error);
    }
  }

  let resourceTimer: NodeJS.Timeout | undefined;
  const resourceWatcher = vscode.workspace.createFileSystemWatcher('**/res/**/*.xml');
  const scheduleResourceRebuild = (): void => {
    if (!config.androidResources) {
      return;
    }
    if (resourceTimer) {
      clearTimeout(resourceTimer);
    }
    resourceTimer = setTimeout(() => {
      resources.build((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    }, RESOURCE_CHANGE_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    resourceWatcher,
    resourceWatcher.onDidCreate(scheduleResourceRebuild),
    resourceWatcher.onDidChange(scheduleResourceRebuild),
    resourceWatcher.onDidDelete(scheduleResourceRebuild),
  );

  // Unsaved edits: re-index from the buffer so offsets stay in step with what
  // the editor shows.
  const pendingDocuments = new Map<string, NodeJS.Timeout>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isIndexable(event.document)) {
        return;
      }
      const key = fileKeyForUri(event.document.uri);
      const existing = pendingDocuments.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      pendingDocuments.set(
        key,
        setTimeout(() => {
          pendingDocuments.delete(key);
          documents.invalidate(key);
          invalidateLineMap(key);
          try {
            indexer.indexDocument(event.document, key);
          } catch (error) {
            logError(`failed to index buffer ${key}`, error);
          }
        }, DOCUMENT_CHANGE_DEBOUNCE_MS),
      );
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isIndexable(document)) {
        onSourceFileChanged(document.uri);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void indexer.rebuild('workspace folders changed')),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('kotlinNavigator')) {
        return;
      }
      const next = readConfig();
      const needsRebuild = affectsIndexing(config, next);
      config = next;
      setTrace(config.trace);
      documents.clear();
      if (needsRebuild) {
        void indexer.rebuild('settings changed');
      }
    }),
  );

  // ---- commands -----------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('kotlinNavigator.rebuildIndex', async () => {
      service.symbols.clear();
      documents.clear();
      await indexer.rebuild('manual rebuild');
      void vscode.window.showInformationMessage('Kotlin Navigator: index rebuilt.');
    }),
    vscode.commands.registerCommand('kotlinNavigator.showStats', () => {
      const resourceStats = resources.stats;
      const message =
        `${service.stats()}\n` +
        `Resource directories: ${resourceStats.resDirs}\n` +
        `Resource files: ${resourceStats.files}\n` +
        `Resources: ${resourceStats.resources}`;
      channel.appendLine('--- index statistics ---');
      channel.appendLine(message);
      channel.show(true);
    }),
    vscode.commands.registerCommand('kotlinNavigator.showOutput', () => channel.show(true)),
    vscode.commands.registerCommand('kotlinNavigator.clearLibraryCache', async () => {
      service.libraries.clear();
      await indexer.rebuild('library cache cleared');
      void vscode.window.showInformationMessage('Kotlin Navigator: library sources re-indexed.');
    }),
  );

  void indexer.rebuild('activation');
}

export function deactivate(): void {
  setLogSink(undefined);
}

function isIndexable(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false;
  }
  const path = document.uri.fsPath;
  return path.endsWith('.kt') || path.endsWith('.kts') || path.endsWith('.java');
}

/** Short-circuits a provider when the extension is switched off. */
function wrapDefinition(
  provider: KotlinDefinitionProvider,
  enabled: () => boolean,
): vscode.DefinitionProvider & vscode.ImplementationProvider {
  const provide = async (
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | undefined> => {
    if (!enabled()) {
      return undefined;
    }
    try {
      return await provider.provideDefinition(document, position, token);
    } catch (error) {
      logError('definition lookup failed', error);
      return undefined;
    }
  };
  return { provideDefinition: provide, provideImplementation: provide };
}
