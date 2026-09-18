import { Declaration } from '../parser/types';
import { ContainerTraits } from '../index/indexService';
import { Origin } from '../index/symbolIndex';

/**
 * The token types this extension emits. All of them are standard VS Code
 * semantic token types, so every theme that supports semantic highlighting
 * colours them without any per-theme configuration.
 */
export const TOKEN_TYPES = [
  'namespace',
  'class',
  'interface',
  'enum',
  'enumMember',
  'typeParameter',
  'type',
  'function',
  'method',
  'property',
  'variable',
  'parameter',
  'decorator',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

export const TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'abstract',
  'async',
  'defaultLibrary',
] as const;

export type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

export interface Classification {
  type: TokenType;
  modifiers: TokenModifier[];
}

/**
 * Maps a resolved declaration onto a token type and modifiers.
 *
 * `isAnnotationUse` matters because the same declaration is a class where it is
 * declared and a decorator where it is applied.
 */
export function classifyDeclaration(
  decl: Declaration,
  options: { isDeclaration: boolean; isAnnotationUse: boolean; origin: Origin; container: ContainerTraits },
): Classification {
  const modifiers: TokenModifier[] = [];
  if (options.isDeclaration) {
    modifiers.push('declaration', 'definition');
  }
  if (options.origin === 'library') {
    modifiers.push('defaultLibrary');
  }
  if (isReadonly(decl)) {
    modifiers.push('readonly');
  }
  if (isStatic(decl, options.container)) {
    modifiers.push('static');
  }
  if (decl.modifiers.includes('abstract') || decl.modifiers.includes('sealed')) {
    modifiers.push('abstract');
  }
  if (decl.modifiers.includes('suspend')) {
    // Suspension points are worth seeing at a glance in Kotlin.
    modifiers.push('async');
  }

  return { type: tokenTypeFor(decl, options), modifiers };
}

function tokenTypeFor(decl: Declaration, options: { isAnnotationUse: boolean; container: ContainerTraits }): TokenType {
  switch (decl.kind) {
    case 'annotationClass':
      return options.isAnnotationUse ? 'decorator' : 'class';
    case 'class':
    case 'object':
      return 'class';
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'enumEntry':
      return 'enumMember';
    case 'typealias':
      return 'type';
    case 'constructor':
      return 'class';
    case 'function':
      return options.container.isType ? 'method' : 'function';
    case 'parameter':
      return decl.modifiers.includes('typeParameter') ? 'typeParameter' : 'parameter';
    case 'property':
      if (decl.isLocal) {
        return 'variable';
      }
      return options.container.isType ? 'property' : 'variable';
    case 'package':
      return 'namespace';
    default:
      return 'variable';
  }
}

function isReadonly(decl: Declaration): boolean {
  if (decl.kind === 'enumEntry') {
    return true;
  }
  if (decl.modifiers.includes('var')) {
    return false;
  }
  return (
    decl.modifiers.includes('val') ||
    decl.modifiers.includes('const') ||
    decl.modifiers.includes('final') ||
    decl.kind === 'object'
  );
}

function isStatic(decl: Declaration, container: ContainerTraits): boolean {
  // A parameter or a local is never static, however it is spelled.
  if (decl.kind === 'parameter' || decl.isLocal) {
    return false;
  }
  if (decl.modifiers.includes('static') || decl.modifiers.includes('const')) {
    return true;
  }
  // Everything inside an `object` or `companion object` is effectively static,
  // as is anything declared at the top level of a file.
  return container.isObject || !container.isType;
}

/**
 * Colouring for an identifier that could not be resolved.
 *
 * Deliberately conservative: only shapes that are unambiguous in Kotlin get a
 * token, and everything else is left to the TextMate grammar rather than
 * guessing at a colour that might be wrong.
 */
export function classifyUnresolved(name: string, isCall: boolean, isAnnotation: boolean): Classification | undefined {
  if (isAnnotation) {
    return { type: 'decorator', modifiers: [] };
  }
  if (isCall) {
    return { type: 'function', modifiers: [] };
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1) {
    return { type: 'variable', modifiers: ['readonly', 'static'] };
  }
  if (/^[A-Z]/.test(name)) {
    return { type: 'class', modifiers: [] };
  }
  return undefined;
}


