# Don Exploration: MethodCallResolver.ts Split Analysis

**File:** `/Users/vadim/grafema-worker-12/packages/core/src/plugins/enrichment/MethodCallResolver.ts`
**Size:** 927 lines
**Status:** CRITICAL — exceeds 700-line hard limit

## Executive Summary

MethodCallResolver.ts is a **927-line file** that violates our architectural hard limit (300 lines recommended, 700 critical). The file has clear responsibility boundaries and can be split into 5 focused modules without breaking functionality.

**Risk Assessment:** LOW
**Recommended Action:** Split into 5 modules + shared types file
**Estimated Impact:** Medium (3 other plugins depend on it via plugin registry)

---

## File Structure Analysis

### Line Count Breakdown

```
Total: 927 lines
- Constants/lookup tables: ~200 lines (22%)
- Core plugin logic: ~250 lines (27%)
- Index builders: ~100 lines (11%)
- Resolution logic: ~140 lines (15%)
- Helper utilities: ~150 lines (16%)
- Type definitions: ~50 lines (5%)
- Error analysis: ~37 lines (4%)
```

### Methods/Functions Inventory

| Line Range | Name | Lines | Purpose |
|------------|------|-------|---------|
| 261-273 | `get metadata()` | 13 | Plugin metadata declaration |
| 275-480 | `execute()` | 206 | Main plugin execution loop |
| 485-525 | `buildClassMethodIndex()` | 41 | Builds CLASS→METHOD lookup index |
| 530-546 | `buildVariableTypeIndex()` | 17 | Builds VARIABLE→TYPE mapping |
| 551-622 | `resolveMethodCall()` | 72 | Core resolution logic (4 strategies) |
| 628-659 | `findMethodInParentClasses()` | 32 | Inheritance chain walker (REG-400) |
| 664-708 | `findContainingClass()` + helper | 45 | Find CLASS containing a CALL node |
| 714-759 | `isExternalMethod()` | 46 | Check if method is built-in/library |
| 764-781 | `isBuiltInObject()` | 18 | Check if object is built-in global |
| 786-806 | `trackLibraryCall()` | 21 | Track library usage stats |
| 812-882 | `analyzeResolutionFailure()` | 71 | REG-332: Context-aware failure analysis |
| 887-926 | `generateContextualSuggestion()` | 40 | REG-332: Generate helpful error messages |

### Constants/Data

| Line Range | Name | Lines | Purpose |
|------------|------|-------|---------|
| 23-70 | `BUILTIN_PROTOTYPE_METHODS` | 48 | Array, String, Object, Date, etc. methods |
| 76-170 | `COMMON_LIBRARY_METHODS` | 95 | Express, Socket.io, DB, validation, etc. |
| 176-226 | `LIBRARY_SEMANTIC_GROUPS` | 51 | Library categorization + plugin suggestions |

---

## Responsibility Analysis

The file has **5 distinct responsibilities**:

### 1. External Method Classification (200 lines)
- **Lines:** 23-226
- **What:** Constants defining built-in/library methods and semantic grouping
- **Why separate:** Pure data, no behavior, used by filtering logic
- **Dependencies:** None (self-contained)

### 2. Plugin Orchestration (206 lines)
- **Lines:** 258-480
- **What:** Main `execute()` loop, progress reporting, statistics
- **Why separate:** High-level coordination vs low-level resolution
- **Dependencies:** All other parts

### 3. Graph Indexing (100 lines)
- **Lines:** 485-546
- **What:** Pre-build lookup tables for fast resolution
- **Why separate:** One-time setup, distinct from per-call resolution
- **Dependencies:** Graph API only

### 4. Method Resolution (150 lines)
- **Lines:** 551-708
- **What:** Core resolution logic (4 strategies + inheritance)
- **Why separate:** The "what" this plugin does — should be isolated and testable
- **Dependencies:** Indexes from #3

### 5. External Filtering & Library Tracking (140 lines)
- **Lines:** 714-806
- **What:** Decide what to skip + track library coverage
- **Why separate:** Filtering policy vs resolution logic
- **Dependencies:** Constants from #1

### 6. Strict Mode Error Analysis (110 lines)
- **Lines:** 812-926
- **What:** REG-332 feature — analyze WHY resolution failed
- **Why separate:** Error reporting vs resolution logic
- **Dependencies:** Constants from #1

---

## Natural Split Boundaries

