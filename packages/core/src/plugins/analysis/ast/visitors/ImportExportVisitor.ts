/**
 * ImportExportVisitor - handles import and export declarations
 *
 * Handles:
 * - ImportDeclaration: import { foo } from './module'
 * - ExportDefaultDeclaration: export default foo
 * - ExportNamedDeclaration: export { foo, bar }
 * - ExportAllDeclaration: export * from './module'
 */

import type {
  ImportDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  ExportAllDeclaration,
  ImportSpecifier,
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ExportSpecifier,
  VariableDeclaration,
  FunctionDeclaration,
  ClassDeclaration,
  Identifier,
  Node
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type { VariableInfo } from './VariableVisitor.js';

/**
 * Callback type for extracting variable names from patterns
 */
export type ExtractVariableNamesCallback = (pattern: Node) => VariableInfo[];

/**
 * Import specifier info
 */
interface ImportSpecifierInfo {
  imported: string;
  local: string;
}

/**
 * Import info
 */
interface ImportInfo {
  source: string;
  specifiers: ImportSpecifierInfo[];
  line: number;
  column?: number;
}

/**
 * Export specifier info
 */
interface ExportSpecifierInfo {
  exported: string;
  local: string;
}

/**
 * Export info
 */
interface ExportInfo {
  type: 'default' | 'named' | 'all';
  line: number;
  declaration?: Node;
  specifiers?: ExportSpecifierInfo[];
  source?: string;
  name?: string;
}

export class ImportExportVisitor extends ASTVisitor {
  private extractVariableNamesFromPattern: ExtractVariableNamesCallback;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain 'imports' and 'exports' arrays
   * @param extractVariableNamesFromPattern - Helper from JSASTAnalyzer
   */
  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    extractVariableNamesFromPattern: ExtractVariableNamesCallback
  ) {
    super(module, collections);
    this.extractVariableNamesFromPattern = extractVariableNamesFromPattern;
  }

  getImportHandlers(): VisitorHandlers {
    const { imports } = this.collections;

    return {
      ImportDeclaration: (path: NodePath) => {
        const node = path.node as ImportDeclaration;
        const source = node.source.value;

        // Collect imported names
        const specifiers: ImportSpecifierInfo[] = [];
        node.specifiers.forEach((spec) => {
          if (spec.type === 'ImportSpecifier') {
            // import { foo, bar } from './module'
            const importSpec = spec as ImportSpecifier;
            const importedName = importSpec.imported.type === 'Identifier'
              ? importSpec.imported.name
              : importSpec.imported.value;
            specifiers.push({
              imported: importedName,
              local: importSpec.local.name
            });
          } else if (spec.type === 'ImportDefaultSpecifier') {
            // import foo from './module'
            const defaultSpec = spec as ImportDefaultSpecifier;
            specifiers.push({
              imported: 'default',
              local: defaultSpec.local.name
            });
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            // import * as foo from './module'
            const namespaceSpec = spec as ImportNamespaceSpecifier;
            specifiers.push({
              imported: '*',
              local: namespaceSpec.local.name
            });
          }
        });

        (imports as ImportInfo[]).push({
          source,
          specifiers,
          line: node.loc!.start.line,
          column: node.loc!.start.column
        });
      }
    };
  }

  getExportHandlers(): VisitorHandlers {
    const { exports } = this.collections;
    const extractVariableNamesFromPattern = this.extractVariableNamesFromPattern;

    return {
      ExportDefaultDeclaration: (path: NodePath) => {
        const node = path.node as ExportDefaultDeclaration;

        (exports as ExportInfo[]).push({
          type: 'default',
          line: node.loc!.start.line,
          declaration: node.declaration
        });
      },

      ExportNamedDeclaration: (path: NodePath) => {
        const node = path.node as ExportNamedDeclaration;

        // export { foo, bar } from './module'
        if (node.source) {
          const specifiers: ExportSpecifierInfo[] = node.specifiers.map((spec) => {
            const exportSpec = spec as ExportSpecifier;
            const exportedName = exportSpec.exported.type === 'Identifier'
              ? exportSpec.exported.name
              : exportSpec.exported.value;
            const localName = exportSpec.local.type === 'Identifier'
              ? exportSpec.local.name
              : exportedName;
            return {
              exported: exportedName,
              local: localName
            };
          });

          (exports as ExportInfo[]).push({
            type: 'named',
            line: node.loc!.start.line,
            specifiers,
            source: node.source.value
          });
        }
        // export { foo, bar }
        else if (node.specifiers.length > 0) {
          const specifiers: ExportSpecifierInfo[] = node.specifiers.map((spec) => {
            const exportSpec = spec as ExportSpecifier;
            const exportedName = exportSpec.exported.type === 'Identifier'
              ? exportSpec.exported.name
              : exportSpec.exported.value;
            return {
              exported: exportedName,
              local: exportSpec.local.name
            };
          });

          (exports as ExportInfo[]).push({
            type: 'named',
            line: node.loc!.start.line,
            specifiers
          });
        }
        // export const foo = 42 or export function bar() {}
        else if (node.declaration) {
          const declaration = node.declaration;

          // export function foo() {}
          if (declaration.type === 'FunctionDeclaration') {
            const funcDecl = declaration as FunctionDeclaration;
            if (funcDecl.id) {
              (exports as ExportInfo[]).push({
                type: 'named',
                line: node.loc!.start.line,
                name: funcDecl.id.name
              });
            }
          }
          // export const foo = 42, bar = 43
          else if (declaration.type === 'VariableDeclaration') {
            const varDecl = declaration as VariableDeclaration;
            varDecl.declarations.forEach((declarator) => {
              // Handle destructuring: export const { a, b } = obj
              const variables = extractVariableNamesFromPattern(declarator.id);
              variables.forEach((varInfo: VariableInfo) => {
                (exports as ExportInfo[]).push({
                  type: 'named',
                  line: node.loc!.start.line,
                  name: varInfo.name
                });
              });
            });
          }
          // export class Foo {}
          else if (declaration.type === 'ClassDeclaration') {
            const classDecl = declaration as ClassDeclaration;
            if (classDecl.id) {
              (exports as ExportInfo[]).push({
                type: 'named',
                line: node.loc!.start.line,
                name: classDecl.id.name
              });
            }
          }
        }
      },

      ExportAllDeclaration: (path: NodePath) => {
        const node = path.node as ExportAllDeclaration;

        // export * from './module'
        (exports as ExportInfo[]).push({
          type: 'all',
          line: node.loc!.start.line,
          source: node.source.value
        });
      }
    };
  }

  getHandlers(): VisitorHandlers {
    return {
      ...this.getImportHandlers(),
      ...this.getExportHandlers()
    };
  }
}
