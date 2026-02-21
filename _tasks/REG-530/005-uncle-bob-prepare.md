## Uncle Bob PREPARE Review: REG-530

**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-20
**Task:** REG-530 - Column tracking for IMPORT nodes

---

### File 1: ImportExportVisitor.ts

**Path:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`
**File size:** 380 lines — **OK** (well below 500-line threshold)

**Methods to modify:**

1. **`getImportHandlers()`** (lines 98-235)
   - Length: 137 lines — **EXCESSIVE**
   - Contains: 2 separate handlers (ImportDeclaration, CallExpression)
   - ImportDeclaration handler: ~44 lines
   - CallExpression handler: ~79 lines
   - Nesting: 2-3 levels (acceptable)
   - Parameters: 0 (excellent)

2. **`ImportSpecifierInfo` interface** (lines 41-45)
   - Length: 5 lines (trivial)
   - Adding one field

**File-level issues:**
- File is well-organized, single responsibility
- Clear separation between import and export handling
- Good documentation

**Method-level issues:**
1. `getImportHandlers()` violates SRP — contains TWO distinct handlers:
   - Static import handler (ImportDeclaration)
   - Dynamic import handler (CallExpression)
2. CallExpression handler (79 lines) is too long for a nested function
3. Both handlers do similar work (collect column, build ImportInfo) but can't share code due to structure

**Recommendation:** **REFACTOR**

**Required preparation:**
1. Extract `ImportDeclaration` handler to private method `handleStaticImport()`
2. Extract `CallExpression` handler to private method `handleDynamicImport()`
3. Extract common logic (e.g., `templateLiteralToString`) if reused
4. `getImportHandlers()` becomes a simple factory that returns handlers

**After refactoring:**
- `getImportHandlers()`: ~15 lines (just return object)
- `handleStaticImport()`: ~50 lines
- `handleDynamicImport()`: ~85 lines
- Each method has single responsibility
- Easier to test, read, modify

---

### File 2: ModuleRuntimeBuilder.ts

**Path:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts`
**File size:** 454 lines — **OK** (approaching 500, but acceptable)

**Methods to modify:**

1. **`bufferImportNodes()`** (lines 53-152)
   - Length: 99 lines — **EXCESSIVE**
   - Parameters: 2 (acceptable)
   - Nesting: 3-4 levels (borderline)
   - Duplicated code: External module creation logic appears twice (lines 84-99, 132-148)

**File-level issues:**
- File has clear responsibility (buffer runtime nodes)
- Good separation by domain (imports, exports, stdio, etc.)
- All methods follow same pattern

**Method-level issues:**
1. `bufferImportNodes()` has two distinct code paths:
   - Side-effect imports (lines 58-99): 41 lines
   - Regular imports with specifiers (lines 100-150): 50 lines
2. **Significant duplication:** External module creation logic duplicated (14 lines each)
3. Deep nesting in regular imports path (loop > if > nested if)

**Recommendation:** **REFACTOR**

**Required preparation:**
1. Extract external module creation to private method `createExternalModuleIfNeeded(source: string, moduleId: string)`
2. Extract side-effect import handling to `bufferSideEffectImport()`
3. Extract regular import handling to `bufferRegularImport()`
4. `bufferImportNodes()` becomes orchestrator calling these methods

**After refactoring:**
- `bufferImportNodes()`: ~15 lines (loop + dispatch)
- `bufferSideEffectImport()`: ~30 lines
- `bufferRegularImport()`: ~35 lines
- `createExternalModuleIfNeeded()`: ~12 lines
- **Zero duplication**
- Each method focused on one concern

---

### File 3: ImportNode.ts

**Path:** `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/ImportNode.ts`
**File size:** 124 lines — **EXCELLENT** (small, focused)

**Methods to modify:**

1. **`ImportNodeRecord` interface** (lines 10-22)
   - Length: 13 lines
   - Adding 3 new optional fields (lines 18-20)

2. **`ImportNodeOptions` interface** (lines 24-33)
   - Length: 10 lines
   - Adding 3 new optional fields (lines 29-31)

3. **`create()` static method** (lines 52-104)
   - Length: 52 lines
   - Parameters: 6 (high but manageable — all required/semi-required)
   - Nesting: 2 levels (excellent)
   - Logic: straightforward validation + field assignment

**File-level issues:**
- **NONE** — This file is a textbook example of clean code
- Single responsibility (IMPORT node contract)
- Clear validation
- No duplication

**Method-level issues:**
- **NONE**
- `create()` method is long (52 lines) but simple — just validation + assignment
- No complex logic, no nested conditionals
- Parameter count (6) is justified — all are semantically required for node identity

**Recommendation:** **SKIP REFACTORING**

**Rationale:**
- File already follows all clean code principles
- Changes are trivial additions (3 optional fields)
- No complexity introduced
- Existing structure supports the change perfectly

**Implementation notes:**
- Add fields to both interfaces (done in 2 lines each)
- Add conditional assignment in `create()` (3-line block, following existing pattern)
- Total change: ~10 lines, zero complexity added

