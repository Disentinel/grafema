## Uncle Bob PREPARE Review: REG-551

### JSASTAnalyzer.ts

**File size:** 4625 lines — CRITICAL

**Method:** `analyzeModule` (line 1674)
- Lines: 640 (lines 1674–2313)
- **Recommendation:** SKIP
- The method is a 640-line monolith and would warrant a split on any normal task. However, the actual change here is surgical: one character removed from one line (`basename(module.file)` → `module.file`). The method body we are touching (the ScopeTracker initialization block, lines 1690–1695) is clean and well-commented. Splitting the method is beyond scope and carries its own regression risk given the method's many interdependencies. The file-size violation is pre-existing technical debt; flagging it, but the fix does not require addressing it now.

---

### ASTWorker.ts

**File size:** 566 lines — MUST SPLIT

**Method:** `parseModule` (line 179)
- Lines: 387 (lines 179–566, encompasses the full module function and all its closures)
- **Recommendation:** SKIP
- The file is 566 lines, which is above the 500-line threshold. However, `parseModule` is a single top-level function (not a class), and its size comes from extensive inline `traverse` visitor blocks — each visitor is a self-contained handler. This is the idiomatic Babel traversal pattern; splitting it would require passing shared mutable collections between functions, increasing coupling. The change we make here is again surgical: one line (`ScopeTracker(basename(filePath))` → `ScopeTracker(relativeFile)`) plus adding one parameter to the function signature. Refactoring the function is out of scope and would risk disturbing the visitor closures. Flag the file-size debt, but proceed.

**Note on `_handleMessage`/`_workerReady` in `ASTWorkerPool.ts`:** The message-passing in ASTWorkerPool.ts is a protocol change (adding `relativeFile` to `postMessage`). The `_dispatchNext` (line 178) and `_workerReady` (line 225) methods are each under 20 lines and straightforward. No concerns there.

---

### ASTWorkerPool.ts

**File size:** 299 lines — OK

**Methods:** `_dispatchNext` (line 178) and `_workerReady` (line 225)
- Lines: 16 and 14 respectively
- **Recommendation:** SKIP
- Both methods are clean and small. The change adds one field (`relativeFile`) to the `postMessage` call in each method and to the `ParseTask` interface. No structural issues. The duplication of the `postMessage` shape between `_dispatchNext` and `_workerReady` is a minor design smell (same object shape in two places), but extracting it would add indirection without real benefit. Leave it.

---

### TypeSystemBuilder.ts

**File size:** 475 lines — OK

**Method:** `bufferClassNodes` (line 134)
- Lines: 35 (lines 134–168)
- **Recommendation:** SKIP
- The method is compact and well-structured. It has two clearly delineated phases: build a lookup map, then iterate instantiations. The change is removing the `basename()` call and one variable (`moduleBasename`), replacing two occurrences of `moduleBasename` with `module.file`. Also need to remove the `basename` import if it becomes unused after this change (check: `bufferClassDeclarationNodes` at line 71 uses `file` directly, not `basename`; the only `basename` usage in the file is at lines 137 and 154, both in `bufferClassNodes`). Import removal is safe.

---

### MutationBuilder.ts

**File size:** 372 lines — OK

**Method:** `bufferObjectMutationEdges` (line 171)
- Lines: 83 (lines 171–253)
- **Recommendation:** SKIP
- The method is 83 lines with moderate nesting (max 3 levels). The structure is readable: guard clause for `this` vs regular object, then two separate resolution paths, then the edge buffering. The change is minimal: remove `const fileBasename = basename(file)` (line 200) and change `c.file === fileBasename` to `c.file === file` (line 201). Also need to verify and remove unused `basename` import — this is the only `basename` call in the file (grep confirms: line 200 is the sole usage). Import removal is safe.

- One observation: the method receives 5 parameters. This is at the acceptable limit. Not a problem for this task.

---

### UpdateExpressionBuilder.ts

**File size:** 262 lines — OK

**Method:** `bufferMemberExpressionUpdate` (line 158)
- Lines: 104 (lines 158–261)
- **Recommendation:** SKIP
- The method is 104 lines, above the 50-line soft limit, but not a split candidate here. It handles one clearly bounded concern (member expression update edges) with two sub-cases (`this` vs regular object). The `this` branch at lines 188–197 is exactly where our change lands: remove `const fileBasename = basename(file)` (line 192) and change `c.file === fileBasename` to `c.file === file` (lines 193–194).

- Verify `basename` import removal: this is the only `basename` usage in the file (line 7 import, line 192 usage). Safe to remove.

- The `displayName` IIFE at lines 208–220 is a stylistic quirk but not harmful. Leave it.

---

## Overall Verdict

**Proceed to implementation:** YES

**Refactoring tasks before implementation:** NONE

The changes are purely surgical value substitutions — removing `basename()` wrappers in five locations across six files. No methods need splitting or structural changes prior to implementation. File-size violations in `JSASTAnalyzer.ts` (4625 lines) and `ASTWorker.ts` (566 lines) are pre-existing debt, out of scope for this task.

**Implementation checklist for the coder (no surprises):**

1. `JSASTAnalyzer.ts:1692` — `ScopeTracker(basename(module.file))` → `ScopeTracker(module.file)`
2. `ASTWorker.ts:189` — `ScopeTracker(basename(filePath))` → `ScopeTracker(relativeFile)` + add `relativeFile` param to `parseModule`
3. `ASTWorkerPool.ts` — add `relativeFile: string` to `ParseTask` interface; add `relativeFile: task.relativeFile` / `nextTask.relativeFile` to both `postMessage` calls in `_dispatchNext` and `_workerReady`; add `relativeFile` to `ParseMessage` interface in ASTWorker.ts and to the `parentPort.on('message')` dispatch
4. `TypeSystemBuilder.ts:137,154` — remove `moduleBasename`, use `module.file` directly; remove unused `basename` import
5. `MutationBuilder.ts:200-201` — remove `fileBasename`, use `file` directly; remove unused `basename` import
6. `UpdateExpressionBuilder.ts:192-194` — remove `fileBasename`, use `file` directly; remove unused `basename` import
7. Run `UPDATE_SNAPSHOTS=true` after build to regenerate CLASS node snapshots