### Proposed File Structure

```
plugins/enrichment/method-call-resolver/
├── index.ts                        # Re-exports
├── MethodCallResolver.ts           # Main plugin (orchestration only)
├── MethodCallIndexer.ts            # Graph indexing (#3)
├── MethodCallResolutionEngine.ts   # Core resolution logic (#4)
├── ExternalMethodFilter.ts         # Filtering + library tracking (#5)
├── ResolutionErrorAnalyzer.ts      # REG-332 strict mode errors (#6)
├── constants/
│   ├── builtinMethods.ts           # BUILTIN_PROTOTYPE_METHODS
│   ├── libraryMethods.ts           # COMMON_LIBRARY_METHODS
│   └── librarySemanticGroups.ts    # LIBRARY_SEMANTIC_GROUPS
└── types.ts                        # Shared interfaces
```

### Module Breakdown

#### **1. Main Plugin (MethodCallResolver.ts)** — 150 lines
**What stays:**
- Plugin class shell
- `metadata` getter
- `execute()` method (delegates to other modules)
- Progress reporting
- Summary statistics

**Dependencies:**
```typescript
import { MethodCallIndexer } from './MethodCallIndexer.js';
import { MethodCallResolutionEngine } from './MethodCallResolutionEngine.js';
import { ExternalMethodFilter } from './ExternalMethodFilter.js';
import { ResolutionErrorAnalyzer } from './ResolutionErrorAnalyzer.js';
```

#### **2. Indexer (MethodCallIndexer.ts)** — 120 lines
**Extracts:**
- `buildClassMethodIndex()`
- `buildVariableTypeIndex()`
- `ClassEntry` interface
- `MethodCallNode` interface (shared)

**Public API:**
```typescript
export class MethodCallIndexer {
  async buildClassMethodIndex(graph, logger): Promise<Map<string, ClassEntry>>
  async buildVariableTypeIndex(graph, logger): Promise<Map<string, string>>
}
```

#### **3. Resolution Engine (MethodCallResolutionEngine.ts)** — 180 lines
**Extracts:**
- `resolveMethodCall()` — core logic
- `findMethodInParentClasses()` — REG-400 inheritance
- `findContainingClass()` + recursive helper
- `_containingClassCache` (move to instance field)

**Public API:**
```typescript
export class MethodCallResolutionEngine {
  async resolve(
    methodCall: MethodCallNode,
    classMethodIndex: Map<string, ClassEntry>,
    variableTypes: Map<string, string>,
    graph: PluginContext['graph']
  ): Promise<BaseNodeRecord | null>
}
```

#### **4. External Filter (ExternalMethodFilter.ts)** — 150 lines
**Extracts:**
- `isExternalMethod()`
- `isBuiltInObject()`
- `trackLibraryCall()`
- `LibraryCallStats` interface

**Public API:**
```typescript
export class ExternalMethodFilter {
  isExternal(object: string, method: string): boolean
  isBuiltIn(object: string): boolean
  trackLibrary(stats: Map<...>, object: string, method: string): void
}
```

**Imports:**
```typescript
import { BUILTIN_PROTOTYPE_METHODS, COMMON_LIBRARY_METHODS } from './constants/index.js';
import { LIBRARY_SEMANTIC_GROUPS } from './constants/librarySemanticGroups.js';
```

#### **5. Error Analyzer (ResolutionErrorAnalyzer.ts)** — 130 lines
**Extracts:**
- `analyzeResolutionFailure()`
- `generateContextualSuggestion()`

**Public API:**
```typescript
export class ResolutionErrorAnalyzer {
  analyze(
    methodCall: MethodCallNode,
    classMethodIndex: Map<string, ClassEntry>,
    variableTypes: Map<string, string>
  ): { reason: ResolutionFailureReason; chain: ResolutionStep[] }

  generateSuggestion(
    object: string,
    method: string,
    reason: ResolutionFailureReason,
    chain: ResolutionStep[]
  ): string
}
```

#### **6. Constants (constants/\*)** — 200 lines total
- `builtinMethods.ts` — `BUILTIN_PROTOTYPE_METHODS`
- `libraryMethods.ts` — `COMMON_LIBRARY_METHODS`
- `librarySemanticGroups.ts` — `LIBRARY_SEMANTIC_GROUPS` + interface

