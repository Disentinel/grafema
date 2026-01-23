/**
 * Shared test setup helper for semantic ID tests
 *
 * Extracted from duplicated setupTest() functions in:
 * - CallExpressionVisitorSemanticIds.test.js
 * - VariableVisitorSemanticIds.test.js
 * - SemanticIdPipelineIntegration.test.js
 *
 * @see REG-143
 */

import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestOrchestrator } from './createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files and run analysis
 *
 * @param {Object} backend - TestBackend instance (RFDBServerBackend)
 * @param {Object} files - Map of filename to content
 * @param {Object} options - Options object
 * @param {string} options.testLabel - Label for test directory naming (e.g., 'call-semantic', 'var-semantic')
 * @param {Array} options.extraPlugins - Additional plugins for orchestrator
 * @param {boolean} options.skipIndexer - Skip JSModuleIndexer
 * @param {boolean} options.skipAnalyzer - Skip JSASTAnalyzer
 * @param {boolean} options.skipEnrichment - Skip enrichment plugins
 * @returns {Promise<{testDir: string}>}
 */
export async function setupSemanticTest(backend, files, options = {}) {
  const testLabel = options.testLabel || 'semantic';
  const testDir = join(tmpdir(), `grafema-test-${testLabel}-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-${testLabel}-${testCounter}`,
      type: 'module'
    })
  );

  // Create test files (supports nested directories)
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    const dir = join(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  const orchestrator = createTestOrchestrator(backend, options);
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Reset the test counter (useful for deterministic tests)
 */
export function resetTestCounter() {
  testCounter = 0;
}
