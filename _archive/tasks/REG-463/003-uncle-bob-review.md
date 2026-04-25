# Uncle Bob Review: MethodCallResolver.ts

**File size:** 927 lines — **CRITICAL**

**Methods to modify:** All methods will be split into separate modules

---

## File-level Issues

### CRITICAL: File Size Violation
- **927 lines** — exceeds 700-line CRITICAL threshold
- File does 4 distinct responsibilities (see Don's analysis)
- **MUST split** before any other changes

### Structural Issues
1. **Mixed Concerns** - single file contains:
   - Data (3 large constant Sets: 48 + 95 + 51 lines)
   - Type definitions (26 lines)
   - Resolution logic (main class + 8 helper methods)
   - External method detection (duplicated Sets)
   - Error analysis logic (separate concern)

2. **DRY Violations**:
   - `isExternalMethod()` creates `new Set([...])` every call (lines 716-741)
   - `isBuiltInObject()` creates `new Set([...])` every call (lines 765-779)
   - **Both Sets contain overlapping data** (built-in objects duplicated)

3. **Responsibility Leakage**:
   - `LIBRARY_SEMANTIC_GROUPS` is exported (line 176) but buried in 927-line file
   - Error analysis logic (71 + 40 lines) is separate domain from resolution

---

## Method-level Analysis

### execute() — Lines 275-480 (206 lines)
- **Recommendation:** SPLIT
- **Issues:**
  - 206 lines exceeds 50-line guideline by 4x
  - Main loop (lines 332-442) is 110 lines alone
  - Contains: deduplication logic, progress reporting, library stats tracking, error collection
- **Specific actions:**
  - Extract deduplication → `deduplicateMethodCalls()` helper
  - Extract main loop body → `processMethodCall()` helper
  - Keep execute() as coordinator (20-30 lines max)

### buildClassMethodIndex() — Lines 485-525 (41 lines)
- **Recommendation:** SKIP refactoring
- **Rationale:** Clear single responsibility, readable, no obvious wins

### buildVariableTypeIndex() — Lines 530-546 (17 lines)
- **Recommendation:** SKIP refactoring
- **Rationale:** Simple, focused, well-named

### resolveMethodCall() — Lines 551-622 (72 lines)
- **Recommendation:** REFACTOR (optional, low priority)
- **Issues:**
  - 72 lines, slightly over guideline
  - 4 resolution strategies in sequence (could be more explicit)
- **Specific actions:**
  - If splitting file anyway, keep as-is (readable enough)
  - If further cleanup desired: extract each strategy to named method

### findMethodInParentClasses() — Lines 628-659 (32 lines)
- **Recommendation:** SKIP refactoring
- **Rationale:** Recursive traversal, clear logic

### findContainingClass() + helper — Lines 664-708 (45 lines)
- **Recommendation:** SKIP refactoring
- **Rationale:** Tree traversal pattern, well-structured

### isExternalMethod() — Lines 714-759 (46 lines)
- **Recommendation:** REFACTOR (DRY fix)
- **Issues:**
  - **Creates `new Set([...])` on every call** — should be module constant
  - 26-line Set literal buried in method
- **Specific actions:**
  - Hoist `externalObjects` Set to module constant
  - Method becomes 5-line lookup function

### isBuiltInObject() — Lines 764-781 (18 lines)
- **Recommendation:** REFACTOR (DRY fix)
- **Issues:**
  - **Creates `new Set([...])` on every call** — should be module constant
  - **Duplicates data from `isExternalMethod()`** (all built-in objects are subset of external)
- **Specific actions:**
  - Hoist `builtInObjects` Set to module constant
  - Note: this Set is subset of `externalObjects` — consider consolidation

### trackLibraryCall() — Lines 786-806 (21 lines)
- **Recommendation:** SKIP refactoring
- **Rationale:** Simple, focused, clear

### analyzeResolutionFailure() — Lines 812-882 (71 lines)
- **Recommendation:** MOVE to separate module
- **Rationale:** Belongs to error analysis domain, not core resolution

### generateContextualSuggestion() — Lines 887-927 (40 lines)
- **Recommendation:** MOVE to separate module
- **Rationale:** Belongs to error analysis domain, not core resolution

---

## Splitting Plan

Based on Don's analysis and codebase patterns, split into 5 focused modules:

### 1. `MethodCallData.ts` — Reference Data (150 lines)
**Purpose:** Centralize all constant data, DRY fixes

**Contents:**
```typescript
// Lines 23-70: BUILTIN_PROTOTYPE_METHODS (keep as Set)
// Lines 76-170: COMMON_LIBRARY_METHODS (keep as Set)
// Lines 176-226: LIBRARY_SEMANTIC_GROUPS (exported, keep)
// NEW: EXTERNAL_OBJECTS (from isExternalMethod, lines 716-741)
// NEW: BUILTIN_OBJECTS (from isBuiltInObject, lines 765-779)
// Lines 231-256: Type interfaces (LibraryCallStats, MethodCallNode, ClassEntry)

export {
  BUILTIN_PROTOTYPE_METHODS,
  COMMON_LIBRARY_METHODS,
  LIBRARY_SEMANTIC_GROUPS,
  EXTERNAL_OBJECTS,        // NEW
  BUILTIN_OBJECTS,         // NEW
  LibraryCallStats,
  MethodCallNode,
  ClassEntry
};
```

**DRY Fixes:**
- Convert method-local Sets to module constants
- Document overlap: `BUILTIN_OBJECTS ⊂ EXTERNAL_OBJECTS`

**Risk:** LOW — pure data extraction

---

### 2. `MethodCallDetectors.ts` — Detection Utilities (60 lines)
**Purpose:** External method detection, library call tracking

**Contents:**
```typescript
import {
  BUILTIN_PROTOTYPE_METHODS,
  COMMON_LIBRARY_METHODS,
  LIBRARY_SEMANTIC_GROUPS,
  EXTERNAL_OBJECTS,
  BUILTIN_OBJECTS
} from './MethodCallData.js';

// Lines 714-759: isExternalMethod() — REFACTORED (now 5 lines)
export function isExternalMethod(object: string, method: string): boolean {
  if (EXTERNAL_OBJECTS.has(object)) return true;
  if (BUILTIN_PROTOTYPE_METHODS.has(method)) return true;
  if (COMMON_LIBRARY_METHODS.has(method)) return true;
  return false;
}

// Lines 764-781: isBuiltInObject() — REFACTORED (now 2 lines)
export function isBuiltInObject(object: string): boolean {
  return BUILTIN_OBJECTS.has(object);
}

// Lines 786-806: trackLibraryCall() — MOVED AS-IS
export function trackLibraryCall(
  stats: Map<string, LibraryCallStats>,
  object: string,
  method: string
): void {
  // ... existing logic
}
```

**Risk:** LOW — pure functions, no graph access

---

### 3. `MethodCallIndexers.ts` — Index Building (100 lines)
**Purpose:** Build class and variable type indexes

**Contents:**
```typescript
import type { PluginContext } from '../Plugin.js';
import type { ClassEntry } from './MethodCallData.js';

// Lines 485-525: buildClassMethodIndex() — MOVED AS-IS
export async function buildClassMethodIndex(
  graph: PluginContext['graph'],
  logger: ReturnType<Plugin['log']>
): Promise<Map<string, ClassEntry>> {
  // ... existing logic
}

// Lines 530-546: buildVariableTypeIndex() — MOVED AS-IS
export async function buildVariableTypeIndex(
  graph: PluginContext['graph'],
  logger: ReturnType<Plugin['log']>
): Promise<Map<string, string>> {
  // ... existing logic
}
```

**Risk:** LOW — stateless functions, graph read-only

---

### 4. `MethodCallResolution.ts` — Core Resolution Logic (250 lines)
**Purpose:** Resolve method calls using indexes

**Contents:**
```typescript
import type { BaseNodeRecord, PluginContext } from '@grafema/types';
import type { MethodCallNode, ClassEntry } from './MethodCallData.js';

// Lines 551-622: resolveMethodCall() — MOVED AS-IS
export async function resolveMethodCall(
  methodCall: MethodCallNode,
  classMethodIndex: Map<string, ClassEntry>,
  variableTypes: Map<string, string>,
  graph: PluginContext['graph']
): Promise<BaseNodeRecord | null> {
  // ... existing logic (4 resolution strategies)
}

// Lines 628-659: findMethodInParentClasses() — MOVED AS-IS
export async function findMethodInParentClasses(
  classNode: BaseNodeRecord,
  methodName: string,
  classMethodIndex: Map<string, ClassEntry>,
  graph: PluginContext['graph'],
  maxDepth: number = 5,
  visited: Set<string> = new Set()
): Promise<BaseNodeRecord | null> {
  // ... existing recursive logic
}

// Lines 664-708: findContainingClass() + recursive helper — MOVED AS-IS
export async function findContainingClass(
  methodCall: MethodCallNode,
  graph: PluginContext['graph']
): Promise<BaseNodeRecord | null> {
  // ... existing logic
}

async function findContainingClassRecursive(
  node: BaseNodeRecord,
  graph: PluginContext['graph'],
  visited: Set<string>
): Promise<BaseNodeRecord | null> {
  // ... existing recursive logic
}
```

**Risk:** LOW — pure resolution logic, no side effects

---

### 5. `MethodCallErrorAnalysis.ts` — Error Analysis (120 lines)
**Purpose:** Analyze resolution failures, generate suggestions

**Contents:**
```typescript
import type { ResolutionFailureReason, ResolutionStep } from '../../errors/GrafemaError.js';
import type { MethodCallNode, ClassEntry } from './MethodCallData.js';
import { LIBRARY_SEMANTIC_GROUPS } from './MethodCallData.js';

// Lines 812-882: analyzeResolutionFailure() — MOVED AS-IS
export function analyzeResolutionFailure(
  methodCall: MethodCallNode,
  classMethodIndex: Map<string, ClassEntry>,
  variableTypes: Map<string, string>
): { reason: ResolutionFailureReason; chain: ResolutionStep[] } {
  // ... existing analysis logic
}

// Lines 887-927: generateContextualSuggestion() — MOVED AS-IS
export function generateContextualSuggestion(
  object: string,
  method: string,
  reason: ResolutionFailureReason,
  chain: ResolutionStep[]
): string {
  // ... existing suggestion logic
}
```

**Risk:** LOW — pure analysis functions, no graph writes

---

### 6. `MethodCallResolver.ts` — Main Plugin (200 lines)
**Purpose:** Plugin class, orchestrates resolution

**Contents:**
```typescript
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import { StrictModeError } from '../../errors/GrafemaError.js';

// Import all helpers
import {
  LIBRARY_SEMANTIC_GROUPS,
  type MethodCallNode,
  type LibraryCallStats
} from './method-call/MethodCallData.js';
import {
  isExternalMethod,
  isBuiltInObject,
  trackLibraryCall
} from './method-call/MethodCallDetectors.js';
import {
  buildClassMethodIndex,
  buildVariableTypeIndex
} from './method-call/MethodCallIndexers.js';
import {
  resolveMethodCall
} from './method-call/MethodCallResolution.js';
import {
  analyzeResolutionFailure,
  generateContextualSuggestion
} from './method-call/MethodCallErrorAnalysis.js';

export class MethodCallResolver extends Plugin {
  private _containingClassCache?: Map<string, BaseNodeRecord | null>;

  get metadata(): PluginMetadata {
    // Lines 261-273 — unchanged
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // REFACTORED version:
    // 1. Delegate to buildIndexes()
    // 2. Delegate to collectMethodCalls() — includes deduplication (lines 293-319)
    // 3. Main loop delegates to processMethodCall() for each call
    // 4. Return summary

    // Target: 80-100 lines max
  }

  // NEW: Extract deduplication logic
  private collectMethodCalls(graph): MethodCallNode[] {
    // Lines 293-319 extracted here
  }

  // NEW: Extract main loop body
  private async processMethodCall(
    methodCall: MethodCallNode,
    context: ProcessingContext
  ): Promise<ProcessingResult> {
    // Lines 359-441 extracted here
  }
}

// Re-export LIBRARY_SEMANTIC_GROUPS for backward compatibility
export { LIBRARY_SEMANTIC_GROUPS };
export type { LibraryCallStats };
```

**Refactoring details:**
- `execute()` becomes coordinator (80-100 lines)
- Extract deduplication → `collectMethodCalls()`
- Extract loop body → `processMethodCall()`
- All helper functions imported from separate modules

**Risk:** MEDIUM — main orchestrator, but logic unchanged

---

## Implementation Order

1. **Create `method-call/` subdirectory** under `plugins/enrichment/`
2. **Create data module first** (`MethodCallData.ts`) — foundation
3. **Create detector module** (`MethodCallDetectors.ts`) — uses data
4. **Create indexer module** (`MethodCallIndexers.ts`) — independent
5. **Create resolution module** (`MethodCallResolution.ts`) — uses data
6. **Create error analysis module** (`MethodCallErrorAnalysis.ts`) — uses data
7. **Refactor main plugin** (`MethodCallResolver.ts`) — imports all above
8. **Update exports** in `packages/core/src/index.ts` (only export plugin class + public types)
9. **Run tests** — behavior must be identical

---

## Export Strategy

**From `packages/core/src/index.ts`:**
```typescript
// Public API (keep)
export { MethodCallResolver, LIBRARY_SEMANTIC_GROUPS } from './plugins/enrichment/MethodCallResolver.js';
export type { LibraryCallStats } from './plugins/enrichment/MethodCallResolver.js';
```

**Internal modules** (under `method-call/`) are NOT exported from index — internal implementation detail.

**`MethodCallResolver.ts` re-exports:**
```typescript
export { LIBRARY_SEMANTIC_GROUPS } from './method-call/MethodCallData.js';
export type { LibraryCallStats } from './method-call/MethodCallData.js';
```

This maintains backward compatibility — existing imports still work.

---

## Validation Strategy

### Tests Must Pass Unchanged
- Run `node --test test/unit/MethodCallResolver.test.js`
- All 10+ test cases must pass
- No behavioral changes allowed

### Uncle Bob Compliance After Split
- Main plugin: ~200 lines (under 300-line limit)
- All modules: <200 lines each
- No method >50 lines
- DRY violations fixed

---

## Risk Assessment

**Overall Risk:** **MEDIUM**

**Risk Breakdown:**

| Module | Risk | Rationale |
|--------|------|-----------|
| MethodCallData.ts | LOW | Pure data, no logic |
| MethodCallDetectors.ts | LOW | Pure functions, DRY fix improves quality |
| MethodCallIndexers.ts | LOW | Stateless read-only functions |
| MethodCallResolution.ts | LOW | Pure resolution logic, no side effects |
| MethodCallErrorAnalysis.ts | LOW | Pure analysis functions |
| MethodCallResolver.ts | MEDIUM | Main orchestrator, requires execute() refactor |

**Mitigation:**
- Tests lock current behavior
- Split is extract-only (no logic changes in modules 1-5)
- Main plugin refactor is last step (rest is safe foundation)

---

## Estimated Scope

**Lines affected:** 927 (entire file split)

**Files created:** 6 new files (5 modules + refactored plugin)

**Files modified:**
- `packages/core/src/plugins/enrichment/MethodCallResolver.ts` (refactored)
- `packages/core/src/index.ts` (update imports)

**Test changes:** None (tests run against public API, unchanged)

**Time estimate:** 3-4 hours (methodical extraction + validation)

---

## One Level Better

**Before:** 927-line monolith, DRY violations, 4 mixed concerns

**After:** 6 focused modules, no file >250 lines, DRY fixed, clear separation of concerns

Not perfect (could further split resolution strategies), but **one level better** and meets file-size requirements.
