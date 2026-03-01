/**
 * createTestOrchestrator - unified way to create Orchestrator for tests
 *
 * Automatically adds standard plugins:
 * - SimpleProjectDiscovery (added automatically by Orchestrator)
 * - JSModuleIndexer
 * - CoreV2Analyzer
 * - FetchAnalyzer (analysis)
 * - NodejsBuiltinsResolver (enrichment)
 * - RejectionPropagationEnricher (enrichment)
 * - CallbackCallResolver (enrichment)
 * - ExportEntityLinker (enrichment)
 */

import { Orchestrator } from '@grafema/core';
import { JSModuleIndexer } from '@grafema/core';
import { CoreV2Analyzer } from '@grafema/core';
import { FetchAnalyzer } from '@grafema/core';
import { NodejsBuiltinsResolver } from '@grafema/core';
import { RejectionPropagationEnricher } from '@grafema/core';
import { CallbackCallResolver } from '@grafema/core';
import { ExportEntityLinker } from '@grafema/core';

/**
 * Create Orchestrator for tests
 *
 * @param {Object} backend - TestBackend instance (RFDBServerBackend)
 * @param {Object} options - Additional options
 * @param {Array} options.extraPlugins - Extra plugins
 * @param {boolean} options.skipIndexer - Skip JSModuleIndexer
 * @param {boolean} options.skipAnalyzer - Skip CoreV2Analyzer
 * @param {boolean} options.skipEnrichment - Skip enrichment plugins
 * @returns {Orchestrator}
 */
export function createTestOrchestrator(backend, options = {}) {
  const plugins = [];

  // Base plugins (SimpleProjectDiscovery is added by Orchestrator automatically)
  if (!options.skipIndexer) {
    plugins.push(new JSModuleIndexer());
  }

  if (!options.skipAnalyzer) {
    plugins.push(new CoreV2Analyzer());
  }

  // Enrichment plugins
  if (!options.skipEnrichment) {
    plugins.push(new FetchAnalyzer());
    plugins.push(new NodejsBuiltinsResolver());
    // REG-311: Async error tracking
    plugins.push(new RejectionPropagationEnricher());
    // REG-400: Callback function reference resolution (cross-file)
    plugins.push(new CallbackCallResolver());
    // REG-579: Export entity resolution
    plugins.push(new ExportEntityLinker());
  }

  // Extra plugins
  if (options.extraPlugins) {
    plugins.push(...options.extraPlugins);
  }

  return new Orchestrator({
    graph: backend,
    plugins,
    onProgress: options.onProgress,
    forceAnalysis: options.forceAnalysis
  });
}

/**
 * Quick project analysis for tests
 *
 * @param {Object} backend - TestBackend instance
 * @param {string} projectPath - Path to project
 * @param {Object} options - Options for createTestOrchestrator
 * @returns {Promise<Object>} - manifest result
 */
export async function analyzeProject(backend, projectPath, options = {}) {
  const orchestrator = createTestOrchestrator(backend, options);
  return orchestrator.run(projectPath);
}
