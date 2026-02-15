# Don's Plan: REG-461 — Decompose handlers.ts

**Date:** 2026-02-15
**Workflow:** v2.0 Mini-MLA (no Uncle Bob — refactoring IS the task)

## Vision Alignment

This refactoring directly supports maintainability without changing behavior. Single-file decomposition is pure mechanical work that reduces cognitive load for future development.

**Key principle:** This is a REFACTORING task — behavior-preserving transformation. No logic changes, no new features, no "improvements" while we're here.

## Approach

**Pure mechanical refactoring:**
- Move code, don't change it
- Preserve all imports, exports, and behavior
- TypeScript compiler + existing tests ensure correctness
- Single atomic commit for the move (after locking tests)

**Success criteria:**
1. All 23 handlers work identically before and after
2. `server.ts` and `tools-onboarding.test.ts` import successfully
3. TypeScript compilation passes
4. All existing tests pass
5. No behavior changes (verified by tests)

## Implementation Steps

### Kent's Scope (Tests)

**Goal:** Lock current behavior before any file operations.

**Test to write:** `test/unit/mcp-handlers-export.test.js`

This test ensures the barrel export preserves the current API surface:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('MCP handlers export integrity', () => {
  it('exports all 23 required handlers from barrel', async () => {
    // Import from the barrel (will be handlers/index.js after refactor)
    const handlersModule = await import('../../packages/mcp/dist/handlers.js');

    const requiredHandlers = [
      'handleQueryGraph',
      'handleFindCalls',
      'handleFindNodes',
      'handleTraceAlias',
      'handleTraceDataFlow',
      'handleAnalyzeProject',
      'handleGetAnalysisStatus',
      'handleGetStats',
      'handleGetSchema',
      'handleCreateGuarantee',
      'handleListGuarantees',
      'handleCheckGuarantees',
      'handleCheckInvariant',
      'handleDeleteGuarantee',
      'handleGetFunctionDetails',
      'handleGetContext',
      'handleGetFileOverview',
      'handleReadProjectStructure',
      'handleWriteConfig',
      'handleGetCoverage',
      'handleFindGuards',
      'handleGetDocumentation',
      'handleReportIssue'
    ];

    for (const handlerName of requiredHandlers) {
      assert.ok(
        typeof handlersModule[handlerName] === 'function',
        `${handlerName} must be exported as a function`
      );
    }

    // Verify no unexpected exports (only handlers, no internal helpers)
    const exportedNames = Object.keys(handlersModule).filter(
      key => typeof handlersModule[key] === 'function'
    );
    assert.equal(
      exportedNames.length,
      23,
      'Should export exactly 23 handlers (formatCallsForDisplay is internal)'
    );
  });
});
```

**Rationale:**
- Existing `tools-onboarding.test.ts` imports from `dist/handlers.js` — will continue working if barrel export is correct
- This test explicitly verifies all 23 handlers are present and callable
- Catches missing exports or accidental internal helper leaks
- Run BEFORE refactoring to establish baseline, run AFTER to verify preservation

**Test execution:**
```bash
pnpm build
node --test test/unit/mcp-handlers-export.test.js
```

### Rob's Scope (Implementation)

**Prerequisite:** Kent's test is green (baseline established).

**Atomic refactoring sequence (single commit):**

#### Step 1: Create handlers/ directory structure

```bash
mkdir -p packages/mcp/src/handlers
```

#### Step 2: Create domain files

For each file, extract handlers from `handlers.ts` with their complete implementations:

**2.1 `handlers/query-handlers.ts` (~230 lines)**

Handlers to move:
- `handleQueryGraph` (lines 94-153)
- `handleFindCalls` (lines 155-230)
- `handleFindNodes` (lines 232-290)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getGraphState, getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
```

**2.2 `handlers/dataflow-handlers.ts` (~155 lines)**

Handlers to move:
- `handleTraceAlias` (lines 292-358)
- `handleTraceDataFlow` (lines 360-425)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getGraphState, getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
```

**2.3 `handlers/analysis-handlers.ts` (~130 lines)**

Handlers to move:
- `handleAnalyzeProject` (lines 52-92)
- `handleGetAnalysisStatus` (lines 427-468)
- `handleGetStats` (lines 470-530)
- `handleGetSchema` (lines 532-580)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo, setLastAnalysisTime } from '../state.js';
import { analyzeProject, getCachedGraph } from '../analysis.js';
import { formatError, validateProjectRoot } from '../utils.js';
import path from 'node:path';
```

**2.4 `handlers/guarantee-handlers.ts` (~336 lines)**

