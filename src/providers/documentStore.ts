import * as vscode from 'vscode';
import { ParsedFile } from '../parser/types';
import { parseSource } from '../index/sourceScanner';
import { maskSource } from '../util/text';
import { ResolveInput } from '../resolve/resolver';
import { fileKeyForUri } from './uriMapping';

interface Model {
  key: string;
  version: number;
  text: string;
  masked: string;
  kinds: Uint8Array;
  parsed: ParsedFile;
}

/**
 * Caches the masked text and parse of the documents currently being looked at.
 *
 * Masking and parsing a file is sub-millisecond, but a single Ctrl-click can
 * ask for the same document several times, and hover fires constantly.
 */
export class DocumentStore {
  private readonly cache = new Map<string, Model>();

  get(document: vscode.TextDocument): Model | undefined {
    const key = fileKeyForUri(document.uri);
    const cached = this.cache.get(key);
    if (cached && cached.version === document.version) {
      return cached;
    }
    const text = document.getText();
    const parsed = parseSource(key.endsWith('.java') ? key : `${key}`, text) ?? parseFallback(key, text);
    if (!parsed) {
      return undefined;
    }
    const { masked, kinds } = maskSource(text, { templates: !key.endsWith('.java') });
    const model: Model = { key, version: document.version, text, masked, kinds, parsed };
    if (this.cache.size > 24) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, model);
    return model;
  }

  toResolveInput(model: Model, offset: number): ResolveInput {
    return {
      file: model.key,
      raw: model.text,
      masked: model.masked,
      kinds: model.kinds,
      parsed: model.parsed,
      offset,
    };
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

function parseFallback(key: string, text: string): ParsedFile | undefined {
  // Library entries carry their extension in the URI path, so `parseSource`
  // already handles them; this only covers untitled buffers.
  return parseSource(`${key}.kt`, text);
}

export type { Model as DocumentModel };
