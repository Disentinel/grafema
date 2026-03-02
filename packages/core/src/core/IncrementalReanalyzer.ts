/**
 * IncrementalReanalyzer - selective re-analysis of stale modules
 *
 * HOW IT WORKS:
 * 1. Clear all nodes for stale files (using clearFileNodesIfNeeded)
 * 2. Re-create MODULE nodes with updated contentHash
 * 3. Run CoreV2Analyzer.execute() for full analysis
 * 4. Re-run ExportEntityLinker to rebuild cross-file edges
 */

import { relative } from 'path';
import { clearFileNodesIfNeeded } from './FileNodeManager.js';
import { resolveNodeFile } from '../utils/resolveNodeFile.js';
import { CoreV2Analyzer } from '../plugins/analysis/CoreV2Analyzer.js';
import { ExportEntityLinker } from '../plugins/enrichment/ExportEntityLinker.js';
import type { GraphBackend, PluginContext, BaseNodeRecord } from '@grafema/types';
import { brandNodeInternal } from './brandNodeInternal.js';
import type { StaleModule } from './GraphFreshnessChecker.js';

export interface ReanalysisOptions {
  skipEnrichment?: boolean;
  onProgress?: (info: ReanalysisProgress) => void;
}

export interface ReanalysisProgress {
  phase: 'clearing' | 'indexing' | 'analysis' | 'enrichment';
  processedFiles: number;
  totalFiles: number;
  currentService?: string;
}

export interface ReanalysisResult {
  modulesReanalyzed: number;
  modulesDeleted: number;
  nodesCreated: number;
  edgesCreated: number;
  nodesCleared: number;
  durationMs: number;
}

interface ModuleForAnalysis {
  id: string;
  file: string;
  name: string;
  contentHash: string;
  line: number;
  type: 'MODULE';
  [key: string]: unknown;
}

export class IncrementalReanalyzer {
  private graph: GraphBackend;
  private projectPath: string;

  constructor(graph: GraphBackend, projectPath: string) {
    this.graph = graph;
    this.projectPath = projectPath;
  }

  async reanalyze(
    staleModules: StaleModule[],
    options: ReanalysisOptions = {}
  ): Promise<ReanalysisResult> {
    const startTime = Date.now();
    const touchedFiles = new Set<string>();

    let nodesCreated = 0;
    let edgesCreated = 0;
    let nodesCleared = 0;

    const deletedModules = staleModules.filter(m => m.currentHash === null);
    const modifiedModules = staleModules.filter(m => m.currentHash !== null);

    // STEP 1: Clear nodes for ALL stale files FIRST
    for (let i = 0; i < staleModules.length; i++) {
      const module = staleModules[i];
      if (options.onProgress) {
        options.onProgress({
          phase: 'clearing',
          processedFiles: i + 1,
          totalFiles: staleModules.length,
          currentService: module.file
        });
      }
      const cleared = await clearFileNodesIfNeeded(this.graph, module.file, touchedFiles);
      nodesCleared += cleared;
    }

    // STEP 2: Re-create MODULE nodes with updated hash
    const modulesToAnalyze: ModuleForAnalysis[] = [];

    for (let i = 0; i < modifiedModules.length; i++) {
      const module = modifiedModules[i];
      const absoluteFile = resolveNodeFile(module.file, this.projectPath);
      const relativePath = relative(this.projectPath, absoluteFile);

      if (options.onProgress) {
        options.onProgress({
          phase: 'indexing',
          processedFiles: i + 1,
          totalFiles: modifiedModules.length,
          currentService: module.file
        });
      }

      const moduleNode: ModuleForAnalysis = {
        id: module.id,
        type: 'MODULE',
        name: relativePath,
        file: relativePath,
        contentHash: module.currentHash!,
        line: 0
      };

      await this.graph.addNode(brandNodeInternal(moduleNode as BaseNodeRecord));
      nodesCreated++;
      modulesToAnalyze.push(moduleNode);
    }

    // STEP 3: Run CoreV2Analyzer for stale modules
    if (modulesToAnalyze.length > 0) {
      if (options.onProgress) {
        options.onProgress({
          phase: 'analysis',
          processedFiles: 0,
          totalFiles: modulesToAnalyze.length,
        });
      }

      const analyzer = new CoreV2Analyzer();

      const pluginContext: PluginContext = {
        graph: this.graph,
        manifest: { projectPath: this.projectPath },
        config: { projectPath: this.projectPath }
      };

      try {
        const result = await analyzer.execute(pluginContext);
        nodesCreated += result.created.nodes;
        edgesCreated += result.created.edges;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[IncrementalReanalyzer] CoreV2Analyzer error:`, message);
      }

      if (options.onProgress) {
        options.onProgress({
          phase: 'analysis',
          processedFiles: modulesToAnalyze.length,
          totalFiles: modulesToAnalyze.length,
        });
      }
    }

    // STEP 4: Re-run enrichment (ExportEntityLinker only)
    if (!options.skipEnrichment && modulesToAnalyze.length > 0) {
      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', processedFiles: 0, totalFiles: 1 });
      }

      const pluginContext: PluginContext = {
        graph: this.graph,
        manifest: { projectPath: this.projectPath },
        config: { projectPath: this.projectPath }
      };

      const exportEntityLinker = new ExportEntityLinker();
      try {
        const result = await exportEntityLinker.execute(pluginContext);
        edgesCreated += result.created.edges;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[IncrementalReanalyzer] ExportEntityLinker error:`, message);
      }

      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', processedFiles: 1, totalFiles: 1 });
      }
    }

    return {
      modulesReanalyzed: modulesToAnalyze.length,
      modulesDeleted: deletedModules.length,
      nodesCreated,
      edgesCreated,
      nodesCleared,
      durationMs: Date.now() - startTime
    };
  }
}