#### **7. Types (types.ts)** — 60 lines
- `MethodCallNode`
- `ClassEntry`
- `LibraryCallStats`
- Re-exported from index

---

## Import/Export Analysis

### Current Exports (from index.ts)
```typescript
export { MethodCallResolver, LIBRARY_SEMANTIC_GROUPS } from './plugins/enrichment/MethodCallResolver.js';
export type { LibraryCallStats } from './plugins/enrichment/MethodCallResolver.js';
```

### Proposed New Exports (from method-call-resolver/index.ts)
```typescript
// Main plugin (backward compatible)
export { MethodCallResolver } from './MethodCallResolver.js';

// Constants (still public API)
export { LIBRARY_SEMANTIC_GROUPS } from './constants/librarySemanticGroups.js';

// Types (still public API)
export type { LibraryCallStats } from './types.js';

// New: Expose internals for testing/extension
export { MethodCallIndexer } from './MethodCallIndexer.js';
export { MethodCallResolutionEngine } from './MethodCallResolutionEngine.js';
export { ExternalMethodFilter } from './ExternalMethodFilter.js';
export { ResolutionErrorAnalyzer } from './ResolutionErrorAnalyzer.js';
```

### Who Imports MethodCallResolver

**Plugin Registry:**
- `packages/core/src/config/ConfigLoader.ts` — Registers plugin by name

**Plugin Dependencies (3 plugins):**
- `ArgumentParameterLinker.ts` — `dependencies: ['MethodCallResolver']`
- `RustFFIEnricher.ts` — `dependencies: ['MethodCallResolver']`
- `AliasTracker.ts` — `dependencies: ['MethodCallResolver']`

**Tests:**
- `test/unit/MethodCallResolver.test.js` — Integration tests

**Impact:** Plugin registry uses string name `'MethodCallResolver'`, not direct import. Split won't break dependency chain.

---

## Existing Test Coverage

**File:** `test/unit/MethodCallResolver.test.js` (492 lines)

### Test Categories

1. **External method filtering** (2 tests)
   - console.log, Math, JSON, Promise — should skip

2. **Class method resolution** (2 tests)
   - Static call: `User.save()`
   - Instance call: `this.helper()`

3. **Variable type resolution** (1 test)
   - Via INSTANCE_OF edge

4. **Edge cases** (2 tests)
   - Duplicate edge prevention
   - Unresolvable calls (graceful degradation)

5. **Datalog integration** (1 test)
   - Validation after enrichment

**Coverage Assessment:** Good functional coverage. Tests interact with full plugin via `execute()`, so they won't break after split (as long as public API stays the same).

---

## Risk Assessment

### Complexity Risks

| Risk | Level | Mitigation |
|------|-------|------------|
| Break plugin dependencies | LOW | Dependencies are by plugin name, not import path |
| Break public API exports | LOW | Keep same exports from new `index.ts` |
| Break tests | LOW | Tests use `execute()`, stays in main plugin |
| Introduce bugs in resolution logic | MEDIUM | Resolution logic is pure functions — testable in isolation |
| Miss edge cases in split | LOW | Well-defined boundaries, no overlapping concerns |

### Behavioral Risks

| Risk | Level | Mitigation |
|------|-------|------------|
| Change resolution order | MEDIUM | Resolution logic moves as-is, no reordering |
| Cache invalidation | LOW | `_containingClassCache` moves to ResolutionEngine, same lifecycle |
| Performance regression | LOW | No extra graph queries, same algorithm |

### Testing Risks

| Risk | Level | Mitigation |
|------|-------|------------|
| Test breakage | LOW | Integration tests use plugin shell, internal tests added |
| Missing test coverage | MEDIUM | Add unit tests for new modules (Indexer, Engine, Filter, Analyzer) |

**Overall Risk:** **LOW**

This is a **refactoring-only** change. No new features, no behavior changes. The split follows natural responsibility boundaries, and the resolution logic is mostly pure functions.

---

## Recommendations

### 1. Splitting Strategy

**Approach:** Extract-and-delegate (not rewrite)

1. Create new directory structure
2. Extract constants → `constants/`
3. Extract types → `types.ts`
4. Extract indexer → `MethodCallIndexer.ts`
5. Extract engine → `MethodCallResolutionEngine.ts`
6. Extract filter → `ExternalMethodFilter.ts`
7. Extract error analyzer → `ResolutionErrorAnalyzer.ts`
8. Update main plugin to delegate to new modules
9. Create barrel export `index.ts`
10. Update `packages/core/src/index.ts` to point to new location

