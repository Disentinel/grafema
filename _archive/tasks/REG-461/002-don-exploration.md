# REG-461: Decompose handlers.ts - Exploration Report

**Date:** 2026-02-15
**Don Melton** — Tech Lead

## Executive Summary

`handlers.ts` is **1,626 lines** containing **23 handler functions**. The file is well-structured with clear comment-based sections, but violates the 300-line file size limit by 5.4x. All handlers are imported by a single file (`server.ts`), making refactoring straightforward with minimal breakage risk.

**Verdict:** The proposed split is architecturally sound. Domain-based grouping matches the existing comment structure and aligns with MCP tool definitions.

---

## 1. File Statistics

```
Line count:    1,626 lines
Handlers:      23 exported functions
Callers:       2 files (server.ts, test file)
Current dir:   packages/mcp/src/handlers/ — DOES NOT EXIST
```

---

## 2. All Exported Handler Functions

| # | Function | Lines | Args Type | Section |
|---|----------|-------|-----------|---------|
| 1 | `handleQueryGraph` | 53-131 (79) | `QueryGraphArgs` | Query |
| 2 | `handleFindCalls` | 133-207 (75) | `FindCallsArgs` | Query |
| 3 | `handleFindNodes` | 209-258 (50) | `FindNodesArgs` | Query |
| 4 | `handleTraceAlias` | 262-321 (60) | `TraceAliasArgs` | Trace/Dataflow |
| 5 | `handleTraceDataFlow` | 323-386 (64) | `TraceDataFlowArgs` | Trace/Dataflow |
| 6 | `handleCheckInvariant` | 388-433 (46) | `CheckInvariantArgs` | Trace (misplaced?) |
| 7 | `handleAnalyzeProject` | 437-466 (30) | `AnalyzeProjectArgs` | Analysis |
| 8 | `handleGetAnalysisStatus` | 468-480 (13) | none | Analysis |
| 9 | `handleGetStats` | 482-497 (16) | none | Analysis |
| 10 | `handleGetSchema` | 499-523 (25) | `GetSchemaArgs` | Analysis |
| 11 | `handleCreateGuarantee` | 530-592 (63) | `CreateGuaranteeArgs` | Guarantee |
| 12 | `handleListGuarantees` | 597-639 (43) | none | Guarantee |
| 13 | `handleCheckGuarantees` | 644-749 (106) | `CheckGuaranteesArgs` | Guarantee |
| 14 | `handleDeleteGuarantee` | 754-785 (32) | `DeleteGuaranteeArgs` | Guarantee |
| 15 | `handleGetCoverage` | 789-827 (39) | `GetCoverageArgs` | Coverage |
| 16 | `handleGetDocumentation` | 829-902 (74) | `GetDocumentationArgs` | Docs |
| 17 | `handleFindGuards` | 914-987 (74) | `FindGuardsArgs` | Guards |
| 18 | `handleGetFunctionDetails` | 1004-1083 (80) | `GetFunctionDetailsArgs` | Context |
| 19 | `formatCallsForDisplay` | 1088-1126 (39) | — | **HELPER** (not exported) |
| 20 | `handleGetContext` | 1130-1262 (133) | `GetContextArgs` | Context |
| 21 | `handleReportIssue` | 1266-1332 (67) | `ReportIssueArgs` | Issue Reporting |
| 22 | `handleReadProjectStructure` | 1336-1416 (81) | `ReadProjectStructureArgs` | Project |
| 23 | `handleWriteConfig` | 1420-1513 (94) | `WriteConfigArgs` | Project |
| 24 | `handleGetFileOverview` | 1517-1626 (110) | `GetFileOverviewArgs` | Context |

**Total:** 23 exported handlers + 1 internal helper (`formatCallsForDisplay`)

---

## 3. Imports and Dependencies

### 3.1 Internal Imports (from same package)

```typescript
// State management
import { ensureAnalyzed } from './analysis.js';
import {
  getProjectPath,
  getAnalysisStatus,
  getOrCreateBackend,
  getGuaranteeManager,
  getGuaranteeAPI,
  isAnalysisRunning
} from './state.js';

// Utilities
import {
  normalizeLimit,
  formatPaginationInfo,
  guardResponseSize,
  serializeBigInt,
  findSimilarTypes,
  textResult,
  errorResult,
} from './utils.js';

// Types
import type { 23 types from ./types.js }
```

