/**
 * IncrementalReanalyzer - selective re-analysis of stale modules
 *
 * HOW IT WORKS:
 * 1. Clear all nodes for stale files (using clearFileNodesIfNeeded)
 * 2. Re-create MODULE nodes with updated contentHash
 * 3. Run JSASTAnalyzer.analyzeModule() for each stale module
 * 4. Re-run enrichment plugins to rebuild cross-file edges
 */

import { relative } from 'path';
import { clearFileNodesIfNeeded } from './FileNodeManager.js';
import { resolveNodeFile } from '../utils/resolveNodeFile.js';
import { JSASTAnalyzer } from '../plugins/analysis/JSASTAnalyzer.js';
import { InstanceOfResolver } from '../plugins/enrichment/InstanceOfResolver.js';
import { ImportExportLinker } from '../plugins/enrichment/ImportExportLinker.js';
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

    // STEP 3: Run JSASTAnalyzer for each module
    const analyzer = new JSASTAnalyzer();

    for (let i = 0; i < modulesToAnalyze.length; i++) {
      const module = modulesToAnalyze[i];

      if (options.onProgress) {
        options.onProgress({
          phase: 'analysis',
          processedFiles: i + 1,
          totalFiles: modulesToAnalyze.length,
          currentService: module.file
        });
      }

      try {
        const result = await analyzer.analyzeModule(
          module as Parameters<typeof analyzer.analyzeModule>[0],
          this.graph,
          this.projectPath
        );
        nodesCreated += result.nodes;
        edgesCreated += result.edges;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[IncrementalReanalyzer] Failed to analyze ${module.file}:`, message);
      }
    }

    // STEP 4: Re-run enrichment plugins
    if (!options.skipEnrichment && modulesToAnalyze.length > 0) {
      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', processedFiles: 0, totalFiles: 2 });
      }

      const pluginContext: PluginContext = {
        graph: this.graph,
        manifest: { projectPath: this.projectPath },
        config: { projectPath: this.projectPath }
      };

      const instanceOfResolver = new InstanceOfResolver();
      try {
        const result1 = await instanceOfResolver.execute(pluginContext);
        edgesCreated += result1.created.edges;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[IncrementalReanalyzer] InstanceOfResolver error:`, message);
      }

      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', processedFiles: 1, totalFiles: 2 });
      }

      const importExportLinker = new ImportExportLinker();
      try {
        const result2 = await importExportLinker.execute(pluginContext);
        edgesCreated += result2.created.edges;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[IncrementalReanalyzer] ImportExportLinker error:`, message);
      }

      if (options.onProgress) {
        options.onProgress({ phase: 'enrichment', processedFiles: 2, totalFiles: 2 });
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
