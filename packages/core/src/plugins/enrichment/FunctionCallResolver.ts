/**
 * FunctionCallResolver - creates CALLS and HANDLED_BY edges for imported function calls
 *
 * This enrichment plugin runs AFTER ImportExportLinker (priority 80 vs 90) and:
 * 1. Finds CALL_SITE nodes without CALLS edges (excluding method calls)
 * 2. For each, looks for IMPORT with matching local name in same file
 * 3. Follows IMPORTS_FROM -> EXPORT -> FUNCTION chain
 * 4. Creates CALLS edge to target FUNCTION
 * 5. Creates HANDLED_BY edge from CALL to IMPORT (REG-545)
 *
 * CREATES EDGES:
 * - CALL_SITE -> CALLS -> FUNCTION (for imported functions)
 * - CALL_SITE -> HANDLED_BY -> IMPORT (links call to its import declaration)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { dirname, resolve } from 'path';
import { StrictModeError } from '../../errors/GrafemaError.js';
import { resolveModulePath as resolveModulePathUtil } from '../../utils/moduleResolution.js';
import { NodeFactory } from '../../core/NodeFactory.js';

// === INTERFACES ===

interface CallNode extends BaseNodeRecord {
  object?: string; // If present, this is a method call - skip
}

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string; // 'default' | 'named' | 'namespace'
  importBinding?: string; // 'value' | 'type' | 'typeof'
  imported?: string; // Original name in source file
  local?: string; // Local binding name
}

interface ExportNode extends BaseNodeRecord {
  exportType?: string; // 'default' | 'named' | 'all'
  local?: string; // Local name in exporting file
  source?: string; // Re-export source (if re-exporting)
}


interface ExternalModuleResult {
  type: 'external';
  packageName: string;
  exportedName: string;
}

type ResolveChainResult = ExportNode | ExternalModuleResult | null;

type FunctionNode = BaseNodeRecord;

// === PLUGIN CLASS ===

export class FunctionCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'FunctionCallResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: ['EXTERNAL_MODULE'],
        edges: ['CALLS', 'HANDLED_BY']
      },
      dependencies: ['ImportExportLinker'], // Requires IMPORTS_FROM edges
      consumes: ['IMPORTS_FROM'],
      produces: ['CALLS', 'HANDLED_BY']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting function call resolution');

    const startTime = Date.now();

    // Step 1: Build indexes
    const importIndex = await this.buildImportIndex(graph);
    logger.debug('Indexed imports', { count: importIndex.size });

    const functionIndex = await this.buildFunctionIndex(graph);
    logger.debug('Indexed functions', { files: functionIndex.size });

    const exportIndex = await this.buildExportIndex(graph);
    logger.debug('Indexed exports', { files: exportIndex.size });

    // Step 1.5: Build conservative shadowing index (REG-545)
    const shadowedImportKeys = await this.buildShadowIndex(graph);
    logger.debug('Indexed shadow keys', { count: shadowedImportKeys.size });

    // Step 1.6: Build set of known files for path resolution
    const knownFiles = new Set<string>();
    for (const file of exportIndex.keys()) {
      knownFiles.add(file);
    }
    for (const file of functionIndex.keys()) {
      knownFiles.add(file);
    }
    logger.debug('Indexed known files', { count: knownFiles.size });

    // Step 3: Collect unresolved CALL_SITE nodes
    const callSitesToResolve: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const call = node as CallNode;

      // Skip method calls (have object attribute)
      if (call.object) continue;

      // Skip if already has CALLS edge
      const existingEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
      if (existingEdges.length > 0) continue;

      callSitesToResolve.push(call);
    }
    logger.info('Found call sites to resolve', { count: callSitesToResolve.length });

    // Step 4: Resolution
    let edgesCreated = 0;
    let handledByEdgesCreated = 0;
    const skipped = {
      alreadyResolved: 0,
      methodCalls: 0,
      external: 0,
      missingImport: 0,
      missingImportsFrom: 0,
      reExportsBroken: 0     // Re-export chain broken (missing export, file not found, or circular)
    };

    let reExportsResolved = 0; // Counter for successfully resolved re-export chains
    const errors: Error[] = [];

    let processed = 0;
    const total = callSitesToResolve.length;
    for (const callSite of callSitesToResolve) {
      processed++;
      if (onProgress && processed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'FunctionCallResolver',
          message: `Resolving function calls ${processed}/${total} (${elapsed}s)`,
          totalFiles: total,
          processedFiles: processed
        });
      }
      const calledName = callSite.name;
      const file = callSite.file;

      if (!calledName || !file) continue;

      // Step 4.1: Find matching import in same file
      const importKey = `${file}:${calledName}`;
      const imp = importIndex.get(importKey);

      if (!imp) {
        skipped.missingImport++;
        continue;
      }

      // Step 4.2: Follow IMPORTS_FROM edge to find EXPORT
      const importsFromEdges = await graph.getOutgoingEdges(imp.id, ['IMPORTS_FROM']);
      if (importsFromEdges.length === 0) {
        skipped.missingImportsFrom++;
        continue;
      }

      const exportNodeId = importsFromEdges[0].dst;
      const exportNode = await graph.getNode(exportNodeId) as ExportNode | null;

      if (!exportNode) {
        skipped.missingImportsFrom++;
        continue;
      }

      // Step 4.3: Resolve re-export chain (if applicable)
      let finalExport = exportNode;

      if (exportNode.source) {
        // This is a re-export - follow the chain
        const resolved = this.resolveExportChain(
          exportNode,
          exportIndex,
          knownFiles
        );

        if (!resolved) {
          // Chain broken or circular
          // Distinguish: if visited set would show cycle, it's circular
          // For simplicity, count as broken (can add nuance later)
          skipped.reExportsBroken++;

          // In strict mode, collect error
          if (context.strictMode) {
            const error = new StrictModeError(
              `Cannot resolve re-export chain for: ${calledName}`,
              'STRICT_BROKEN_IMPORT',
              {
                filePath: file,
                lineNumber: callSite.line as number | undefined,
                phase: 'ENRICHMENT',
                plugin: 'FunctionCallResolver',
                calledFunction: calledName,
                importSource: imp.source,
              },
              `Check if the module "${imp.source}" exists and exports "${calledName}"`
            );
            errors.push(error);
          }
          continue;
        }

        // Check if resolved to external module
        if ('type' in resolved && resolved.type === 'external') {
          // Type narrowing: resolved is ExternalModuleResult
          const externalResult = resolved as ExternalModuleResult;

          // Find or create EXTERNAL_MODULE node and create CALLS edge
          const externalModuleId = `EXTERNAL_MODULE:${externalResult.packageName}`;

          // Check if node exists
          const externalNode = await graph.getNode(externalModuleId);
          if (!externalNode) {
            // Create EXTERNAL_MODULE node
            await factory!.store(NodeFactory.createExternalModule(externalResult.packageName));
          }

          // Create CALLS edge with metadata
          await factory!.link({
            type: 'CALLS',
            src: callSite.id,
            dst: externalModuleId,
            metadata: { exportedName: externalResult.exportedName }
          });

          edgesCreated++;
          reExportsResolved++;

          // Step 4.3.1: Create HANDLED_BY edge from CALL to IMPORT (REG-545, GAP 3 fix)
          // Links the call to the original import declaration in the calling file
          if (imp.importBinding !== 'type') {
            const shadowKey = `${file}:${calledName}`;
            if (!shadowedImportKeys.has(shadowKey)) {
              await graph.addEdge({
                type: 'HANDLED_BY',
                src: callSite.id,
                dst: imp.id
              });
              handledByEdgesCreated++;
            }
          }

          continue;
        }

        // At this point, resolved must be ExportNode (not external)
        finalExport = resolved as ExportNode;
        reExportsResolved++;
      }

      // Step 4.4: Find target FUNCTION via final export's local name
      const targetFile = finalExport.file;
      const targetFunctionName = finalExport.local || finalExport.name;

      if (!targetFile || !targetFunctionName) continue;

      const fileFunctions = functionIndex.get(targetFile);
      if (!fileFunctions) continue;

      const targetFunction = fileFunctions.get(targetFunctionName);
      if (!targetFunction) continue;

      // Step 4.5: Create CALLS edge
      await factory!.link({
        type: 'CALLS',
        src: callSite.id,
        dst: targetFunction.id
      });

      edgesCreated++;

      // Step 4.6: Create HANDLED_BY edge from CALL to IMPORT (REG-545)
      // Links the call to the original import declaration in the calling file
      // Skip type-only imports (GAP 1 fix) and shadowed names
      if (imp.importBinding !== 'type') {
        const shadowKey = `${file}:${calledName}`;
        if (!shadowedImportKeys.has(shadowKey)) {
          await graph.addEdge({
            type: 'HANDLED_BY',
            src: callSite.id,
            dst: imp.id
          });
          handledByEdgesCreated++;
        }
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      edgesCreated,
      handledByEdgesCreated,
      skipped,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated + handledByEdgesCreated },
      {
        callSitesProcessed: callSitesToResolve.length,
        edgesCreated,
        handledByEdgesCreated,
        reExportsResolved,
        skipped,
        timeMs: Date.now() - startTime
      },
      errors
    );
  }

  /**
   * Build import index mapping file:local to ImportNode.
   * Only indexes relative imports (skips external packages).
   */
  private async buildImportIndex(graph: PluginContext['graph']): Promise<Map<string, ImportNode>> {
    const importIndex = new Map<string, ImportNode>();
    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const imp = node as ImportNode;
      if (!imp.file || !imp.local) continue;

      // Skip external imports (non-relative)
      const isRelative = imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'));
      if (!isRelative) continue;

      const key = `${imp.file}:${imp.local}`;
      importIndex.set(key, imp);
    }
    return importIndex;
  }

  /**
   * Build function index mapping file -> name -> FunctionNode.
   * Used for O(1) lookup when resolving call targets.
   */
  private async buildFunctionIndex(graph: PluginContext['graph']): Promise<Map<string, Map<string, FunctionNode>>> {
    const functionIndex = new Map<string, Map<string, FunctionNode>>();
    for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
      const func = node as FunctionNode;
      if (!func.file || !func.name) continue;

      if (!functionIndex.has(func.file)) {
        functionIndex.set(func.file, new Map());
      }
      functionIndex.get(func.file)!.set(func.name, func);
    }
    return functionIndex;
  }

  /**
   * Build export index mapping file -> exportKey -> ExportNode.
   * Enables O(1) lookup when following re-export chains.
   */
  private async buildExportIndex(graph: PluginContext['graph']): Promise<Map<string, Map<string, ExportNode>>> {
    const exportIndex = new Map<string, Map<string, ExportNode>>();
    for await (const node of graph.queryNodes({ nodeType: 'EXPORT' })) {
      const exp = node as ExportNode;
      if (!exp.file) continue;

      if (!exportIndex.has(exp.file)) {
        exportIndex.set(exp.file, new Map());
      }

      const fileExports = exportIndex.get(exp.file)!;
      fileExports.set(this.buildExportKey(exp), exp);
    }
    return exportIndex;
  }

  /**
   * Build conservative shadowing index (REG-545).
   *
   * Returns Set<file:localName> where a local variable, constant, or parameter
   * exists that could shadow an import of the same name. Conservative: any matching
   * name in any scope within the file blocks HANDLED_BY creation.
   *
   * Queries VARIABLE, CONSTANT, and PARAMETER node types.
   * - VARIABLE/CONSTANT: checked via parentScopeId (present when inside any scope)
   * - PARAMETER: checked via parentScopeId (PARAMETER nodes use parentFunctionId instead,
   *   so this is a known gap — Dijkstra GAP 2)
   *
   * Full scope-chain traversal deferred as follow-up.
   */
  private async buildShadowIndex(graph: PluginContext['graph']): Promise<Set<string>> {
    const shadowedKeys = new Set<string>();
    for (const nodeType of ['VARIABLE', 'CONSTANT', 'PARAMETER'] as const) {
      for await (const node of graph.queryNodes({ nodeType })) {
        if (node.file && node.name && (node as BaseNodeRecord & { parentScopeId?: string }).parentScopeId) {
          shadowedKeys.add(`${node.file}:${node.name}`);
        }
      }
    }
    return shadowedKeys;
  }

  /**
   * Build a key string for export index lookup.
   *
   * @param exp - Export node to build key for
   * @returns Key in format "default" or "named:name"
   */
  private buildExportKey(exp: ExportNode): string {
    if (exp.exportType === 'default') {
      return 'default';
    }
    return `named:${exp.name || exp.local || 'anonymous'}`;
  }

  /**
   * Extract package name from import source.
   * Handles: 'lodash', '@tanstack/react-query', 'lodash/map', '@scope/pkg/sub'
   */
  private extractPackageName(source: string): string | null {
    if (!source) return null;

    // Handle scoped packages (@scope/package)
    if (source.startsWith('@')) {
      const parts = source.split('/');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
      return null;
    }

    // Non-scoped package: lodash or lodash/map
    const slashIndex = source.indexOf('/');
    if (slashIndex === -1) {
      return source;
    }
    return source.substring(0, slashIndex);
  }

  /**
   * Resolve module specifier to actual file path using extension fallbacks.
   * Pattern reused from ImportExportLinker (lines 101-122).
   *
   * @param currentDir - Directory of the file containing the import/re-export
   * @param specifier - The module specifier (e.g., "./utils", "../lib/helpers")
   * @param fileIndex - Set or Map of known file paths for existence checking
   * @returns Resolved file path or null if not found
   */
  /**
   * Resolve module path using in-memory file index.
   * Uses shared utility from moduleResolution.ts (REG-320).
   * Now supports all extensions (.mjs, .cjs, etc.) - fixes previous bug.
   */
  private resolveModulePath(
    currentDir: string,
    specifier: string,
    fileIndex: Set<string>
  ): string | null {
    const basePath = resolve(currentDir, specifier);
    return resolveModulePathUtil(basePath, {
      useFilesystem: false,
      fileIndex
    });
  }

  /**
   * Follow re-export chain to find the final EXPORT node (without source field).
   *
   * Algorithm:
   * 1. If current export has no source -> return it (base case)
   * 2. Resolve source path to file
   * 3. Find matching export in that file
   * 4. Recurse (with cycle detection)
   *
   * @param exportNode - Starting export node (may be re-export)
   * @param exportIndex - Pre-built export index for O(1) lookups
   * @param knownFiles - Set of known file paths
   * @param visited - Set of visited export IDs for cycle detection
   * @param maxDepth - Maximum chain depth (safety limit)
   * @returns Final export node (without source), external module result, or null if chain broken/circular
   */
  private resolveExportChain(
    exportNode: ExportNode,
    exportIndex: Map<string, Map<string, ExportNode>>,
    knownFiles: Set<string>,
    visited: Set<string> = new Set(),
    maxDepth: number = 10
  ): ResolveChainResult {
    // Safety: max depth exceeded
    if (maxDepth <= 0) {
      return null;
    }

    // Cycle detection
    if (visited.has(exportNode.id)) {
      return null;
    }
    visited.add(exportNode.id);

    // Base case: not a re-export
    if (!exportNode.source) {
      return exportNode;
    }

    // Recursive case: follow re-export
    const currentDir = dirname(exportNode.file!);
    const targetFile = this.resolveModulePath(currentDir, exportNode.source, knownFiles);

    if (!targetFile) {
      // Check if this is an external module (non-relative source)
      const source = exportNode.source!;
      const isExternal = !source.startsWith('./') && !source.startsWith('../');

      if (isExternal) {
        const packageName = this.extractPackageName(source);
        if (packageName) {
          return {
            type: 'external',
            packageName,
            exportedName: exportNode.local || exportNode.name || ''
          };
        }
      }
      return null; // Source file not found and not external
    }

    const targetExports = exportIndex.get(targetFile);
    if (!targetExports) {
      return null; // No exports in target file
    }

    // Find matching export by name
    // Re-export: export { foo } from './other' - look for named:foo
    // Re-export default: export { default } from './other' - look for default
    const nextExport = targetExports.get(this.buildExportKey(exportNode));
    if (!nextExport) {
      return null; // Export not found in target
    }

    return this.resolveExportChain(
      nextExport,
      exportIndex,
      knownFiles,
      visited,
      maxDepth - 1
    );
  }
}