### 3.2 External Imports (from @grafema/core)

```typescript
import {
  CoverageAnalyzer,
  findCallsInFunction,
  findContainingFunction,
  validateServices,
  validatePatterns,
  validateWorkspace,
  getOnboardingInstruction,
  GRAFEMA_VERSION,
  getSchemaVersion,
  FileOverview,
  buildNodeContext,
  getNodeDisplayName,
  formatEdgeMetadata,
  STRUCTURAL_EDGE_TYPES,
  isGuaranteeType
} from '@grafema/core';

import type { CallInfo, CallerInfo, NodeContext } from '@grafema/core';
```

### 3.3 Node.js Built-ins

```typescript
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  realpathSync
} from 'fs';
import type { Dirent } from 'fs';
import { isAbsolute, join, basename, relative } from 'path';
import { stringify as stringifyYAML } from 'yaml';
```

**Observation:** No internal helpers defined in `handlers.ts`. All utility functions are imported from `utils.js` or `@grafema/core`.

---

## 4. Files That Import from handlers.ts

### 4.1 Production Code

**File:** `packages/mcp/src/server.ts`
**Imports:** ALL 23 handlers (lines 22-46)

```typescript
import {
  handleQueryGraph,
  handleFindCalls,
  handleFindNodes,
  handleTraceAlias,
  handleTraceDataFlow,
  handleCheckInvariant,
  handleAnalyzeProject,
  handleGetAnalysisStatus,
  handleGetStats,
  handleGetSchema,
  handleCreateGuarantee,
  handleListGuarantees,
  handleCheckGuarantees,
  handleDeleteGuarantee,
  handleGetCoverage,
  handleGetDocumentation,
  handleFindGuards,
  handleReportIssue,
  handleGetFunctionDetails,
  handleGetContext,
  handleReadProjectStructure,
  handleWriteConfig,
  handleGetFileOverview,
} from './handlers.js';
```

**Usage:** Each handler is called in a switch-case statement (lines 129-224).

### 4.2 Test Code

**File:** `packages/mcp/test/tools-onboarding.test.ts`
**Imports:** 2 handlers (line 14)

```typescript
import { handleReadProjectStructure, handleWriteConfig } from '../dist/handlers.js';
```

**Impact:** Tests import from `dist/` (compiled output), not `src/`. After refactoring, the barrel export in `handlers/index.ts` will ensure tests continue working without changes.

---

## 5. Shared Types and Helpers

### 5.1 Shared Helper Functions

**NONE.** Only one internal helper exists:

- **`formatCallsForDisplay`** (lines 1088-1126) — used only by `handleGetFunctionDetails`

This helper should move to the same file as `handleGetFunctionDetails`.

### 5.2 Shared Types

All types are defined in `./types.ts`:
- Argument types (e.g., `QueryGraphArgs`, `FindCallsArgs`)
- Result types (`ToolResult`, `GraphNode`, `GraphEdge`)
- Domain types (`GuardInfo`, `CallResult`, `DatalogBinding`)

**No types need to move** — they stay in `types.ts`.

---

## 6. Assessment of Proposed Split

### 6.1 Proposed Structure

```
handlers/
├── index.ts                  ← Re-export all handlers
├── query-handlers.ts         ← handleQueryGraph, handleFindCalls, handleFindNodes
├── dataflow-handlers.ts      ← handleTraceAlias, handleTraceDataFlow, handleCheckInvariant
├── analysis-handlers.ts      ← handleAnalyzeProject, handleGetAnalysisStatus, handleGetStats, handleGetSchema
├── guarantee-handlers.ts     ← handleCreateGuarantee, handleListGuarantees, handleCheckGuarantees, handleDeleteGuarantee
├── context-handlers.ts       ← handleGetFunctionDetails, handleGetContext, handleGetFileOverview
├── project-handlers.ts       ← handleReadProjectStructure, handleWriteConfig
├── issue-handlers.ts         ← handleReportIssue
├── documentation-handlers.ts ← handleGetDocumentation
├── guard-handlers.ts         ← handleFindGuards
├── coverage-handlers.ts      ← handleGetCoverage
└── types.ts                  ← Shared types (NOT created, use existing ../types.ts)
```