---

### File 4: nodeLocator.ts

**Path:** `/Users/vadimr/grafema-worker-1/packages/vscode/src/nodeLocator.ts`
**File size:** 102 lines — **EXCELLENT** (small, focused)

**Methods to modify:**

1. **`findNodeAtCursor()`** (lines 19-95)
   - Length: 76 lines — **BORDERLINE**
   - Parameters: 4 (acceptable)
   - Nesting: 2-3 levels (acceptable)
   - Contains: 3 distinct matching strategies

**File-level issues:**
- File is focused (node location only)
- Clear documentation
- Good separation (two exported functions)

**Method-level issues:**
1. `findNodeAtCursor()` has three separate matching strategies:
   - Exact line match with column distance (lines 35-54)
   - Range-based matching (lines 57-65)
   - Fallback to closest line (lines 69-88)
2. Each strategy is ~15-20 lines
3. Some duplication in metadata parsing pattern

**Recommendation:** **SKIP REFACTORING**

**Rationale:**
- While the method is long (76 lines), it's cohesive — all strategies serve one goal
- Each strategy is simple and easy to follow
- Extraction would create trivial methods with no reuse value
- The sequential "try strategy A, then B, then C" pattern is readable as-is
- REG-530 change is trivial (just use column from metadata)

**Implementation notes for REG-530:**
- Change is localized to metadata parsing (line 47: `const nodeColumn = metadata.column ?? 0;`)
- IMPORT nodes will now have column field populated
- No logic change needed — existing distance calculation works

**Potential future improvement (NOT for REG-530):**
- If this function grows beyond 100 lines, extract matching strategies
- But for now, YAGNI applies

---

## Overall Risk Assessment

**Overall Risk:** **LOW-MEDIUM**

### High-risk files requiring refactoring:

1. **ImportExportVisitor.ts** — MUST REFACTOR
   - Risk: Modifying 137-line nested function with two handlers
   - Mitigation: Extract handlers to private methods BEFORE adding column tracking

2. **ModuleRuntimeBuilder.ts** — MUST REFACTOR
   - Risk: Modifying 99-line method with duplication
   - Mitigation: Extract side-effect/regular paths, dedupe external module logic

### Low-risk files (no refactoring needed):

3. **ImportNode.ts** — Ready for implementation
   - Clean file, trivial change (add 3 optional fields)

4. **nodeLocator.ts** — Ready for implementation
   - Borderline long method, but change is trivial

---

## Implementation Order

**STEP 1 — Refactor ImportExportVisitor.ts:**
1. Extract `handleStaticImport()` private method
2. Extract `handleDynamicImport()` private method
3. Simplify `getImportHandlers()` to factory
4. Run tests — verify no behavior change
5. Commit: "refactor: extract import handlers from getImportHandlers()"

**STEP 2 — Refactor ModuleRuntimeBuilder.ts:**
1. Extract `createExternalModuleIfNeeded()` helper
2. Extract `bufferSideEffectImport()` private method
3. Extract `bufferRegularImport()` private method
4. Simplify `bufferImportNodes()` to orchestrator
5. Run tests — verify no behavior change
6. Commit: "refactor: extract import buffering logic from bufferImportNodes()"

**STEP 3 — Implement REG-530:**
1. Add column tracking to ImportExportVisitor (both handlers)
2. Add column field to ImportNode interfaces + create()
3. Pass column to ModuleRuntimeBuilder (both import types)
4. Verify nodeLocator picks up column field
5. Run tests
6. Commit: "feat: add column tracking for IMPORT nodes (REG-530)"

---

## Quality Gates

**Before starting STEP 3:**
- [ ] ImportExportVisitor has no methods >50 lines
- [ ] ModuleRuntimeBuilder has no duplicated external module logic
- [ ] All existing tests pass
- [ ] Two refactoring commits pushed

**During STEP 3:**
- [ ] New code follows refactored structure
- [ ] No method added/modified exceeds 50 lines
- [ ] Column field added to all required interfaces
- [ ] Tests verify column is tracked end-to-end

**Final check:**
- [ ] No file exceeds 500 lines
- [ ] No method exceeds 50 lines
- [ ] No duplication introduced
- [ ] Test coverage maintained/improved

---

## Uncle Bob's Verdict

**APPROVED WITH MANDATORY REFACTORING**

These files can support REG-530, but two require preparatory refactoring to maintain code quality. The refactoring is straightforward and will make the actual feature implementation trivial.

The good news: ImportNode.ts and nodeLocator.ts are already clean. The bad news: ImportExportVisitor and ModuleRuntimeBuilder have accumulated complexity that must be addressed first.

**Time estimate:**
- Refactoring (STEP 1-2): 2-3 hours
- Implementation (STEP 3): 30-45 minutes
- Total: ~4 hours

**Refactoring is NOT optional.** Adding column tracking to already-complex methods will make them unmaintainable. Extract first, then extend.
