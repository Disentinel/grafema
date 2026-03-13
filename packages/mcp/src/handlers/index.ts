/**
 * MCP Tool Handlers — barrel export
 */

export { handleQueryGraph, handleFindCalls, handleFindNodes } from './query-handlers.js';
export { handleTraceAlias, handleTraceDataFlow, handleCheckInvariant } from './dataflow-handlers.js';
export { handleAnalyzeProject, handleGetAnalysisStatus, handleGetStats, handleGetSchema } from './analysis-handlers.js';
export { handleCreateGuarantee, handleListGuarantees, handleCheckGuarantees, handleDeleteGuarantee } from './guarantee-handlers.js';
export { handleGetFunctionDetails, handleGetContext, handleGetFileOverview } from './context-handlers.js';
export { handleReadProjectStructure, handleWriteConfig } from './project-handlers.js';
export { handleGetCoverage } from './coverage-handlers.js';
export { handleFindGuards } from './guard-handlers.js';
export { handleGetDocumentation } from './documentation-handlers.js';
export { handleReportIssue } from './issue-handlers.js';
export { handleGetNode, handleGetNeighbors, handleTraverseGraph } from './graph-handlers.js';
export { handleAddKnowledge, handleQueryKnowledge, handleQueryDecisions, handleSupersedeFact, handleGetKnowledgeStats } from './knowledge-handlers.js';
// Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
// export { handleGitChurn, handleGitCoChange, handleGitOwnership, handleGitArchaeology } from './knowledge-handlers.js';
export { handleDescribe } from './notation-handlers.js';
export { handleGraphQLQuery } from './graphql-handlers.js';