### 6.2 File Size Estimates

| File | Handlers | Est. Lines | Notes |
|------|----------|------------|-------|
| `query-handlers.ts` | 3 | ~230 | `handleQueryGraph` (79), `handleFindCalls` (75), `handleFindNodes` (50) + imports (~26) |
| `dataflow-handlers.ts` | 3 | ~200 | `handleTraceAlias` (60), `handleTraceDataFlow` (64), `handleCheckInvariant` (46) + imports (~30) |
| `analysis-handlers.ts` | 4 | ~130 | Small handlers: 30 + 13 + 16 + 25 + imports (~46) |
| `guarantee-handlers.ts` | 4 | ~290 | Large file: 63 + 43 + 106 + 32 + imports (~46) |
| `context-handlers.ts` | 3 | ~430 | **LARGEST**: 80 + 133 + 110 + helper (39) + imports (~68) |
| `project-handlers.ts` | 2 | ~220 | 81 + 94 + imports (~45) |
| `issue-handlers.ts` | 1 | ~110 | 67 + imports (~43) |
| `documentation-handlers.ts` | 1 | ~120 | 74 + imports (~46) |
| `guard-handlers.ts` | 1 | ~120 | 74 + imports (~46) |
| `coverage-handlers.ts` | 1 | ~85 | 39 + imports (~46) |
| `index.ts` | — | ~50 | Barrel export |

**Total:** 11 files, all under 500 lines.

### 6.3 Issues Found

#### Issue 1: `handleCheckInvariant` Misplaced

**Current section:** "TRACE HANDLERS" (line 260)
**Actual domain:** Guarantees — uses Datalog queries, checks violations like `handleCheckGuarantees`

**Recommendation:** Move to `guarantee-handlers.ts`.

#### Issue 2: `context-handlers.ts` Too Large

430 lines exceeds 300-line target. Three complex handlers with deep nesting.

**Options:**
1. **Split by granularity:**
   - `function-details-handler.ts` — `handleGetFunctionDetails` + helper
   - `node-context-handler.ts` — `handleGetContext`
   - `file-overview-handler.ts` — `handleGetFileOverview`
2. **Keep together** — handlers are semantically related (all provide code context)

**Recommendation:** Keep together for now. File is under 500 lines (critical threshold). If any handler grows beyond 150 lines, revisit split.

#### Issue 3: Many Single-Handler Files

Files with 1 handler seem excessive:
- `issue-handlers.ts` (110 lines)
- `documentation-handlers.ts` (120 lines)
- `guard-handlers.ts` (120 lines)
- `coverage-handlers.ts` (85 lines)

**Options:**
1. **Keep separated** — clear boundaries, easy to locate
2. **Group into `misc-handlers.ts`** — reduces file count

**Recommendation:** Keep separated. These are distinct domains with clear tool boundaries. Single-file-per-handler is acceptable for well-bounded features.

---

## 7. Shared State and Dependencies

### 7.1 No Shared Mutable State

All handlers are **pure functions** that:
1. Call `ensureAnalyzed()` or `getOrCreateBackend()` to get DB instance
2. Query graph
3. Return `ToolResult`

No handler modifies global state directly.

### 7.2 Common Patterns

All handlers follow this pattern:

```typescript
export async function handleXxx(args: XxxArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { param1, param2 = default } = args;

  try {
    // Query graph
    const result = await db.query(...);

    // Format output
    return textResult(formatOutput(result));
  } catch (error) {
    return errorResult(message);
  }
}
```

**Observation:** No architectural coupling between handlers. Clean decomposition.

---

## 8. Revised File Grouping

Based on analysis, here's the **revised split** with `handleCheckInvariant` moved:

```
handlers/
├── index.ts                   ← Barrel export (~50 lines)
├── query-handlers.ts          ← 3 handlers (~230 lines)
│   ├── handleQueryGraph
│   ├── handleFindCalls
│   └── handleFindNodes
├── dataflow-handlers.ts       ← 2 handlers (~155 lines) [REMOVED handleCheckInvariant]
│   ├── handleTraceAlias
│   └── handleTraceDataFlow
├── analysis-handlers.ts       ← 4 handlers (~130 lines)
│   ├── handleAnalyzeProject
│   ├── handleGetAnalysisStatus
│   ├── handleGetStats
│   └── handleGetSchema
├── guarantee-handlers.ts      ← 5 handlers (~336 lines) [ADDED handleCheckInvariant]
│   ├── handleCreateGuarantee
│   ├── handleListGuarantees
│   ├── handleCheckGuarantees
│   ├── handleCheckInvariant   ← MOVED FROM dataflow-handlers.ts
│   └── handleDeleteGuarantee
├── context-handlers.ts        ← 3 handlers + 1 helper (~430 lines)
│   ├── handleGetFunctionDetails
│   ├── formatCallsForDisplay  ← internal helper
│   ├── handleGetContext
│   └── handleGetFileOverview
├── project-handlers.ts        ← 2 handlers (~220 lines)
│   ├── handleReadProjectStructure
│   └── handleWriteConfig
├── coverage-handlers.ts       ← 1 handler (~85 lines)
│   └── handleGetCoverage
├── guard-handlers.ts          ← 1 handler (~120 lines)
│   └── handleFindGuards
├── documentation-handlers.ts  ← 1 handler (~120 lines)
│   └── handleGetDocumentation
└── issue-handlers.ts          ← 1 handler (~110 lines)
    └── handleReportIssue
```

**Total:** 11 files, all under 500 lines, 9 under 300 lines.

---

## 9. Migration Plan Outline

### Phase 1: Create Directory + Barrel Export

1. Create `packages/mcp/src/handlers/` directory
2. Create `index.ts` with:
   ```typescript
   // Re-export all handlers for backward compatibility
   export * from './query-handlers.js';
   export * from './dataflow-handlers.js';
   // ... etc
   ```
3. Update `server.ts` import:
   ```typescript
   // Before: import { ... } from './handlers.js';
   // After:  import { ... } from './handlers/index.js';
   ```

### Phase 2: Move Handlers

For each domain file:
1. Create file (e.g., `query-handlers.ts`)
2. Copy relevant handlers + imports
3. Remove unused imports
4. Add to barrel export

### Phase 3: Delete Old File

1. Verify all tests pass
2. Delete `handlers.ts`
3. Verify production imports resolve correctly

### Phase 4: Validate

1. Run full test suite
2. Check MCP server starts without errors
3. Smoke test: call each handler via MCP

---

## 10. Risks and Mitigations

### Risk 1: Import Path Changes Break Tests

**Impact:** Tests import from `../dist/handlers.js`
**Mitigation:** Barrel export at `handlers/index.ts` ensures old import path works

### Risk 2: Circular Dependencies

**Impact:** If handlers import from each other, could create cycles
**Mitigation:** Current analysis shows NO inter-handler dependencies. All handlers are independent.

### Risk 3: Missing Imports

**Impact:** Each file needs correct subset of imports
**Mitigation:** TypeScript compiler will catch missing imports immediately

---

## 11. Exact Line Count

```bash
$ wc -l packages/mcp/src/handlers.ts
1626 packages/mcp/src/handlers.ts
```

**Confirmed:** 1,626 lines

---

## 12. Recommendations

1. **Proceed with decomposition** — file is 5.4x over limit, clean split possible
2. **Use revised grouping** — move `handleCheckInvariant` to guarantee-handlers
3. **Keep single-handler files** — clear boundaries trump file count optimization
4. **Watch `context-handlers.ts`** — at 430 lines, one level below critical threshold
5. **Add test** — verify barrel export works before deleting original file

---

## Appendix: Handler Categorization

| Category | Handlers | Purpose |
|----------|----------|---------|
| **Query** | 3 | Execute Datalog queries, find nodes/calls |
| **Dataflow** | 2 | Trace variable aliases and data flow |
| **Analysis** | 4 | Trigger analysis, get stats/schema/status |
| **Guarantee** | 5 | Create, check, list, delete guarantees + invariants |
| **Context** | 3 | Get function/node/file details with edges |
| **Project** | 2 | Read structure, write config (onboarding) |
| **Coverage** | 1 | Calculate analysis coverage |
| **Guards** | 1 | Find conditional guards protecting nodes |
| **Documentation** | 1 | Get built-in documentation |
| **Issue** | 1 | Report bugs to GitHub |

**Total:** 23 handlers across 10 domains
