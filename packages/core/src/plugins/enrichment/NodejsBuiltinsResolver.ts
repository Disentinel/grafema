/**
 * NodejsBuiltinsResolver - Creates EXTERNAL_FUNCTION nodes for Node.js builtin calls (REG-218)
 *
 * This ENRICHMENT plugin:
 * 1. Queries all CALL nodes
 * 2. For each call that targets a builtin function:
 *    - Checks if call's `object` matches a builtin module (fs, path, etc.)
 *    - Or traces via IMPORT node to find the module source
 * 3. Creates EXTERNAL_FUNCTION node lazily (if not exists)
 * 4. Creates CALLS edge from CALL to EXTERNAL_FUNCTION
 *
 * Architecture:
 * - Nodes are created lazily - only when a call is detected
 * - ID format: EXTERNAL_FUNCTION:fs.readFile
 * - Metadata includes: isBuiltin:true, security?, pure?
 *
 * Also creates:
 * - EXTERNAL_MODULE nodes for imported builtin modules
 * - IMPORTS_FROM edges from IMPORT to EXTERNAL_MODULE
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { BuiltinRegistry } from '../../data/builtins/BuiltinRegistry.js';

/**
 * Call node with method properties
 */
interface CallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
  callee?: string;
}

/**
 * Import node with source info
 */
interface ImportNode extends BaseNodeRecord {
  source?: string;
  imported?: string;
  importType?: string;
}

export class NodejsBuiltinsResolver extends Plugin {
  private registry: BuiltinRegistry;

  constructor(config: Record<string, unknown> = {}) {
    super(config);
    this.registry = new BuiltinRegistry();
  }

  get metadata(): PluginMetadata {
    return {
      name: 'NodejsBuiltinsResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: ['EXTERNAL_FUNCTION', 'EXTERNAL_MODULE'],
        edges: ['CALLS', 'IMPORTS_FROM']
      },
      dependencies: ['JSASTAnalyzer', 'ImportExportLinker']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting Node.js builtins resolution');
    const startTime = Date.now();

    // Track created nodes and edges to avoid duplicates
    const createdExternalFunctions = new Set<string>();
    const createdExternalModules = new Set<string>();
    const createdCallsEdges = new Set<string>();
    const createdImportsFromEdges = new Set<string>();

    // Build import index: local name -> {source, imported}
    // For tracking what module each imported function comes from
    const importIndex = await this.buildImportIndex(graph);
    logger.debug('Built import index', { entries: importIndex.size });

    // Step 1: Create EXTERNAL_MODULE nodes for builtin imports
    // and IMPORTS_FROM edges
    let externalModulesCreated = 0;
    let importsFromEdgesCreated = 0;

    for (const [, importInfo] of importIndex) {
      const { source, file: _file, localName: _localName, importNodeId, importType: _importType } = importInfo;
      const normalizedSource = this.registry.normalizeModule(source);

      if (this.registry.isBuiltinModule(normalizedSource)) {
        // Create EXTERNAL_MODULE node if not exists
        if (!createdExternalModules.has(normalizedSource)) {
          const moduleNodeId = `EXTERNAL_MODULE:${normalizedSource}`;

          // Check if node already exists in graph
          const existingNode = await graph.getNode(moduleNodeId);
          if (!existingNode) {
            await graph.addNode({
              id: moduleNodeId,
              type: 'EXTERNAL_MODULE',
              name: normalizedSource,
              file: '',
              line: 0
            });
            externalModulesCreated++;
          }
          createdExternalModules.add(normalizedSource);
        }

        // Create IMPORTS_FROM edge from IMPORT to EXTERNAL_MODULE
        const moduleNodeId = `EXTERNAL_MODULE:${normalizedSource}`;
        const edgeKey = `${importNodeId}:${moduleNodeId}`;

        if (!createdImportsFromEdges.has(edgeKey) && importNodeId) {
          // Check if edge already exists
          const existingEdges = await graph.getOutgoingEdges(importNodeId, ['IMPORTS_FROM']);
          const alreadyExists = existingEdges.some(e => e.dst === moduleNodeId);

          if (!alreadyExists) {
            await graph.addEdge({
              type: 'IMPORTS_FROM',
              src: importNodeId,
              dst: moduleNodeId
            });
            importsFromEdgesCreated++;
          }
          createdImportsFromEdges.add(edgeKey);
        }
      }
    }

    logger.debug('Created EXTERNAL_MODULE nodes', { count: externalModulesCreated });
    logger.debug('Created IMPORTS_FROM edges', { count: importsFromEdgesCreated });

    // Step 2: Process all CALL nodes
    const allCalls: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      allCalls.push(node as CallNode);
    }
    logger.info('Found CALL nodes to process', { count: allCalls.length });

    let nodesCreated = 0;
    let edgesCreated = 0;
    let processed = 0;