Handlers to move:
- `handleCreateGuarantee` (lines 582-680)
- `handleListGuarantees` (lines 682-735)
- `handleCheckGuarantees` (lines 737-820)
- `handleCheckInvariant` (lines 822-905) ← **NOTE: moved from dataflow to guarantee**
- `handleDeleteGuarantee` (lines 907-955)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
import { formatError, validateProjectRoot } from '../utils.js';
import { GuaranteeManager } from '@grafema/core';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
```

**2.5 `handlers/context-handlers.ts` (~430 lines)**

Handlers to move:
- `formatCallsForDisplay` (lines 957-1015) ← **Internal helper, NOT exported**
- `handleGetFunctionDetails` (lines 1017-1180)
- `handleGetContext` (lines 1182-1320)
- `handleGetFileOverview` (lines 1322-1460)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getGraphState, getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
```

**Important:** `formatCallsForDisplay` stays internal (not exported from index.ts).

**2.6 `handlers/project-handlers.ts` (~220 lines)**

Handlers to move:
- `handleReadProjectStructure` (lines 1462-1565)
- `handleWriteConfig` (lines 1567-1620)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo } from '../state.js';
import { formatError, validateProjectRoot } from '../utils.js';
import fs from 'node:fs';
import path from 'node:path';
```

**2.7 `handlers/coverage-handlers.ts` (~85 lines)**

Handler to move:
- `handleGetCoverage` (lines 1215-1285)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
```

**2.8 `handlers/guard-handlers.ts` (~120 lines)**

Handler to move:
- `handleFindGuards` (lines 1287-1395)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
```

**2.9 `handlers/documentation-handlers.ts` (~120 lines)**

Handler to move:
- `handleGetDocumentation` (lines 1397-1505)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo } from '../state.js';
import { getCachedGraph } from '../analysis.js';
```

**2.10 `handlers/issue-handlers.ts` (~110 lines)**

Handler to move:
- `handleReportIssue` (lines 1507-1605)

Imports needed:
```typescript
import type { McpRequest, McpResponse } from '../types.js';
import { getProjectInfo } from '../state.js';
import { formatError, validateProjectRoot } from '../utils.js';
import fs from 'node:fs';
import path from 'node:path';
```

#### Step 3: Create barrel export `handlers/index.ts` (~50 lines)

```typescript
// Query handlers
export { handleQueryGraph, handleFindCalls, handleFindNodes } from './query-handlers.js';

// Dataflow handlers
export { handleTraceAlias, handleTraceDataFlow } from './dataflow-handlers.js';

// Analysis handlers
export { handleAnalyzeProject, handleGetAnalysisStatus, handleGetStats, handleGetSchema } from './analysis-handlers.js';

// Guarantee handlers
export { handleCreateGuarantee, handleListGuarantees, handleCheckGuarantees, handleCheckInvariant, handleDeleteGuarantee } from './guarantee-handlers.js';

// Context handlers
export { handleGetFunctionDetails, handleGetContext, handleGetFileOverview } from './context-handlers.js';

// Project handlers
export { handleReadProjectStructure, handleWriteConfig } from './project-handlers.js';

// Coverage handlers
export { handleGetCoverage } from './coverage-handlers.js';

// Guard handlers
export { handleFindGuards } from './guard-handlers.js';

// Documentation handlers
export { handleGetDocumentation } from './documentation-handlers.js';

// Issue handlers
export { handleReportIssue } from './issue-handlers.js';
```

**Critical:** `formatCallsForDisplay` is NOT exported — it's internal to `context-handlers.ts`.

#### Step 4: Update `packages/mcp/src/server.ts`

**Before:**
```typescript
import {
  handleAnalyzeProject,
  handleCheckGuarantees,
  // ... all 23 handlers
} from './handlers.js';
```

**After:**
```typescript
import {
  handleAnalyzeProject,
  handleCheckGuarantees,
  // ... all 23 handlers
} from './handlers/index.js';
```

**Change:** Single line — update import path from `'./handlers.js'` to `'./handlers/index.js'`.

#### Step 5: Delete old file

```bash
rm packages/mcp/src/handlers.ts
```

#### Step 6: Verify

```bash
# TypeScript compilation catches missing imports
pnpm build

# Kent's test verifies all exports present
node --test test/unit/mcp-handlers-export.test.js

# Existing integration test verifies callers work
node --test test/unit/tools-onboarding.test.js

# Full MCP test suite
node --test 'test/unit/mcp-*.test.js'
```

## Import Mapping Summary

| Domain File | Imports from Core | Imports from MCP | Node Built-ins | External |
|-------------|-------------------|------------------|----------------|----------|
| query-handlers | - | types, state, analysis | - | - |
| dataflow-handlers | - | types, state, analysis | - | - |
| analysis-handlers | - | types, state, analysis, utils | path | - |
| guarantee-handlers | GuaranteeManager | types, state, analysis, utils | fs, path | yaml |
| context-handlers | - | types, state, analysis | - | - |
| project-handlers | - | types, state, utils | fs, path | - |
| coverage-handlers | - | types, state, analysis | - | - |
| guard-handlers | - | types, state, analysis | - | - |
| documentation-handlers | - | types, state, analysis | - | - |
| issue-handlers | - | types, state, utils | fs, path | - |