### 2. Testing Strategy

**Phase 1: Lock current behavior**
- Run existing tests BEFORE split → must pass
- Record test output as baseline

**Phase 2: After split**
- Run same tests AFTER split → must match baseline
- Add unit tests for new modules:
  - Indexer: test index building
  - Engine: test resolution strategies (4 cases + inheritance)
  - Filter: test external detection
  - Analyzer: test error message generation

**Phase 3: Integration verification**
- Run full analysis on real codebase (e.g., grafema itself)
- Compare before/after statistics (edgesCreated, unresolved, externalSkipped)

### 3. Implementation Order

**STEP 1:** Extract constants (safest, no logic)
**STEP 2:** Extract types (no dependencies)
**STEP 3:** Extract indexer (self-contained)
**STEP 4:** Extract filter (depends on constants)
**STEP 5:** Extract engine (depends on indexer)
**STEP 6:** Extract error analyzer (depends on constants)
**STEP 7:** Update main plugin (delegates to all)
**STEP 8:** Update exports, run tests

### 4. Commit Strategy

**Atomic commits:**
1. `refactor(core): extract MethodCallResolver constants`
2. `refactor(core): extract MethodCallResolver types`
3. `refactor(core): extract MethodCallIndexer`
4. `refactor(core): extract ExternalMethodFilter`
5. `refactor(core): extract MethodCallResolutionEngine`
6. `refactor(core): extract ResolutionErrorAnalyzer`
7. `refactor(core): update MethodCallResolver to use new modules`
8. `test(core): add unit tests for MethodCallResolver modules`

Each commit MUST pass tests.

---

## File Size Projections (After Split)

| File | Lines | Status |
|------|-------|--------|
| `MethodCallResolver.ts` | ~150 | ✅ OK (under 300) |
| `MethodCallIndexer.ts` | ~120 | ✅ OK |
| `MethodCallResolutionEngine.ts` | ~180 | ✅ OK |
| `ExternalMethodFilter.ts` | ~150 | ✅ OK |
| `ResolutionErrorAnalyzer.ts` | ~130 | ✅ OK |
| `constants/builtinMethods.ts` | ~60 | ✅ OK |
| `constants/libraryMethods.ts` | ~110 | ✅ OK |
| `constants/librarySemanticGroups.ts` | ~60 | ✅ OK |
| `types.ts` | ~60 | ✅ OK |
| `index.ts` | ~30 | ✅ OK |

**Total:** ~1050 lines (vs 927 original)
**Overhead:** ~13% (imports, exports, module boilerplate)
**Largest file:** 180 lines (well under 300-line target)

---

## Alternative Approaches Considered

### Alt 1: Split into 2 files only
- Main plugin (execute + orchestration)
- Helpers (everything else)

**Rejected:** Still leaves 500+ line "helpers" file, doesn't solve the problem.

### Alt 2: Split by feature (REG-400, REG-332, core)
- Core resolution
- Inheritance support (REG-400)
- Strict mode errors (REG-332)

**Rejected:** Artificial boundaries. Inheritance is part of resolution, not a separate concern.

### Alt 3: Keep as-is, just add comments
**Rejected:** Doesn't address Uncle Bob's hard limit. 927 lines is unmaintainable regardless of comments.

---

## Decision

**Proceed with 5-module split** as outlined above.

**Rationale:**
1. Each module has a single, clear responsibility
2. Natural boundaries align with code structure
3. Low risk — mostly moving code, not changing logic
4. All resulting files are under 200 lines (well under 300 target)
5. Public API stays compatible (backward compatible exports)
6. Tests don't need major updates (integration tests still work)

**Next Steps:**
1. Present this plan to Uncle Bob for review
2. If approved → Kent writes tests to lock current behavior
3. Rob performs extraction (8 commits, sequential)
4. Kent verifies tests still pass + adds unit tests for new modules
5. Auto-review checks for regressions

---

**Estimated Effort:**
- Planning: ✅ Done (this document)
- Uncle Bob review: 30 min
- Test baseline: 1 hour (Kent)
- Extraction: 4-5 hours (Rob, 8 commits)
- Unit tests: 2 hours (Kent)
- Review: 1 hour (Auto-review + Вадим)

**Total:** ~1 working day (8-9 hours)
