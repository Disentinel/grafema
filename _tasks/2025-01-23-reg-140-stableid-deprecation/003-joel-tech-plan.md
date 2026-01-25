# DETAILED TECHNICAL IMPLEMENTATION PLAN - REG-140: stableId Deprecation

**Prepared by:** Joel Spolsky, Implementation Planner
**Date:** 2025-01-23
**Verified by:** Don Melton (analysis complete)

## Executive Summary

Complete migration removing `stableId` field assignment from 15 core files (Categories A & B). Type definitions will be updated (Category D). VersionManager's internal `_stableId` remains untouched (Category C - independent versioning system).

**Key Finding:** stableId = id in ALL locations. Values are identical. Safe to replace all lookups with `id`.

---

## PHASE 1: TYPE DEFINITIONS (Foundation)
**Must execute first** - other phases depend on updated interfaces

### 1.1 packages/types/src/nodes.ts
**Location:** Line 84 (BaseNodeRecord interface)
**Change:** Make stableId optional but deprecated

```
BEFORE (line 84):
  stableId?: string;

AFTER:
  /**
   * @deprecated Use `id` field instead. stableId always equals id.
   * This field will be removed in a future version.
   */
  stableId?: string;
```

### 1.2 packages/core/src/plugins/analysis/ast/types.ts
**Location:** Line 22 (FunctionInfo interface)
**Change:** Add deprecation comment

```
BEFORE (line 22):
  stableId?: string;  // Deprecated: use id (now contains semantic ID)

AFTER:
  /**
   * @deprecated Use `id` field instead. The id field now contains the semantic ID.
   * This field will be removed in a future version.
   */
  stableId?: string;
```

### 1.3 packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts
**Location:** Line 46 (FunctionInfo interface, local)
**Change:** Add deprecation comment

```
BEFORE (line 46):
  stableId?: string;  // Deprecated: id now contains semantic ID

AFTER:
  /**
   * @deprecated Use `id` field instead. The id field now contains the semantic ID.
   * This field will be removed in a future version.
   */
  stableId?: string;
```

---

## PHASE 2: REMOVE PURE DUPLICATION (Category A)
**Execute after Phase 1**

### 2.1 packages/core/src/core/nodes/FunctionNode.ts
**Location:** Lines 69 and 147

Remove `stableId: id,` from both create() and createWithContext() methods.

### 2.2 packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts
**Location:** Lines 255 and 315

Remove `stableId: functionId,` from ClassProperty and ClassMethod handlers.

**Note:** ClassVisitor.ts interface ClassFunctionInfo (line 44) has `stableId: string;` (required)
- This must be made optional before removing these assignments

### 2.3 packages/core/src/core/ASTWorker.ts
**Location:** Lines 406 and 475

Remove `stableId: functionId,` and `stableId: methodId,` from FunctionDeclaration and ClassMethod handlers.

**Note:** ASTWorker.ts interface FunctionNode (line 77) has `stableId: string;` (required)
- This must be made optional before removing these assignments

### 2.4 packages/core/src/plugins/analysis/JSASTAnalyzer.ts
**Multiple locations**

Search file for pattern: `stableId:` and remove all lines matching `stableId: <variable>,` during node push operations.

---

## PHASE 3: UPDATE LOOKUPS (Category B)

### 3.1 packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts
**Location:** Line 388

```
BEFORE (lines 386-388):
        if (scopeNode.id === currentScopeId ||
            scopeNode.originalId === currentScopeId ||
            scopeNode.stableId === currentScopeId) {

AFTER (lines 386-388):
        if (scopeNode.id === currentScopeId ||
            scopeNode.originalId === currentScopeId) {
```

### 3.2 packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts
**Location:** Line 71 (interface VersionAwareGraph)

Mark `getNodesByStableId` method as deprecated with JSDoc comment.

---

## PHASE 4: COMMENTS ONLY (Category E)

### 4.1 packages/core/src/core/ManifestStore.ts

Comments only - no changes required.

---

## PHASE 5: DO NOT TOUCH (Category C)

### 5.1 packages/core/src/core/VersionManager.ts

**LEAVE UNTOUCHED** - VersionManager's `_stableId` is independent internal versioning mechanism.

---

## TEST STRATEGY

### Unit Tests (Run in Phase Order)
```bash
# Phase 2 - Remove assignments:
node --test test/unit/core/nodes/FunctionNode.test.js
node --test test/unit/plugins/analysis/ast/visitors/ClassVisitor.test.js
node --test test/unit/core/ASTWorker.test.js
node --test test/unit/plugins/analysis/JSASTAnalyzer.test.js

# Phase 3 - Update lookups:
node --test test/unit/plugins/enrichment/ValueDomainAnalyzer.test.js
node --test test/unit/plugins/analysis/IncrementalAnalysisPlugin.test.js
```

### Full Test Suite (Final Verification)
```bash
npm test
```

---

## VERIFICATION STEPS

- [ ] No stableId assignments remain in node creation
- [ ] All stableId lookups replaced with id or removed
- [ ] Type interfaces marked with @deprecated
- [ ] VersionManager._stableId untouched
- [ ] All tests pass

---

## ROLLBACK PLAN

If tests fail:
1. Identify failing test
2. `git restore <file>` for affected files
3. Analyze: incorrect test or missed stableId usage?
4. Document failure, request review from Don

---

## DEPENDENCY GRAPH

```
Phase 1 (Types)
     ↓
Phase 2 (Remove assignments) ← depends on Phase 1
     ↓
Phase 3 (Update lookups) ← depends on Phase 2
     ↓
Phase 4 (Comments) ← independent
     ↓
Full Test Suite
```

---

## FILES SUMMARY

| Category | Files | Action | Risk |
|----------|-------|--------|------|
| A: Pure Duplication | FunctionNode.ts, ClassVisitor.ts, ASTWorker.ts, JSASTAnalyzer.ts | Remove stableId assignments | Low |
| B: Lookup/Matching | ValueDomainAnalyzer.ts, IncrementalAnalysisPlugin.ts | Replace comparisons, deprecate method | Low |
| D: Type Definitions | nodes.ts, types.ts, FunctionVisitor.ts, ClassVisitor.ts | Add @deprecated comments | None |
| C: Internal Versioning | VersionManager.ts | LEAVE UNTOUCHED | None |
| E: Comments Only | ManifestStore.ts | No changes | None |

---

**Ready for:** Kent Beck (test implementation) → Rob Pike (code changes)