**All imports use `.js` extension** (TypeScript ESM requirement).

## Risk Mitigation

**Risks:**

1. **Missing import** → TypeScript compiler fails at build time
2. **Missing export** → Kent's test fails (all 23 handlers check)
3. **Wrong import path in server.ts** → TypeScript compiler fails
4. **Broken caller** → Existing `tools-onboarding.test.js` fails

**All risks caught by automated checks — no manual verification needed.**

**Rollback strategy:** Single atomic commit means `git revert` restores everything.

## Commit Strategy

**Commit 1:** Add behavior-locking test
```
test(mcp): add handler export integrity test (REG-461)

Locks current behavior before handlers.ts decomposition.
Verifies all 23 handlers exported from barrel.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

**Commit 2:** Atomic refactoring
```
refactor(mcp): decompose handlers.ts into domain modules (REG-461)

Splits 1,626-line handlers.ts into 11 domain-specific files:
- handlers/query-handlers.ts (3 handlers)
- handlers/dataflow-handlers.ts (2 handlers)
- handlers/analysis-handlers.ts (4 handlers)
- handlers/guarantee-handlers.ts (5 handlers, includes checkInvariant)
- handlers/context-handlers.ts (3 handlers + internal helper)
- handlers/project-handlers.ts (2 handlers)
- handlers/coverage-handlers.ts (1 handler)
- handlers/guard-handlers.ts (1 handler)
- handlers/documentation-handlers.ts (1 handler)
- handlers/issue-handlers.ts (1 handler)
- handlers/index.ts (barrel export)

No behavior changes — pure mechanical refactoring.
All 23 handlers remain exported, internal helper stays private.

Verified by:
- TypeScript compilation
- Handler export integrity test
- Existing tools-onboarding.test.js
- Full MCP test suite

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Execution Flow

```
Kent (Opus)
  ├─ Write test/unit/mcp-handlers-export.test.js
  ├─ Run: pnpm build && node --test test/unit/mcp-handlers-export.test.js
  ├─ Verify: GREEN (baseline established)
  └─ Report: test/unit/mcp-handlers-export.test.js passes

Rob (Opus) — AFTER Kent's test is green
  ├─ Create handlers/ directory
  ├─ Create 10 domain files (extract from handlers.ts)
  ├─ Create handlers/index.ts (barrel)
  ├─ Update server.ts import path
  ├─ Delete handlers.ts
  ├─ Run: pnpm build
  ├─ Verify: TypeScript compiles
  ├─ Run: node --test test/unit/mcp-handlers-export.test.js
  ├─ Verify: GREEN (behavior preserved)
  ├─ Run: node --test 'test/unit/mcp-*.test.js'
  ├─ Verify: ALL GREEN
  └─ Report: Refactoring complete, all tests pass

Auto-Review (Sonnet)
  ├─ Check: Behavior preserved? (tests green)
  ├─ Check: No logic changes? (pure move)
  ├─ Check: Imports correct? (TypeScript compiles)
  ├─ Check: Commits atomic? (2 commits, clear messages)
  └─ Verdict: APPROVE / REJECT

Vadim (manual)
  └─ Final confirmation
```

## Success Metrics

- [ ] `pnpm build` passes
- [ ] `test/unit/mcp-handlers-export.test.js` passes
- [ ] `test/unit/tools-onboarding.test.js` passes
- [ ] All MCP tests pass (`node --test 'test/unit/mcp-*.test.js'`)
- [ ] 2 atomic commits (test + refactor)
- [ ] No behavior changes (verified by tests)
- [ ] `handlers.ts` deleted, `handlers/` directory with 11 files created

## Notes

**Why skip Uncle Bob (STEP 2.5)?**

This task IS the refactoring. No "prepare before refactoring" phase needed — the entire task is moving code from one file to many files. Uncle Bob's review would just repeat the task description.

**Why context-handlers.ts is 430 lines (above 300-line threshold)?**

The three handlers (`handleGetFunctionDetails`, `handleGetContext`, `handleGetFileOverview`) are tightly coupled through the internal `formatCallsForDisplay` helper. Splitting them would require:
- Making `formatCallsForDisplay` a shared util (adds indirection)
- OR duplicating the helper (violates DRY)
- OR splitting into `function-details-handlers.ts` + `context-handlers.ts` + `file-overview-handlers.ts` (over-fragmentation)

430 lines for three related handlers + one shared helper is acceptable given they form a cohesive "code context" domain. Future refactoring (v0.2 tech debt) can split if needed.

**Line number references are approximate** — Rob should search for function names in handlers.ts, not rely on exact line numbers.
