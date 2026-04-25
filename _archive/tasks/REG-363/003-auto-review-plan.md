# REG-363: USG Phase 1 — Auto-Review (Plan)

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review
**Workflow:** v2.1

## Vision Alignment

### ✅ Approved: Matches USG Architecture

Don's plan correctly implements the approved architecture from `_ai/usg-architecture.md`:

1. **Plugin-first philosophy** — `InfraAnalyzer` base class provides contract, developers implement `linkToCode()`. No heuristics. ✅
2. **Node type conventions** — `layer:tool:resource` format preserved (`infra:k8s:*`, `cloud:aws:*`, `obs:*`). ✅
3. **Edge direction** — Dependent → Provider (e.g., SERVICE → infra:k8s:deployment). ✅
4. **Environment metadata** — Optional `env` field on resources, query filtering. ✅
5. **Graceful degradation** — Parse/link errors don't fail entire analysis. ✅
6. **AI-first documentation** — Extensive docstrings in `InfraAnalyzer.ts`, AI agent guide planned. ✅

### ✅ Research Quality

Don used WebSearch to validate approach against industry patterns:
- Backstage plugin architecture
- IaC static analysis lifecycle (discover → parse → validate)
- Multi-layer graph cross-layer linking patterns

This grounds the design in real prior art, not speculation.

---

## Practical Quality

### 🔴 CRITICAL ISSUES (Must Fix)

#### Issue 1: Missing `core/plugins/index.ts` File

**Location:** Phase 2, line 446-449, Phase 6, line 943-949

**Problem:**
- Plan says "Re-export from `core/plugins/index.ts`"
- That file **does not exist**
- Directory listing shows only `Plugin.ts` and subdirectories (`analysis/`, `enrichment/`, etc.)

**Evidence:**
```bash
$ ls packages/core/src/plugins/
Plugin.ts  analysis/  discovery/  enrichment/  indexing/  validation/  vcs/
```

**Impact:**
- Rob will fail when trying to add export to non-existent file
- TypeScript build will fail

**Fix:**
Two options:

**Option A (Recommended):** Export directly from `packages/core/src/index.ts`
- InfraAnalyzer is a core plugin base class, not a subdirectory plugin
- `Plugin.ts` is exported from `core/index.ts` (line 68)
- InfraAnalyzer should follow same pattern

**Option B:** Create `core/plugins/index.ts` file
- Would need to export Plugin + InfraAnalyzer
- Adds indirection for no clear benefit
- Not consistent with current structure

**Recommended fix:**
```typescript
// packages/core/src/index.ts (add after line 69)
export { InfraAnalyzer } from './plugins/InfraAnalyzer.js';
```

**Update plan:**
- Phase 2: Remove "Re-export from core/plugins/index.ts"
- Phase 6: Update to export from `core/src/index.ts`

---

#### Issue 2: Branded Node Type Casting (`as any`)

**Location:** Phase 2, line 396 (InfraAnalyzer.ts execute method)

**Problem:**
```typescript
await graph.addNode(node as any);  // Line 396
```

**Analysis:**
- `GraphBackend.addNode()` signature: `addNode(node: AnyBrandedNode)`
- `AnyBrandedNode` is union of branded node types (from `@grafema/types`)
- Infrastructure nodes are NOT branded — they're generic `NodeRecord` shape

**Current pattern in codebase:**
Looking at `packages/types/src/plugins.ts` line 267:
```typescript
addNode(node: AnyBrandedNode): Promise<void> | void;
```

And checking existing analyzers (DatabaseAnalyzer, SocketIOAnalyzer) for how they handle custom nodes... this is actually acceptable IF the graph backend tolerates it.

**RFDBServerBackend reality check:**
From inspection of RFDBServerBackend code, it does NOT strictly enforce branded types at runtime — the type system enforces it at compile time, but runtime accepts any object with `id`, `type`, `name`, `file`.

**Verdict:** Type cast is acceptable but needs comment explaining why.

**Fix:**
```typescript
// Infrastructure nodes use generic shape, not branded types
await graph.addNode(node as any);
```

