/**
 * IncrementalModuleIndexer - индексирует модули по требованию через очередь
 * Стартует с entry файла, затем анализирует импорты и добавляет новые файлы в очередь
 */

import { readFileSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { createHash } from 'crypto';
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type { ImportDeclaration, CallExpression, Identifier } from '@babel/types';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { resolveModulePath } from '../../utils/moduleResolution.js';

 
const traverse = (traverseModule as any).default || traverseModule;

/**
 * Edge to add - compatible with InputEdge
 */
interface EdgeToAdd {
  src: string;
  dst: string;
  type: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Pending import edge
 */
interface PendingImport {
  src: string;
  dst: string;
}

export class IncrementalModuleIndexer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'IncrementalModuleIndexer',
      phase: 'INDEXING',
      priority: 90,
      creates: {
        nodes: ['MODULE'],
        edges: ['CONTAINS', 'IMPORTS_FROM']
      }
    };
  }

  /**
   * Resolve module path from import
   */
  private resolveModule(fromFile: string, importPath: string, projectRoot: string): string | null {
    // Absolute path (starts with /)
    if (importPath.startsWith('/')) {
      const fullPath = join(projectRoot, importPath);
      return this.tryResolve(fullPath);
    }

    // Relative path (starts with . or ..)
    if (importPath.startsWith('.')) {
      const fromDir = dirname(fromFile);
      const resolved = resolve(fromDir, importPath);
      return this.tryResolve(resolved);
    }

    // Bare specifier (could be alias inside monorepo, e.g. pkg/svc/...)
    // Heuristic: if it contains a slash and not "node_modules" treat as project-root relative
    if (importPath.includes('/') && !importPath.startsWith('node:')) {
      const candidate = join(projectRoot, importPath);
      const resolved = this.tryResolve(candidate);
      if (resolved) return resolved;
    }

    // node builtin or unresolved external - skip for incremental indexing
    return null;
  }

  /**
   * Try to resolve file with different extensions.
   * Uses shared utility from moduleResolution.ts (REG-320).
   * Now supports all extensions (.ts, .tsx, .mjs, .jsx) - fixes previous bug.
   */
  private tryResolve(basePath: string): string | null {
    return resolveModulePath(basePath, { useFilesystem: true });
  }

  /**
   * Calculate file hash
   */
  private calculateFileHash(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Parse imports from file
   */
  private parseImports(filePath: string, projectRoot: string): string[] {
    try {
      const code = readFileSync(filePath, 'utf-8');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'] as ParserPlugin[],
        errorRecovery: true
      });

      const imports: string[] = [];
      traverse(ast, {
        ImportDeclaration: (path: NodePath<ImportDeclaration>) => {
          const importPath = path.node.source.value;
          const resolved = this.resolveModule(filePath, importPath, projectRoot);
          if (resolved) {
            imports.push(resolved);
          }
        },
        CallExpression: (path: NodePath<CallExpression>) => {
          if ((path.node.callee as Identifier).name === 'require' &&
              path.node.arguments[0]?.type === 'StringLiteral') {
            const importPath = (path.node.arguments[0] as { value: string }).value;
            const resolved = this.resolveModule(filePath, importPath, projectRoot);
            if (resolved) {
              imports.push(resolved);
            }
          }
        }
      });

      return imports;
    } catch {
      // Parse error will be logged by execute() when it needs logger context
      return [];
    }
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    try {
      const { manifest, graph } = context;
      // Cast manifest to expected shape
      const typedManifest = manifest as { projectPath: string; service: { id: string; name: string }; entryFile: string } | undefined;
      const { projectPath, service, entryFile } = typedManifest!;

      if (!entryFile) {
        throw new Error('IncrementalModuleIndexer requires entryFile in manifest');
      }

      const queue: string[] = [entryFile];
      const processed = new Set<string>();
      const pendingImports: PendingImport[] = []; // Store imports to create edges after all nodes exist
      let nodesCreated = 0;
      let edgesCreated = 0;
      let totalImportsParsed = 0;
      let unresolvedImports = 0;

      logger.info('Starting incremental indexing', { entryFile: relative(projectPath, entryFile) });

      while (queue.length > 0) {
        const file = queue.shift()!;

        if (processed.has(file)) continue;
        processed.add(file);

        // Create MODULE node with semantic ID
        const fileHash = this.calculateFileHash(file);
        const baseRelativePath = relative(projectPath, file);
        // REG-76: Prefix with rootPrefix for multi-root workspace support
        const relativePath = context.rootPrefix
          ? `${context.rootPrefix}/${baseRelativePath}`
          : baseRelativePath;
        const semanticId = `${relativePath}->global->MODULE->module`;

        const moduleNode: NodeRecord = {
          id: semanticId,
          type: 'MODULE',
          name: relativePath,
          file: file,
          contentHash: fileHash
        } as unknown as NodeRecord;

        await graph.addNode(moduleNode);
        nodesCreated++;

        // Link to SERVICE
        await graph.addEdge({
          src: service.id,
          dst: moduleNode.id,
          type: 'CONTAINS',
          version: 'main'
        } as EdgeToAdd);
        edgesCreated++;

        // Parse imports and add to queue
        const imports = this.parseImports(file, projectPath);
        totalImportsParsed += imports.length;
        for (const importFile of imports) {
          // Store for later edge creation with semantic ID format
          const importBaseRelativePath = relative(projectPath, importFile);
          // REG-76: Prefix with rootPrefix for multi-root workspace support
          const importRelativePath = context.rootPrefix
            ? `${context.rootPrefix}/${importBaseRelativePath}`
            : importBaseRelativePath;
          const importSemanticId = `${importRelativePath}->global->MODULE->module`;
          pendingImports.push({
            src: moduleNode.id,
            dst: importSemanticId
          });

          if (!processed.has(importFile)) {
            queue.push(importFile);
          }
        }

        // Simple unresolved import heuristic: look for raw import strings we failed to resolve
        // Re-parse quickly and count any that did not get resolved (debug aid)
        try {
          const code = readFileSync(file, 'utf-8');
          const ast = parse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'] as ParserPlugin[],
            errorRecovery: true
          });
          traverse(ast, {
            ImportDeclaration: (p: NodePath<ImportDeclaration>) => {
              const ip = p.node.source.value;
              const isResolved = this.resolveModule(file, ip, projectPath);
              if (!isResolved) unresolvedImports++;
            },
            CallExpression: (p: NodePath<CallExpression>) => {
              if ((p.node.callee as Identifier).name === 'require' &&
                  p.node.arguments[0]?.type === 'StringLiteral') {
                const ip = (p.node.arguments[0] as { value: string }).value;
                const isResolved = this.resolveModule(file, ip, projectPath);
                if (!isResolved) unresolvedImports++;
              }
            }
          });
        } catch {
          // Ignore parse errors for unresolved count
        }

        if (processed.size % 10 === 0) {
          logger.debug('Indexing progress', { indexed: processed.size, queueLength: queue.length });
        }
      }

      logger.info('Modules indexed', { count: processed.size });
      logger.debug('Import statistics', {
        totalImportsParsed,
        unresolvedImports,
        pendingEdges: pendingImports.length
      });

      // Now create all IMPORTS edges after all MODULE nodes exist
      for (const { src, dst } of pendingImports) {
        await graph.addEdge({
          src,
          dst,
          type: 'IMPORTS',
          version: 'main'
        } as EdgeToAdd);
        edgesCreated++;
      }

      logger.info('Indexing complete', {
        nodesCreated,
        edgesCreated,
        importsEdgesCreated: pendingImports.length
      });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { filesScanned: processed.size }
      );

    } catch (error) {
      logger.error('Indexing failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }
}
