/**
 * ImportExportLinker - создаёт IMPORTS_FROM edges между IMPORT и EXPORT нодами
 *
 * Этот enrichment plugin работает ПОСЛЕ JSASTAnalyzer и связывает:
 * - IMPORT (default) -> IMPORTS_FROM -> EXPORT (default)
 * - IMPORT (named)   -> IMPORTS_FROM -> EXPORT (named, matching name)
 *
 * ОПТИМИЗАЦИЯ:
 * Вместо O(n) итерации по всем EXPORT нодам для каждого импорта,
 * строим индекс один раз и используем O(1) lookup.
 *
 * Индекс: Map<file, Map<exportKey, exportNode>>
 * где exportKey = "default" | "named:functionName" | "all"
 */

import { dirname, resolve } from 'path';
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * Import node with import-specific properties
 */
interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string;
  imported?: string;
}

/**
 * Export node with export-specific properties
 */
interface ExportNode extends BaseNodeRecord {
  exportType?: string;
}

export class ImportExportLinker extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ImportExportLinker',
      phase: 'ENRICHMENT',
      priority: 90, // Run early in enrichment, after analysis
      creates: {
        nodes: [],
        edges: ['IMPORTS', 'IMPORTS_FROM']
      },
      dependencies: ['JSASTAnalyzer'] // Requires IMPORT and EXPORT nodes
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;

    console.log('[ImportExportLinker] Starting import-export linking...');

    const startTime = Date.now();

    // Step 1: Build EXPORT index - Map<file, Map<exportKey, exportNode>>
    const exportIndex = await this.buildExportIndex(graph);
    const indexTime = Date.now() - startTime;
    console.log(`[ImportExportLinker] Indexed exports from ${exportIndex.size} files in ${indexTime}ms`);

    // Step 2: Build MODULE lookup - Map<file, moduleNode>
    const modulesByFile = await this.buildModuleLookup(graph);
    console.log(`[ImportExportLinker] Indexed ${modulesByFile.size} modules`);

    // Step 3: Process all IMPORT nodes
    const imports: ImportNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      imports.push(node as ImportNode);
    }
    console.log(`[ImportExportLinker] Found ${imports.length} imports to link`);

    let edgesCreated = 0;
    let skipped = 0;
    let notFound = 0;

    for (let i = 0; i < imports.length; i++) {
      const imp = imports[i];

      // Progress reporting
      if (onProgress && i % 100 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ImportExportLinker',
          message: `Linking imports ${i}/${imports.length}`,
          totalFiles: imports.length,
          processedFiles: i
        });
      }

      // Skip external modules (non-relative imports)
      const isRelative = imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'));
      if (!isRelative) {
        skipped++;
        continue;
      }

      // Resolve target file path
      const currentDir = dirname(imp.file!);
      const basePath = resolve(currentDir, imp.source!);

      // Try different extensions
      const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
      let targetFile: string | null = null;
      let targetExports: Map<string, ExportNode> | null = null;

      for (const ext of extensions) {
        const testPath = basePath + ext;
        if (exportIndex.has(testPath)) {
          targetFile = testPath;
          targetExports = exportIndex.get(testPath)!;
          break;
        }
        // Also check modulesByFile in case exports haven't been indexed yet
        if (!targetFile && modulesByFile.has(testPath)) {
          targetFile = testPath;
          targetExports = exportIndex.get(testPath) || new Map();
          break;
        }
      }

      if (!targetFile || !targetExports) {
        notFound++;
        continue;
      }

      // Create MODULE -> IMPORTS -> MODULE edge for relative imports
      const sourceModule = modulesByFile.get(imp.file!);
      const targetModule = modulesByFile.get(targetFile);
      if (sourceModule && targetModule) {
        await graph.addEdge({
          type: 'IMPORTS',
          src: sourceModule.id,
          dst: targetModule.id
        });
        edgesCreated++;
      }

      // Find matching export based on import type
      const importType = imp.importType; // 'default', 'named', or 'namespace'
      let targetExport: ExportNode | undefined;

      if (importType === 'namespace') {
        // import * as foo - already linked to MODULE in GraphBuilder
        skipped++;
        continue;
      } else if (importType === 'default') {
        // import foo from './bar' -> find default export
        targetExport = targetExports.get('default');
      } else {
        // import { foo } from './bar' -> find named export 'foo'
        const exportKey = `named:${imp.imported}`;
        targetExport = targetExports.get(exportKey);
      }

      if (targetExport) {
        await graph.addEdge({
          type: 'IMPORTS_FROM',
          src: imp.id,
          dst: targetExport.id
        });
        edgesCreated++;
      } else {
        notFound++;
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[ImportExportLinker] Complete: ${edgesCreated} edges created, ${skipped} skipped, ${notFound} not found (${totalTime}s)`);

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        importsProcessed: imports.length,
        edgesCreated,
        skipped,
        notFound,
        timeMs: Date.now() - startTime
      }
    );
  }

  /**
   * Build index of all EXPORT nodes: Map<file, Map<exportKey, exportNode>>
   * exportKey = "default" | "named:functionName" | "all"
   */
  private async buildExportIndex(graph: PluginContext['graph']): Promise<Map<string, Map<string, ExportNode>>> {
    const index = new Map<string, Map<string, ExportNode>>();

    for await (const node of graph.queryNodes({ nodeType: 'EXPORT' })) {
      const exportNode = node as ExportNode;
      if (!exportNode.file) continue;

      if (!index.has(exportNode.file)) {
        index.set(exportNode.file, new Map());
      }

      const fileExports = index.get(exportNode.file)!;

      // Build export key based on type
      let exportKey: string;
      if (exportNode.exportType === 'default') {
        exportKey = 'default';
      } else if (exportNode.exportType === 'named') {
        exportKey = `named:${exportNode.name}`;
      } else if (exportNode.exportType === 'all') {
        exportKey = 'all';
      } else {
        exportKey = `unknown:${exportNode.name || 'anonymous'}`;
      }

      fileExports.set(exportKey, exportNode);
    }

    return index;
  }

  /**
   * Build MODULE lookup: Map<file, moduleNode>
   */
  private async buildModuleLookup(graph: PluginContext['graph']): Promise<Map<string, BaseNodeRecord>> {
    const lookup = new Map<string, BaseNodeRecord>();

    for await (const node of graph.queryNodes({ nodeType: 'MODULE' })) {
      if (node.file) {
        lookup.set(node.file, node);
      }
    }

    return lookup;
  }
}
