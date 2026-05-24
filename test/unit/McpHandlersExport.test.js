/**
 * Behavior-locking test for MCP handler exports — REG-461
 *
 * Verifies the public API surface of packages/mcp handlers.
 * This test runs BEFORE and AFTER refactoring to ensure the barrel
 * export preserves all 26 handler functions without leaking internals.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import * as handlers from '../../packages/mcp/dist/handlers/index.js';

const EXPECTED_HANDLERS = [
  'handleQueryGraph',
  'handleFindCalls',
  'handleFindNodes',
  'handleTraceAlias',
  'handleTraceDataflow',
  'handleCheckInvariant',
  'handleDiscoverServices',
  'handleAnalyzeProject',
  'handleGetAnalysisStatus',
  'handleGetStats',
  'handleGetSchema',
  'handleCreateGuarantee',
  'handleListGuarantees',
  'handleCheckGuarantees',
  'handleDeleteGuarantee',
  'handleGetCoverage',
  'handleGetDocumentation',
  'handleFindGuards',
  'handleGetFunctionDetails',
  'handleGetContext',
  'handleReportIssue',
  'handleReadProjectStructure',
  'handleWriteConfig',
  'handleGetFileOverview',
  'handleGetNode',
  'handleGetNeighbors',
  'handleTraverseGraph',
  'handleAddKnowledge',
  'handleQueryKnowledge',
  'handleQueryDecisions',
  'handleSupersedeFact',
  'handleGetKnowledgeStats',
  // git-ingest handlers disabled (US-17), see handlers/index.ts
  // 'handleGitChurn',
  // 'handleGitCoChange',
  // 'handleGitOwnership',
  // 'handleGitArchaeology',
  'handleRemember',
  'handleRecall',
  'handleSemanticSearch',
  'handleExploreEntity',
  'handleAddAssertion',
  'handleUpdateAssertion',
  'handleDeleteAssertion',
  'handleEnoxQuery',
  'handleEnoxTraverse',
  'handleEnoxStats',
  'handleRecentActivity',
  'handleUpdateNode',
  'handleSaveDocument',
  'handleDescribe',
  'handleQueryGraphql',
  'handleQueryRegistry',
  'handleExplain',
  'handleTraceCalls',
  'handleGetShape',
  'handleTraceEffects',
  'handleFindSharedBehaviors',
];

describe('MCP handlers export surface', () => {
  it('should export exactly 53 handler functions', () => {
    const exportedKeys = Object.keys(handlers).filter(
      k => typeof handlers[k] === 'function'
    );
    assert.equal(
      exportedKeys.length,
      EXPECTED_HANDLERS.length,
      `Expected ${EXPECTED_HANDLERS.length} function exports, got ${exportedKeys.length}: ${exportedKeys.join(', ')}`
    );
  });

  for (const name of EXPECTED_HANDLERS) {
    it(`should export ${name} as a function`, () => {
      assert.equal(
        typeof handlers[name],
        'function',
        `${name} should be exported as a function`
      );
    });
  }

  it('should not leak internal helpers as exports', () => {
    const allKeys = Object.keys(handlers);
    const unexpected = allKeys.filter(k => !EXPECTED_HANDLERS.includes(k));
    assert.deepEqual(
      unexpected,
      [],
      `Unexpected exports found: ${unexpected.join(', ')}`
    );
  });
});
