/**
 * CoreV2Analyzer — core-v2 three-stage pipeline as a drop-in analysis plugin.
 *
 * Replaces JSASTAnalyzer when `--engine v2` is passed. Depends on JSModuleIndexer
 * for file discovery (MODULE nodes). Skips enrichment/validation plugins since
 * core-v2 has its own resolution stages.
 *
 * Pipeline: walkFile() → resolveFileRefs() per file, then resolveProject() cross-file.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import { walkFile, resolveFileRefs, resolveProject, jsRegistry } from '@grafema/core-v2';
import type { FileResult, GraphNode, GraphEdge } from '@grafema/core-v2';
import { readFileSync } from 'fs';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, InputEdge, AnyBrandedNode } from '@grafema/types';

interface AnalysisManifest {
  projectPath: string;
  [key: string]: unknown;
}

export class CoreV2Analyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CoreV2Analyzer',
      phase: 'ANALYSIS' as const,
      dependencies: ['JSModuleIndexer'],
      managesBatch: true,
      creates: {
        nodes: [
          'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT', 'SCOPE', 'CALL',
          'IMPORT', 'EXPORT', 'LITERAL', 'EXTERNAL', 'FILE', 'INTERFACE',
          'TYPE_ALIAS', 'ENUM', 'PARAMETER', 'GETTER', 'SETTER', 'NAMESPACE',
          'PROPERTY', 'EXPRESSION', 'PROPERTY_ACCESS', 'BRANCH', 'LOOP',
          'TRY_BLOCK', 'CATCH_BLOCK', 'CASE', 'FINALLY_BLOCK', 'SIDE_EFFECT',
          'META_PROPERTY', 'LABEL', 'STATIC_BLOCK', 'DECORATOR',
          'ENUM_MEMBER', 'TYPE_REFERENCE', 'TYPE_PARAMETER', 'LITERAL_TYPE',
          'CONDITIONAL_TYPE', 'INFER_TYPE', 'EXTERNAL_MODULE',
        ],
        edges: [
          'CONTAINS', 'DECLARES', 'CALLS', 'HAS_SCOPE', 'CAPTURES', 'ASSIGNED_FROM',
          'READS_FROM', 'WRITES_TO', 'MODIFIES', 'FLOWS_INTO', 'PASSES_ARGUMENT',
          'RECEIVES_ARGUMENT', 'RETURNS', 'THROWS', 'YIELDS', 'AWAITS',
          'IMPORTS', 'IMPORTS_FROM', 'EXPORTS', 'DEPENDS_ON', 'EXTENDS',
          'IMPLEMENTS', 'HAS_TYPE', 'HAS_TYPE_PARAMETER', 'RETURNS_TYPE',
          'DEFAULTS_TO', 'CONSTRAINED_BY', 'UNION_MEMBER', 'INTERSECTS_WITH',
          'INFERS', 'ALIASES', 'RESOLVES_TO', 'SHADOWS', 'DELETES',
          'CALLS_ON', 'CHAINS_FROM', 'BINDS_THIS_TO', 'INVOKES', 'DELEGATES_TO',
          'ITERATES_OVER', 'SPREADS_FROM', 'USES', 'CATCHES_FROM',
          'HAS_BODY', 'HAS_CONDITION', 'HAS_CONSEQUENT', 'HAS_ALTERNATE',
          'HAS_INIT', 'HAS_UPDATE', 'HAS_CASE', 'HAS_CATCH', 'HAS_FINALLY',
          'HAS_PROPERTY', 'HAS_ELEMENT', 'HAS_DEFAULT', 'DECORATED_BY',
          'OVERRIDES', 'ACCESSES_PRIVATE', 'LISTENS_TO', 'MERGES_WITH',
          'IMPLEMENTS_OVERLOAD', 'HAS_OVERLOAD', 'EXTENDS_SCOPE_WITH',
        ],
      },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { graph } = context;
    const manifest = context.manifest as AnalysisManifest | undefined;
    const projectPath = manifest?.projectPath ?? '';
    const deferIndex = context.deferIndexing ?? false;

    const modules = await this.getModules(graph);
    logger.info('CoreV2Analyzer starting', { modules: modules.length });

    const fileResults: FileResult[] = [];
    let totalNodes = 0;
    let totalEdges = 0;
    let errors = 0;

    for (const mod of modules) {
      const filePath = mod.file ?? '';
      try {
        const absPath = resolveNodeFile(filePath, projectPath);
        const code = readFileSync(absPath, 'utf-8');
        const walkResult = await walkFile(code, filePath, jsRegistry);
        const result = resolveFileRefs(walkResult);
        fileResults.push(result);

        if (graph.beginBatch) graph.beginBatch();

        const nodes = this.mapNodes(result.nodes);
        const edges = this.mapEdges(result.edges);

        if (nodes.length > 0) await graph.addNodes(nodes as unknown as AnyBrandedNode[]);
        if (edges.length > 0) await graph.addEdges(edges as InputEdge[]);
        totalNodes += nodes.length;
        totalEdges += edges.length;

        if (graph.commitBatch) {
          await graph.commitBatch(
            ['CoreV2Analyzer', 'ANALYSIS', filePath],
            deferIndex,
            ['MODULE'],
          );
        }
      } catch (err) {
        errors++;
        if (graph.abortBatch) graph.abortBatch();
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to analyze module', { file: filePath, error: msg });
      }
    }

    // Stage 3: cross-file resolution
    const resolved = resolveProject(fileResults);
    if (resolved.edges.length > 0) {
      if (graph.beginBatch) graph.beginBatch();
      await graph.addEdges(this.mapEdges(resolved.edges) as InputEdge[]);
      totalEdges += resolved.edges.length;
      if (graph.commitBatch) {
        await graph.commitBatch(
          ['CoreV2Analyzer', 'ANALYSIS', 'cross-file'],
          deferIndex,
        );
      }
    }

    if (deferIndex && graph.rebuildIndexes) {
      await graph.rebuildIndexes();
    }

    logger.info('CoreV2Analyzer complete', {
      nodes: totalNodes,
      edges: totalEdges,
      errors,
      stage3: resolved.stats,
      unresolved: resolved.unresolved.length,
    });

    return createSuccessResult({ nodes: totalNodes, edges: totalEdges });
  }

  /** Flatten metadata into top-level props and filter out MODULE nodes. */
  private mapNodes(nodes: GraphNode[]): Record<string, unknown>[] {
    return nodes
      .filter(n => n.type !== 'MODULE')
      .map(n => {
        const { metadata, ...rest } = n;
        return { ...rest, ...(metadata ?? {}) };
      });
  }

  /** Flatten edge metadata into top-level props. */
  private mapEdges(edges: GraphEdge[]): Record<string, unknown>[] {
    return edges.map(e => {
      const { metadata, ...rest } = e;
      return { ...rest, ...(metadata ?? {}) };
    });
  }
}