    for (const callNode of allCalls) {
      processed++;

      // Progress reporting
      if (onProgress && processed % 100 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'NodejsBuiltinsResolver',
          message: `Processing calls ${processed}/${allCalls.length}`,
          totalFiles: allCalls.length,
          processedFiles: processed
        });
      }

      // Determine module and function name
      const resolution = this.resolveBuiltinCall(callNode, importIndex);
      if (!resolution) {
        continue;
      }

      const { moduleName, functionName } = resolution;

      // Check if this is a known builtin function
      const funcDef = this.registry.getFunction(moduleName, functionName);
      if (!funcDef) {
        continue;
      }

      // Create EXTERNAL_FUNCTION node if not exists
      const externalFuncId = this.registry.createNodeId(moduleName, functionName);

      if (!createdExternalFunctions.has(externalFuncId)) {
        // Check if node already exists in graph
        const existingNode = await graph.getNode(externalFuncId);
        if (!existingNode) {
          await graph.addNode({
            id: externalFuncId,
            type: 'EXTERNAL_FUNCTION',
            name: `${this.registry.normalizeModule(moduleName)}.${functionName}`,
            file: '',
            line: 0,
            isBuiltin: true,
            ...(funcDef.security && { security: funcDef.security }),
            ...(funcDef.pure !== undefined && { pure: funcDef.pure })
          });
          nodesCreated++;
        }
        createdExternalFunctions.add(externalFuncId);
      }

      // Create CALLS edge from CALL to EXTERNAL_FUNCTION
      const edgeKey = `${callNode.id}:${externalFuncId}`;
      if (!createdCallsEdges.has(edgeKey)) {
        // Check if CALLS edge already exists
        const existingEdges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
        const alreadyExists = existingEdges.some(e => e.dst === externalFuncId);

        if (!alreadyExists) {
          await graph.addEdge({
            type: 'CALLS',
            src: callNode.id,
            dst: externalFuncId
          });
          edgesCreated++;
        }
        createdCallsEdges.add(edgeKey);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = {
      callsProcessed: processed,
      externalFunctionsCreated: nodesCreated,
      externalModulesCreated,
      callsEdgesCreated: edgesCreated,
      importsFromEdgesCreated,
      time: `${totalTime}s`
    };

    logger.info('Complete', summary);

    return createSuccessResult(
      {
        nodes: nodesCreated + externalModulesCreated,
        edges: edgesCreated + importsFromEdgesCreated
      },
      summary
    );
  }

  /**
   * Build index of imports for tracking module sources.
   *
   * Maps: file:localName -> {source, imported, importNodeId, importType}
   */
  private async buildImportIndex(
    graph: PluginContext['graph']
  ): Promise<Map<string, {
    source: string;
    imported: string;
    localName: string;
    file: string;
    importNodeId: string;
    importType?: string;
  }>> {
    const index = new Map<string, {
      source: string;
      imported: string;
      localName: string;
      file: string;
      importNodeId: string;
      importType?: string;
    }>();

    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const importNode = node as ImportNode;
      if (!importNode.source || !importNode.file) continue;

      const localName = importNode.name as string;
      const imported = importNode.imported || localName;
      const importType = importNode.importType;

      // Key: file:localName - for looking up what module a local name comes from
      const key = `${importNode.file}:${localName}`;

      index.set(key, {
        source: importNode.source,
        imported,
        localName,
        file: importNode.file,
        importNodeId: importNode.id,
        importType
      });
    }

    return index;
  }

  /**
   * Resolve a CALL node to its builtin module and function.
   *
   * Handles:
   * 1. Method calls: fs.readFile() -> {module: 'fs', function: 'readFile'}
   * 2. Direct calls from imports: readFile() -> trace to import source
   * 3. Aliased imports: rf() where rf = readFile from 'fs'
   */
  private resolveBuiltinCall(
    callNode: CallNode,
    importIndex: Map<string, {
      source: string;
      imported: string;
      localName: string;
      file: string;
      importNodeId: string;
      importType?: string;
    }>
  ): { moduleName: string; functionName: string } | null {
    const file = callNode.file;
    if (!file) return null;

    // Case 1: Method call - obj.method()
    if (callNode.object && callNode.method) {
      const objectName = callNode.object;
      const methodName = callNode.method;

      // Check if objectName is a namespace import (import * as fs from 'fs')
      const importKey = `${file}:${objectName}`;
      const importInfo = importIndex.get(importKey);

      if (importInfo) {
        // Object is an imported namespace or module
        const normalizedSource = this.registry.normalizeModule(importInfo.source);

        if (this.registry.isBuiltinModule(normalizedSource)) {
          return {
            moduleName: normalizedSource,
            functionName: methodName
          };
        }
      }

      // Check if objectName directly matches a builtin module
      // (for cases like: const fs = require('fs'); fs.readFile())
      if (this.registry.isBuiltinModule(objectName)) {
        return {
          moduleName: this.registry.normalizeModule(objectName),
          functionName: methodName
        };
      }

      return null;
    }

    // Case 2: Direct call - funcName()
    const calleeName = callNode.name as string || callNode.callee;
    if (!calleeName) return null;

    // Look up in import index
    const importKey = `${file}:${calleeName}`;
    const importInfo = importIndex.get(importKey);

    if (importInfo) {
      const normalizedSource = this.registry.normalizeModule(importInfo.source);

      if (this.registry.isBuiltinModule(normalizedSource)) {
        // Use the original imported name, not the alias
        const originalName = importInfo.imported || calleeName;
        return {
          moduleName: normalizedSource,
          functionName: originalName
        };
      }
    }

    return null;
  }
}