**Better long-term:** Define branded infrastructure node types in `@grafema/types/src/branded.ts`, but that's out of scope for Phase 1.

**Action:** Add explanatory comment, document as tech debt for later.

---

#### Issue 3: Test File Mocks `fs.readFileSync` Globally

**Location:** Phase 4, test code lines 590-599, 633-639, 658-664

**Problem:**
```javascript
const fs = await import('fs');
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = () => 'mock content';  // Global mutation
// ...
fs.readFileSync = originalReadFileSync;  // Restore
```

**Why this is fragile:**
1. Mutates shared module state across tests
2. If test fails before restore, subsequent tests break
3. Node.js module caching makes this unpredictable
4. Violates test isolation

**Better approach:**
Mock at the point of use via dependency injection or test-specific InfraAnalyzer override.

**Fix:**
```javascript
class MockInfraAnalyzer extends InfraAnalyzer {
  constructor(config = {}) {
    super(config);
    this.mockFiles = config.mockFiles || [];
    this.mockResources = config.mockResources || [];
    this.mockLinks = config.mockLinks || [];
    this.mockFileContent = config.mockFileContent || 'mock content';
  }

  // Override to bypass fs.readFileSync entirely
  async execute(context) {
    // ... copy execute logic but replace readFileSync with this.mockFileContent
  }
}
```

**Alternative:** Use `node:test` mocking API (if available) with `mock.method()`.

**Action:** Rewrite tests to avoid global fs mutation. If that's too complex for Phase 1, add TODO comment and accept the risk (unit tests only, not integration).

---

### ✅ Correct Design Decisions

1. **READS_FROM already exists** — Plan correctly notes lines 58-59 have READS_FROM/WRITES_TO. ✅
2. **Edge type additions** — 14 new edge types (not duplicating existing). ✅
3. **Graceful error handling** — Per-file try/catch, per-resource try/catch. ✅
4. **InfraResource interface** — Clean abstraction before graph node creation. ✅
5. **No config validation in Phase 1** — Deferred to Phase 2 (REG-364). Pragmatic. ✅

---

## Scope Check

### ✅ Phase 1 Scope is Correct

**Included (appropriate):**
- Edge type definitions
- InfraAnalyzer base class
- Configuration schema types
- Unit tests for base class
- AI agent guide

**Excluded (appropriate):**
- K8s analyzer implementation (REG-364)
- Terraform analyzer (REG-365)
- Config validation logic (deferred to REG-364)
- Integration tests with real files (deferred to REG-364)

**No scope creep detected.**

---

## Code Quality

### 🟡 Minor Issues (Non-blocking, but should fix)

#### Issue 4: Type Import Order

**Location:** Phase 1.2, line 100-101

**Current:**
```typescript
import type { PluginContext, NodeRecord } from './plugins.js';
import type { EdgeType } from './edges.js';
```

**Consistent with codebase:** Check existing type files for import order conventions.

**Action:** Follow existing pattern in `types/src/` files.

---

#### Issue 5: AI Agent Docstring Length

**Location:** Phase 2.1, InfraAnalyzer.ts lines 212-271

**Observation:**
- 60-line docstring before class definition
- Excellent for AI agents (explains when/how to use)
- Might clutter IDE quick info

**Not an issue** — This is explicitly for AI agents per project vision. Keep it.

---

### ✅ Tests Cover Key Scenarios

1. No files discovered (empty result) ✅
2. Resources parsed → nodes created ✅
3. Links created from linkToCode ✅
4. Parse errors handled gracefully ✅
5. Metadata declarations correct ✅

**Missing test cases:**
- File read failure (ENOENT, permission denied) — but covered by global try/catch
- Multiple resources per file — partially covered
- Empty linkToCode result — covered

**Verdict:** Test coverage is adequate for Phase 1 base class.

---

## Documentation Quality

### ✅ AI Agent Guide is Excellent

**Location:** Phase 5.2, `_ai/infrastructure-plugins.md`

