/**
 * createTestOrchestrator - унифицированный способ создания Orchestrator для тестов
 *
 * Автоматически добавляет стандартные плагины:
 * - SimpleProjectDiscovery (добавляется автоматически Orchestrator'ом)
 * - JSModuleIndexer
 * - JSASTAnalyzer
 * - MethodCallResolver (enrichment) - creates CALLS edges for method calls
 * - ArgumentParameterLinker (enrichment) - creates RECEIVES_ARGUMENT edges
 * - InstanceOfResolver (enrichment)
 * - FetchAnalyzer (enrichment)
 * - ImportExportLinker (enrichment)
 */

import { Orchestrator } from '@grafema/core';
import { JSModuleIndexer } from '@grafema/core';
import { JSASTAnalyzer } from '@grafema/core';
import { MethodCallResolver } from '@grafema/core';
import { ArgumentParameterLinker } from '@grafema/core';
import { InstanceOfResolver } from '@grafema/core';
import { FetchAnalyzer } from '@grafema/core';
import { ImportExportLinker } from '@grafema/core';
import { NodejsBuiltinsResolver } from '@grafema/core';

/**
 * Создать Orchestrator для тестов
 *
 * @param {Object} backend - TestBackend instance (RFDBServerBackend)
 * @param {Object} options - Дополнительные опции
 * @param {Array} options.extraPlugins - Дополнительные плагины
 * @param {boolean} options.skipIndexer - Пропустить JSModuleIndexer
 * @param {boolean} options.skipAnalyzer - Пропустить JSASTAnalyzer
 * @param {boolean} options.skipEnrichment - Пропустить enrichment плагины
 * @returns {Orchestrator}
 */
export function createTestOrchestrator(backend, options = {}) {
  const plugins = [];

  // Базовые плагины (SimpleProjectDiscovery добавляется Orchestrator'ом автоматически)
  if (!options.skipIndexer) {
    plugins.push(new JSModuleIndexer());
  }

  if (!options.skipAnalyzer) {
    plugins.push(new JSASTAnalyzer());
  }

  // Enrichment плагины
  if (!options.skipEnrichment) {
    plugins.push(new MethodCallResolver());
    plugins.push(new ArgumentParameterLinker());
    plugins.push(new InstanceOfResolver());
    plugins.push(new FetchAnalyzer());
    plugins.push(new ImportExportLinker());
    plugins.push(new NodejsBuiltinsResolver());
  }

  // Дополнительные плагины
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
 * Быстрый анализ проекта для тестов
 *
 * @param {Object} backend - TestBackend instance
 * @param {string} projectPath - Путь к проекту
 * @param {Object} options - Опции для createTestOrchestrator
 * @returns {Promise<Object>} - manifest результат
 */
export async function analyzeProject(backend, projectPath, options = {}) {
  const orchestrator = createTestOrchestrator(backend, options);
  return orchestrator.run(projectPath);
}
