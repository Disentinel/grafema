# REG-461: Decompose handlers.ts (1,626 → ~50 lines)

## Goal

Split handlers.ts (1,626 lines, 23 handler functions) into domain-specific files.

## Current State

* 1,626 lines, 3x over Uncle Bob's 500-line limit
* Growing (+38% since Feb 3) — every new MCP tool adds more code
* 23 exported handler functions, no structure

## Approach

Split into `packages/mcp/src/handlers/` directory:

```
handlers/
├── index.ts                  ← Re-export all handlers (~50 lines)
├── query-handlers.ts         ← handleQueryGraph, handleFindCalls, handleFindNodes
├── dataflow-handlers.ts      ← handleTraceAlias, handleTraceDataFlow
├── analysis-handlers.ts      ← handleAnalyzeProject, handleGetAnalysisStatus, handleGetStats
├── guarantee-handlers.ts     ← handleCreateGuarantee, handleListGuarantees, handleCheckGuarantees, handleDeleteGuarantee
├── context-handlers.ts       ← handleGetFunctionDetails, handleGetContext, handleGetFileOverview
├── project-handlers.ts       ← handleReadProjectStructure, handleWriteConfig
├── issue-handlers.ts         ← handleReportIssue
├── documentation-handlers.ts ← handleGetDocumentation, handleGetSchema
├── guard-handlers.ts         ← handleFindGuards
├── coverage-handlers.ts      ← handleGetCoverage
└── types.ts                  ← Shared types
```

## Acceptance Criteria

* handlers.ts replaced by handlers/index.ts (~50 lines, re-exports only)
* All domain files < 500 lines
* All 23 MCP tools work (integration test)
* No public API changes (callers import from same path via index)
