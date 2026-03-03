/**
 * CoreV3Analyzer — Haskell-based per-file analysis pipeline.
 *
 * Pipeline: OXC parser (scripts/parse.js) → Haskell binary (grafema-analyzer) → FileAnalysis JSON.
 * Replaces CoreV2Analyzer's JS walkFile/resolveFileRefs with a native binary.
 *
 * Contract A: OXC ESTree JSON piped to Haskell binary stdin
 * Contract B: Haskell outputs FileAnalysis JSON to stdout
 * Contract C: This plugin maps output to RFDB wire format via commitBatch
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, InputEdge, AnyBrandedNode } from '@grafema/types';
import { fileURLToPath } from 'url';

/** Contract B: FileAnalysis JSON from Haskell binary */
interface FileAnalysisOutput {
  file: string;
  moduleId: string;
  nodes: V3GraphNode[];
  edges: V3GraphEdge[];
  unresolvedRefs: V3DeferredRef[];
}

interface V3GraphNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line: number;
  column: number;
  exported: boolean;
  metadata?: Record<string, unknown>;
}

interface V3GraphEdge {
  src: string;
  dst: string;
  type: string;
  metadata?: Record<string, unknown>;
}

interface V3DeferredRef {
  kind: string;
  name: string;
  fromNodeId: string;
  edgeType: string;
  scopeId?: string;
  source?: string;
  file: string;
  line: number;
  column: number;
  receiver?: string;
  metadata?: Record<string, unknown>;
}

interface AnalysisManifest {
  projectPath: string;
  [key: string]: unknown;
}

export class CoreV3Analyzer extends Plugin {
  private coreV3Path: string;
  private analyzerBinary: string | null = null;

  constructor(config: Record<string, unknown> = {}) {
    super(config);
    // Resolve path to core-v3 package relative to this file
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.coreV3Path = join(thisDir, '..', '..', '..', '..', 'core-v3');
  }

  get metadata(): PluginMetadata {
    return {
      name: 'CoreV3Analyzer',
      phase: 'ANALYSIS' as const,
      dependencies: ['JSModuleIndexer'],
      managesBatch: true,
      creates: {
        nodes: [
          'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT', 'CALL',
          'IMPORT', 'EXPORT', 'PARAMETER', 'PROPERTY_ACCESS',
          'INTERFACE', 'TYPE_ALIAS', 'ENUM', 'NAMESPACE',
          // Domain nodes from LibraryDef system
          'http:route', 'http:route:path', 'express:middleware', 'express:listen',
        ],
        edges: [
          'CONTAINS', 'DECLARES', 'CALLS', 'ASSIGNED_FROM',
          'READS_FROM', 'WRITES_TO', 'PASSES_ARGUMENT',
          'RECEIVES_ARGUMENT', 'RETURNS', 'THROWS',
          'IMPORTS_FROM', 'EXPORTS', 'RE_EXPORTS',
          'HAS_METHOD', 'EXPOSES', 'MOUNTS', 'LISTENS_ON',
          'HAS_PATH', 'HANDLES',
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

    // Find the Haskell binary
    this.analyzerBinary = this.findAnalyzerBinary();
    if (!this.analyzerBinary) {
      logger.error('grafema-analyzer binary not found. Run: cd packages/core-v3 && cabal build');
      return createSuccessResult({ nodes: 0, edges: 0 });
    }

    const parseScript = join(this.coreV3Path, 'scripts', 'parse.js');

    const modules = await this.getModules(graph);
    logger.info('CoreV3Analyzer starting', { modules: modules.length });

    const allUnresolvedRefs: V3DeferredRef[] = [];
    let totalNodes = 0;
    let totalEdges = 0;
    let errors = 0;

    for (const mod of modules) {
      const filePath = mod.file ?? '';
      try {
        const absPath = resolveNodeFile(filePath, projectPath);

        // Pipeline: parse.js → grafema-analyzer
        const analysis = this.runPipeline(parseScript, absPath, filePath);

        // Collect deferred refs for cross-file resolution
        allUnresolvedRefs.push(...analysis.unresolvedRefs);

        if (graph.beginBatch) graph.beginBatch();

        // Contract C: Map to RFDB wire format
        const nodes = this.mapNodes(analysis.nodes);
        const edges = this.mapEdges(analysis.edges);

        if (nodes.length > 0) await graph.addNodes(nodes as unknown as AnyBrandedNode[]);
        if (edges.length > 0) await graph.addEdges(edges as InputEdge[]);
        totalNodes += nodes.length;
        totalEdges += edges.length;

        if (graph.commitBatch) {
          await graph.commitBatch(
            ['CoreV3Analyzer', 'ANALYSIS', filePath],
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

    if (deferIndex && graph.rebuildIndexes) {
      await graph.rebuildIndexes();
    }

    logger.info('CoreV3Analyzer complete', {
      nodes: totalNodes,
      edges: totalEdges,
      errors,
      unresolvedRefs: allUnresolvedRefs.length,
    });

    return createSuccessResult({ nodes: totalNodes, edges: totalEdges });
  }

  /**
   * Run the OXC → Haskell pipeline for a single file.
   * parse.js produces ESTree JSON, piped to grafema-analyzer.
   */
  private runPipeline(
    parseScript: string,
    absPath: string,
    relPath: string,
  ): FileAnalysisOutput {
    // Step 1: OXC parse
    const astJson = execFileSync('node', [parseScript, absPath], {
      maxBuffer: 50 * 1024 * 1024, // 50MB for large files
      encoding: 'utf-8',
    });

    // Step 2: Haskell analyzer
    const output = execFileSync(this.analyzerBinary!, [relPath], {
      input: astJson,
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf-8',
    });

    return JSON.parse(output) as FileAnalysisOutput;
  }

  /** Find the cabal-built analyzer binary */
  private findAnalyzerBinary(): string | null {
    try {
      // Try cabal list-bin to find the built binary
      const binPath = execFileSync('cabal', ['list-bin', 'grafema-analyzer'], {
        cwd: this.coreV3Path,
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${process.env.HOME}/.ghcup/bin:${process.env.PATH}` },
      }).trim();

      // Verify it exists
      readFileSync(binPath);
      return binPath;
    } catch {
      return null;
    }
  }

  /**
   * Contract C: Map V3 GraphNode to RFDB wire format.
   * Flattens metadata into top-level props, filters out MODULE nodes.
   */
  private mapNodes(nodes: V3GraphNode[]): Record<string, unknown>[] {
    return nodes
      .filter(n => n.type !== 'MODULE')
      .map(n => {
        const { metadata, ...rest } = n;
        return { ...rest, ...(metadata ?? {}) };
      });
  }

  /** Contract C: Flatten edge metadata into top-level props. */
  private mapEdges(edges: V3GraphEdge[]): Record<string, unknown>[] {
    return edges.map(e => {
      const { metadata, ...rest } = e;
      return { ...rest, ...(metadata ?? {}) };
    });
  }
}
