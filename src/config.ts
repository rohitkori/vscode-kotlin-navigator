import * as vscode from 'vscode';

export interface NavigatorConfig {
  enable: boolean;
  indexLibrarySources: boolean;
  indexAndroidSdkSources: boolean;
  androidSdkPath: string;
  gradleCachePaths: string[];
  excludeGlobs: string[];
  indexGeneratedSources: boolean;
  androidResources: boolean;
  maxResults: number;
  enableHover: boolean;
  trace: boolean;
}

export function readConfig(): NavigatorConfig {
  const section = vscode.workspace.getConfiguration('kotlinNavigator');
  return {
    enable: section.get('enable', true),
    indexLibrarySources: section.get('indexLibrarySources', true),
    indexAndroidSdkSources: section.get('indexAndroidSdkSources', true),
    androidSdkPath: section.get('androidSdkPath', ''),
    gradleCachePaths: section.get('gradleCachePaths', []),
    excludeGlobs: section.get('excludeGlobs', []),
    indexGeneratedSources: section.get('indexGeneratedSources', true),
    androidResources: section.get('androidResources', true),
    maxResults: section.get('maxResults', 12),
    enableHover: section.get('enableHover', true),
    trace: section.get('trace', false),
  };
}

/** Settings that require the index to be rebuilt when they change. */
export function affectsIndexing(previous: NavigatorConfig, next: NavigatorConfig): boolean {
  return (
    previous.indexLibrarySources !== next.indexLibrarySources ||
    previous.indexAndroidSdkSources !== next.indexAndroidSdkSources ||
    previous.androidSdkPath !== next.androidSdkPath ||
    previous.indexGeneratedSources !== next.indexGeneratedSources ||
    previous.androidResources !== next.androidResources ||
    JSON.stringify(previous.gradleCachePaths) !== JSON.stringify(next.gradleCachePaths) ||
    JSON.stringify(previous.excludeGlobs) !== JSON.stringify(next.excludeGlobs)
  );
}
