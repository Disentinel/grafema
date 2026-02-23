/**
 * ExportEntityLinker - creates EXPORTS edges from EXPORT nodes to the entities they export
 *
 * Connects EXPORT nodes to their target entities (FUNCTION, VARIABLE_DECLARATION,
 * CONSTANT, CLASS, INTERFACE, TYPE, ENUM) or to other EXPORT/MODULE nodes for re-exports.
 *
 * Local exports:
 * - `export function foo()` → EXPORT('foo') -[EXPORTS]→ FUNCTION('foo')
 * - `export { x as y }` → EXPORT('y') -[EXPORTS]→ entity('x')
 * - `export default foo` → EXPORT('default') -[EXPORTS]→ entity('foo')
 *
 * Re-exports:
 * - `export { x } from './mod'` → EXPORT('x') -[EXPORTS]→ EXPORT('x') in resolved file
 * - `export * from './mod'` → EXPORT('*') -[EXPORTS]→ MODULE of resolved file
 *
 * Transitive chains are handled naturally: A re-exports B re-exports C creates
 * A.EXPORT →(EXPORTS)→ B.EXPORT →(EXPORTS)→ C.FUNCTION — graph traversal follows the chain.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { resolveRelativeSpecifier } from '../../utils/moduleResolution.js';

interface ExportNode extends BaseNodeRecord {
  exportType?: string;
  local?: string;
  source?: string;
}

interface EntityNode extends BaseNodeRecord {
  parentScopeId?: string;
}

const ENTITY_TYPES = ['FUNCTION', 'VARIABLE_DECLARATION', 'CONSTANT', 'CLASS', 'INTERFACE', 'TYPE', 'ENUM'];

export class ExportEntityLinker extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ExportEntityLinker',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['EXPORTS']
      },
      dependencies: ['JSASTAnalyzer'],
      consumes: [],
      produces: ['EXPORTS']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting export-entity linking');
    const startTime = Date.now();

    // Step 1: Build indexes

    // Entity index: Map<file, Map<name, nodeId>> — module-level entities only
    const entityIndex = new Map<string, Map<string, string>>();
    // Line index: Map<file, Map<line, nodeId>> — module-level entities by line
    const lineIndex = new Map<string, Map<number, string>>();

    for (const nodeType of ENTITY_TYPES) {
      for await (const node of graph.queryNodes({ nodeType })) {
        const entity = node as EntityNode;
        if (!entity.file || !entity.name) continue;
        // Only module-level entities (parentScopeId === undefined)
        if (entity.parentScopeId !== undefined) continue;

        if (!entityIndex.has(entity.file)) {
          entityIndex.set(entity.file, new Map());
        }
        entityIndex.get(entity.file)!.set(entity.name, entity.id);

        if (entity.line !== undefined) {
          if (!lineIndex.has(entity.file)) {
            lineIndex.set(entity.file, new Map());
          }
          lineIndex.get(entity.file)!.set(entity.line, entity.id);
        }
      }
    }

    const entityIndexTime = Date.now() - startTime;
    logger.debug('Indexed entities', { files: entityIndex.size, time: `${entityIndexTime}ms` });

    // Export index: Map<file, Map<exportKey, ExportNode>>
    const exportIndex = new Map<string, Map<string, ExportNode>>();
    // All exports flat for iteration
    const allExports: ExportNode[] = [];

    for await (const node of graph.queryNodes({ nodeType: 'EXPORT' })) {
      const exportNode = node as ExportNode;
      if (!exportNode.file) continue;

      allExports.push(exportNode);

      if (!exportIndex.has(exportNode.file)) {
        exportIndex.set(exportNode.file, new Map());
      }

      const fileExports = exportIndex.get(exportNode.file)!;
      let exportKey: string;
      if (exportNode.exportType === 'default') {
        exportKey = 'default';
      } else if (exportNode.exportType === 'all') {
        exportKey = 'all';
      } else {
        exportKey = `named:${exportNode.name}`;
      }
      fileExports.set(exportKey, exportNode);
    }

    logger.debug('Indexed exports', { total: allExports.length, files: exportIndex.size });

    // Module lookup: Map<file, moduleNodeId>
    const moduleLookup = new Map<string, string>();
    // File index for in-memory resolution
    const fileIndex = new Set<string>();

    for await (const node of graph.queryNodes({ nodeType: 'MODULE' })) {
      if (node.file) {
        moduleLookup.set(node.file, node.id);
        fileIndex.add(node.file);
      }
    }

    logger.debug('Indexed modules', { count: moduleLookup.size });

    // Step 2: Process each EXPORT node
    let edgesCreated = 0;
    let skipped = 0;
    let notFound = 0;

    for (let i = 0; i < allExports.length; i++) {
      const exp = allExports[i];

      if (onProgress && i % 100 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ExportEntityLinker',
          message: `Linking exports ${i}/${allExports.length}`,
          totalFiles: allExports.length,
          processedFiles: i
        });
      }

      if (exp.source) {
        // Re-export: resolve target file
        const resolved = resolveRelativeSpecifier(exp.source, exp.file!, {
          useFilesystem: false,
          fileIndex
        });

        if (!resolved) {
          // External package re-export — skip
          skipped++;
          continue;
        }

        if (exp.exportType === 'all') {
          // export * from './mod' → EXPORTS edge to MODULE
          const moduleId = moduleLookup.get(resolved);
          if (moduleId) {
            await factory.link({ type: 'EXPORTS', src: exp.id, dst: moduleId });
            edgesCreated++;
          } else {
            notFound++;
          }
        } else {
          // Named/default re-export → find matching EXPORT in resolved file
          const targetExports = exportIndex.get(resolved);
          if (!targetExports) {
            notFound++;
            continue;
          }

          const lookupKey = exp.local === 'default'
            ? 'default'
            : `named:${exp.local}`;
          const targetExport = targetExports.get(lookupKey);

          if (targetExport) {
            await factory.link({ type: 'EXPORTS', src: exp.id, dst: targetExport.id });
            edgesCreated++;
          } else {
            notFound++;
          }
        }
      } else {
        // Local export: find entity in same file
        const entityName = exp.local ?? exp.name;

        if (!entityName || !exp.file) {
          skipped++;
          continue;
        }

        let targetId: string | undefined;

        if (entityName === 'default' || entityName === '*') {
          // Default/anonymous export — line-based fallback
          const fileLine = lineIndex.get(exp.file);
          if (fileLine && exp.line !== undefined) {
            targetId = fileLine.get(exp.line);
          }
        } else {
          // Named entity lookup
          const fileEntities = entityIndex.get(exp.file);
          if (fileEntities) {
            targetId = fileEntities.get(entityName);
          }
        }

        if (targetId) {
          await factory.link({ type: 'EXPORTS', src: exp.id, dst: targetId });
          edgesCreated++;
        } else {
          notFound++;
          logger.debug('No entity found for export', { name: entityName, file: exp.file, line: exp.line });
        }
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      edgesCreated,
      skipped,
      notFound,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        exportsProcessed: allExports.length,
        edgesCreated,
        skipped,
        notFound,
        timeMs: Date.now() - startTime
      }
    );
  }
}