**Strengths:**
1. Clear "When to Use" section
2. Complete code examples
3. Node type convention table
4. Edge direction convention explained
5. Environment metadata examples with Datalog queries
6. Error handling patterns
7. Reference to REG-364 for real implementation

**One suggestion:** Add "Common Mistakes" section:
```markdown
## Common Mistakes

1. **Don't throw in linkToCode** — return empty array if no match
2. **Don't fail on unparseable files** — return empty array from parseFile
3. **Don't use heuristics** — read explicit config or annotations only
4. **Don't forget environment metadata** — even if undefined = all envs
```

**Action:** Add "Common Mistakes" section to guide (2-3 examples).

---

## Testing Strategy

### ✅ Unit Tests First (Correct Priority)

- Mock analyzer with simple implementations ✅
- Base class lifecycle tested ✅
- Integration tests deferred to Phase 2 ✅

**This matches TDD principle:** Lock base class behavior before building on it.

---

## Risk Analysis

### ✅ Don's Risk Analysis is Accurate

**Low Risk:**
- Edge type additions ✅
- Type definitions ✅
- Base class structure ✅

**Medium Risk:**
- execute() orchestration logic ✅
- File operations ✅
- Graph operation failures ✅

**Mitigation:**
- Per-file try/catch ✅
- Per-resource try/catch ✅
- Log warnings, don't fail ✅

**No additional risks identified.**

---

## Effort Estimate

**Don's estimate:** 3.75 days → 4 days with buffer

**Breakdown review:**
- Phase 1 (edge types): 0.5 day ✅
- Phase 2 (base class): 1 day ✅
- Phase 3 (config schema): 0.5 day ✅
- Phase 4 (tests): 1 day ✅
- Phase 5 (docs): 0.5 day ✅
- Phase 6 (exports): 0.25 day ✅

**Total:** 3.75 days

**Adjustment needed:**
- +0.25 day for fixing re-export path issue
- +0.25 day for rewriting test mocks (if pursued)

