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
  Node,
  CallExpression,
  TemplateLiteral
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type { VariableInfo } from './VariableVisitor.js';
import { getLine, getColumn, getEndLocation } from '../utils/location.js';

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
  importKind?: 'value' | 'type' | 'typeof';  // specifier-level: import { type X } from '...'
  column?: number;      // specifier start column
  endColumn?: number;   // specifier end column (exclusive)
}

/**
 * Import info
 */
interface ImportInfo {
  source: string;
  specifiers: ImportSpecifierInfo[];
  line: number;
  column?: number;
  importKind?: 'value' | 'type' | 'typeof';  // TypeScript: import type { ... }
  isDynamic?: boolean;         // true for dynamic import() expressions
  isResolvable?: boolean;      // true if path is a string literal (statically analyzable)
  dynamicPath?: string;        // original expression for template/variable paths
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
            // import { type Foo, bar } from './module' (specifier-level type)
            const importSpec = spec as ImportSpecifier;
            const importedName = importSpec.imported.type === 'Identifier'
              ? importSpec.imported.name
              : importSpec.imported.value;
            const specKind = (importSpec as ImportSpecifier & { importKind?: string }).importKind;
            specifiers.push({
              imported: importedName,
              local: importSpec.local.name,
              importKind: specKind as ImportSpecifierInfo['importKind'],
              column: getColumn(importSpec),
              endColumn: getEndLocation(importSpec).column
            });
          } else if (spec.type === 'ImportDefaultSpecifier') {
            // import foo from './module'
            const defaultSpec = spec as ImportDefaultSpecifier;
            specifiers.push({
              imported: 'default',
              local: defaultSpec.local.name,
              column: getColumn(defaultSpec),
              endColumn: getEndLocation(defaultSpec).column
            });
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            // import * as foo from './module'
            const namespaceSpec = spec as ImportNamespaceSpecifier;
            specifiers.push({
              imported: '*',
              local: namespaceSpec.local.name,
              column: getColumn(namespaceSpec),
              endColumn: getEndLocation(namespaceSpec).column
            });
          }
        });

        (imports as ImportInfo[]).push({
          source,
          specifiers,
          line: getLine(node),
          column: getColumn(node),
          importKind: (node as ImportDeclaration & { importKind?: string }).importKind as ImportInfo['importKind']
        });
      },

      /**
       * Handle dynamic import() expressions
       * Examples:
       * - import('./module.js')                    -> isResolvable: true
       * - import(`./plugins/${name}.js`)           -> isResolvable: false, source: './plugins/'
       * - import(modulePath)                       -> isResolvable: false, source: '<dynamic>'
       */
      CallExpression: (path: NodePath) => {
        const node = path.node as CallExpression;

        // Check if this is an import() call
        if (node.callee.type !== 'Import') {
          return;
        }

        const arg = node.arguments[0];
        if (!arg) return;

        let source: string;
        let isResolvable: boolean;
        let dynamicPath: string | undefined;

        if (arg.type === 'StringLiteral') {
          // import('./module.js') - literal path, fully resolvable
          source = arg.value;
          isResolvable = true;
        } else if (arg.type === 'TemplateLiteral') {
          // import(`./plugins/${name}.js`) - template literal
          const templateArg = arg as TemplateLiteral;
          const firstQuasi = templateArg.quasis[0];

          // Extract static prefix (part before first expression)
          const prefix = firstQuasi?.value?.raw || '';

          if (prefix) {
            source = prefix;
          } else {
            // No static prefix - e.g., import(`${baseDir}/loader.js`)
            source = '<dynamic>';
          }

          isResolvable = false;
          // Capture the original template for debugging/analysis
          dynamicPath = this.templateLiteralToString(templateArg);
        } else if (arg.type === 'Identifier') {
          // import(modulePath) - variable path
          source = '<dynamic>';
          isResolvable = false;
          dynamicPath = (arg as Identifier).name;
        } else {
          // Other expressions (e.g., function calls, member expressions)
          source = '<dynamic>';
          isResolvable = false;
        }

        // Find the receiving variable name from parent
        // Patterns: const mod = await import(...) or const mod = import(...)
        let localName = '*';  // Default for side-effect imports
        const parent = path.parent;

        if (parent?.type === 'AwaitExpression') {
          // const mod = await import(...)
          const awaitParent = path.parentPath?.parent;
          if (awaitParent?.type === 'VariableDeclarator' &&
              awaitParent.id?.type === 'Identifier') {
            localName = awaitParent.id.name;
          }
        } else if (parent?.type === 'VariableDeclarator' &&
                   parent.id?.type === 'Identifier') {
          // const mod = import(...) (without await)
          localName = parent.id.name;
        }

        (imports as ImportInfo[]).push({
          source,
          specifiers: [{
            imported: '*',  // Dynamic imports are always namespace imports
            local: localName
          }],
          line: getLine(node),
          column: getColumn(node),
          isDynamic: true,
          isResolvable,
          dynamicPath
        });
      }
    };
  }

  /**
   * Convert a TemplateLiteral to a string representation for debugging
   */
  private templateLiteralToString(template: TemplateLiteral): string {
    let result = '';
    for (let i = 0; i < template.quasis.length; i++) {
      result += template.quasis[i].value.raw;
      if (i < template.expressions.length) {
        const expr = template.expressions[i];
        if (expr.type === 'Identifier') {
          result += `\${${expr.name}}`;
        } else {
          result += '${...}';
        }
      }
    }
    return result;
  }

  getExportHandlers(): VisitorHandlers {
    const { exports } = this.collections;
    const extractVariableNamesFromPattern = this.extractVariableNamesFromPattern;

    return {
      ExportDefaultDeclaration: (path: NodePath) => {
        const node = path.node as ExportDefaultDeclaration;

        (exports as ExportInfo[]).push({
          type: 'default',
          line: getLine(node),
          declaration: node.declaration
        });
      },

      ExportNamedDeclaration: (path: NodePath) => {
        const node = path.node as ExportNamedDeclaration;
        const exportLine = getLine(node);

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
            line: exportLine,
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
            line: exportLine,
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
                line: exportLine,
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
                  line: exportLine,
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
                line: exportLine,
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
          line: getLine(node),
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
