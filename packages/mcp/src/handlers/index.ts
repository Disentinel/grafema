/**
 * MCP Tool Handlers — barrel export
 */

export { handleQueryGraph, handleFindCalls, handleFindNodes } from './query-handlers.js';
export { handleTraceAlias, handleTraceDataflow, handleTraceCalls, handleCheckInvariant, handleExplain, handleTraceEffects } from './dataflow-handlers.js';
export type { ExplainArgs } from './dataflow-handlers.js';
export { handleDiscoverServices, handleAnalyzeProject, handleGetAnalysisStatus, handleGetStats, handleGetSchema } from './analysis-handlers.js';
export { handleCreateGuarantee, handleListGuarantees, handleCheckGuarantees, handleDeleteGuarantee } from './guarantee-handlers.js';
export { handleGetFunctionDetails, handleGetContext, handleGetFileOverview, handleGetShape } from './context-handlers.js';
export { handleReadProjectStructure, handleWriteConfig } from './project-handlers.js';
export { handleGetCoverage } from './coverage-handlers.js';
export { handleFindGuards } from './guard-handlers.js';
export { handleGetDocumentation } from './documentation-handlers.js';
export { handleReportIssue } from './issue-handlers.js';
export { handleGetNode, handleGetNeighbors, handleTraverseGraph } from './graph-handlers.js';
export { handleAddKnowledge, handleQueryKnowledge, handleQueryDecisions, handleSupersedeFact, handleGetKnowledgeStats } from './knowledge-handlers.js';
export { handleRemember, handleRecall, handleSemanticSearch, handleExploreEntity, handleAddAssertion, handleUpdateAssertion, handleDeleteAssertion, handleEnoxQuery, handleEnoxTraverse, handleEnoxStats, handleRecentActivity, handleUpdateNode, handleSaveDocument } from './enox-handlers.js';
// Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
// export { handleGitChurn, handleGitCoChange, handleGitOwnership, handleGitArchaeology } from './knowledge-handlers.js';
export { handleDescribe } from './notation-handlers.js';
export { handleQueryGraphql } from './graphql-handlers.js';
export { handleQueryRegistry } from './registry-handlers.js';
export { handleFindSharedBehaviors } from './behavior-handlers.js';