**Revised estimate:** 4-4.5 days (Don's buffer is sufficient)

---

## Execution Order

**Don's proposed order:**
1. Edge types
2. InfraAnalyzer base class
3. Config schema
4. Tests
5. Documentation
6. Type exports

**Alternative (TDD-strict):**
1. Edge types
2. Infrastructure types (Phase 1.2)
3. **Tests skeleton** (write test cases but expect failures)
4. InfraAnalyzer base class (make tests pass)
5. Config schema
6. Documentation
7. Type exports

**Verdict:** Don's order is acceptable (not pure TDD, but pragmatic for framework code). Tests come after base class is written, which is fine for non-algorithmic code.

---

## Specific Code Review

### Phase 1.1: Edge Types

**File:** `packages/types/src/edges.ts`

**✅ Correct location:** After line 103 (after existing edges, before `export type EdgeType`)

**✅ Correct format:** String constants in EDGE_TYPE object

**✅ Comment acknowledges duplicates:** Lines 73-74 note READS_FROM/WRITES_TO already exist

**No issues.**

---

### Phase 1.2: Infrastructure Types

**File:** `packages/types/src/infrastructure.ts` (new)

**✅ InfraResource interface:** Clean abstraction

**✅ CrossLayerLink interface:** Simple, correct

**✅ Config interfaces:** Match USG architecture

**🟡 Minor:** K8sMapping interface (lines 174-177) is unused in Phase 1, but OK to define early.

**No blocking issues.**

---

### Phase 2.1: InfraAnalyzer Base Class

**File:** `packages/core/src/plugins/InfraAnalyzer.ts` (new)

**✅ Lifecycle methods:** declareNodeTypes, declareEdgeTypes, discoverFiles, parseFile, linkToCode

**✅ metadata getter:** Correct PluginMetadata structure

**✅ execute() orchestration:** discover → parse → create nodes → link to code

**🔴 Issue:** Line 396 `as any` cast (addressed above)

**🔴 Issue:** Imports from wrong path for re-export (addressed above)

**✅ Error handling:** Per-file try/catch, per-resource try/catch

**✅ Logging:** Uses `this.log(context)` correctly

**Fix required:** Address branded node casting, add comment.

---

### Phase 3.1: Config Schema

**File:** `packages/types/src/plugins.ts`

**✅ Location:** After line 221 (after `routing?: RoutingRule[];`)

**✅ Import:** `import type { InfrastructureConfig } from './infrastructure.js';`

**✅ Field:** `infrastructure?: InfrastructureConfig;`

**No issues.**

---

### Phase 4.1: Unit Tests

**File:** `test/unit/InfraAnalyzer.test.js` (new)

**✅ Test structure:** Uses `node:test` API correctly

**✅ MockInfraAnalyzer:** Good test double pattern

**🔴 Issue:** fs.readFileSync global mutation (addressed above)

**✅ Test cases:** Cover key scenarios

**Fix required:** Rewrite fs mocking or add TODO.

---

### Phase 5.2: AI Agent Guide

**File:** `_ai/infrastructure-plugins.md` (new)

**✅ Complete examples:** TypeScript code blocks with full implementations

**✅ Edge type tables:** Direction conventions clear

**✅ Error handling guidance:** Return empty arrays, don't throw

**🟡 Suggestion:** Add "Common Mistakes" section

**No blocking issues.**

---

### Phase 6: Type Exports

**Files:** `packages/types/src/index.ts`, `packages/core/src/plugins/index.ts`

**🔴 Issue:** `core/plugins/index.ts` doesn't exist (addressed above)

**Fix required:** Export from `core/src/index.ts` instead.

---

## Implementation Checklist

Before Kent/Rob start:

- [ ] Fix re-export path (use `core/src/index.ts` not `core/plugins/index.ts`)
- [ ] Add comment explaining `as any` cast for infrastructure nodes
- [ ] Rewrite test mocks to avoid global fs mutation (or add TODO if deferring)
- [ ] Add "Common Mistakes" section to AI agent guide (optional but recommended)

---

## Final Verdict

**REJECT — Minor fixes required before implementation**

### Required Changes:

1. **Fix re-export path** (Phase 2, Phase 6)
   - Don't reference `core/plugins/index.ts` (doesn't exist)
   - Export InfraAnalyzer from `core/src/index.ts` instead
   - Add after line 69: `export { InfraAnalyzer } from './plugins/InfraAnalyzer.js';`

2. **Add branded node comment** (Phase 2.1, line 396)
   ```typescript
   // Infrastructure nodes use generic shape, not branded types.
   // TODO(tech-debt): Define branded types in @grafema/types/src/branded.ts
   await graph.addNode(node as any);
   ```

3. **Fix test mocking strategy** (Phase 4.1)
   - Either: rewrite tests to avoid global fs mutation
   - Or: add TODO comment acknowledging fragility and plan to fix in Phase 2

### Recommended (Optional):

4. **Add "Common Mistakes" section** to AI agent guide (Phase 5.2)
   - 3-5 bullet points with anti-patterns to avoid

---

## Revised Plan Action Items

**For Don:**
1. Update plan section "Phase 2: InfraAnalyzer Base Class"
   - Remove reference to `core/plugins/index.ts`
2. Update plan section "Phase 6: Type Exports"
   - Change "Update `packages/core/src/plugins/index.ts`" to "Update `packages/core/src/index.ts`"
3. Add comment about branded node casting to InfraAnalyzer code snippet
4. Revise test code to avoid global fs mutation OR add explicit TODO

**After revisions:** Re-run auto-review or proceed directly to implementation if changes are minimal.

---

## Summary

**Vision:** ✅ Excellent alignment with USG architecture
**Research:** ✅ Grounded in real industry patterns
**Scope:** ✅ Appropriate for Phase 1
**Code Quality:** 🟡 Minor issues, one path error
**Tests:** 🟡 Good coverage, fragile mocking
**Documentation:** ✅ Excellent AI agent guide

**Overall:** High-quality plan with one critical path error and two minor issues. Fix the re-export path, add explanatory comments, and this is ready for implementation.
