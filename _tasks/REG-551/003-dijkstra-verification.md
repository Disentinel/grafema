## Dijkstra Plan Verification: REG-551

**Verdict:** REJECT

**Reason:** Don's plan is correct in its core diagnosis and primary fix, but misses two downstream consumers that perform the same basename comparison as `TypeSystemBuilder.ts`. These omissions would leave `this`-property mutation tracking and `++/--` update expressions silently broken after the fix. The implementation cannot proceed without addressing these gaps.

---

## Completeness Tables

### CLASS Node Creation Sites

| Location | Creates CLASS node? | Uses basename? | Plan covers it? |
|----------|---------------------|----------------|-----------------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts:1692` | YES — `ScopeTracker(basename(module.file))` passed to `ClassVisitor` | YES | YES |
| `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts:190` (`ClassDeclaration` handler) | YES — `ClassNode.createWithContext(name, scopeTracker.getContext(), ...)` | YES (inherits from ScopeTracker) | YES (implicitly via "ClassVisitor receives scopeTracker") |
| `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts:695` (`ClassExpression` handler) | YES — same `createWithContext` pattern; handles `const Foo = class {}` | YES (same ScopeTracker) | PARTIAL — plan says "ClassVisitor" generically, does not distinguish the two handlers |
| `packages/core/src/core/ASTWorker.ts:189` | YES — `ScopeTracker(basename(filePath))` where `filePath` is absolute | YES | YES |
| `packages/core/src/core/ASTWorker.ts:442` | YES — `ClassNode.createWithContext(name, scopeTracker.getContext(), ...)` | YES (inherits from ScopeTracker) | YES |
| `packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts:406` | YES — but via `versionManager.enrichNodeWithVersion`, NOT `ClassNode.createWithContext`; uses `filePath` directly, separate ID scheme | NO (different code path, not affected by ScopeTracker) | N/A — not in scope |

### Downstream `file` Consumers (where CLASS node `file` field or CLASS semantic ID is consumed using basename)

| Location | Compares against basename? | Plan covers it? |
|----------|---------------------------|-----------------|
| `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts:137` — `bufferClassNodes()`, `moduleBasename = basename(module.file)`, compare `decl.file === moduleBasename` | YES | YES |
| `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts:154` — `globalContext = { file: moduleBasename, ... }` for computing external class IDs | YES (flows from same `moduleBasename`) | YES |
| `packages/core/src/plugins/analysis/ast/builders/MutationBuilder.ts:200-201` — `fileBasename = basename(file)`, compare `c.file === fileBasename` in `bufferObjectMutationEdges()` | **YES — MISSED** | **NO** |
| `packages/core/src/plugins/analysis/ast/builders/UpdateExpressionBuilder.ts:192-194` — `fileBasename = basename(file)`, compare `c.file === fileBasename` | **YES — MISSED** | **NO** |
| `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts:122` — `globalContext = { file, ... }` for `DERIVES_FROM` superclass ID (uses `classDecl.file`, will auto-update) | YES, indirectly | YES (side effect of fixing CLASS node `file`) |
| `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts:428-434` — external interface reference uses `classDecl.file` | YES, indirectly | YES (self-consistent after fix) |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts:603` — `graph.queryNodes({ type: 'CLASS', name, file })` where `file` is extracted from `variableId` string | Indirect — file comes from variable ID string, not from CLASS node directly | Unexamined but likely low risk (queries existing nodes) |
| `packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts:382,386,397` — `globalContext = { file: func.file, ... }` for `REJECTS`/`THROWS` CLASS IDs | Indirect — uses `func.file`, which in sequential path is `module.file` (correct) and in ASTWorker is `filePath` (absolute, pre-existing inconsistency) | Not examined in plan |

---

## Gaps Found

### Gap 1 (BLOCKING): `MutationBuilder.ts` — missed downstream consumer

File: `packages/core/src/plugins/analysis/ast/builders/MutationBuilder.ts`, lines 198-201

```typescript
// Compare using basename since classes use scopeTracker.file (basename)
// but mutations use module.file (full path)
const fileBasename = basename(file);
const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === fileBasename);
```

This code handles `this.property = value` mutations (REG-152). After the fix, `classDecl.file` will be the relative path (e.g., `src/Orchestrator.ts`), but `fileBasename` will still be `Orchestrator.ts`. The lookup will silently fail — `classDecl` will be `undefined` — and no `FLOWS_INTO` edge will be created for any `this` property mutation. **This is a silent data loss bug.**

Fix required: Remove `basename()` call, compare `decl.file === file` directly (same as TypeSystemBuilder fix). Remove `basename` import from `MutationBuilder.ts` if no longer used.

### Gap 2 (BLOCKING): `UpdateExpressionBuilder.ts` — missed downstream consumer

File: `packages/core/src/plugins/analysis/ast/builders/UpdateExpressionBuilder.ts`, lines 192-194

```typescript
const fileBasename = basename(file);
const classDecl = classDeclarations.find(c =>
  c.name === enclosingClassName && c.file === fileBasename
);
```

This code handles `this.count++` / `this.count--` (update expressions on `this` properties). Same failure mode as Gap 1: the lookup fails silently after the fix.

Fix required: Same pattern — remove `basename()`, compare directly. Remove `basename` import if no longer needed.

### Gap 3 (INFORMATIONAL): ASTWorker protocol change scope understated

Don's plan says "Add `relativeFile: m.file` to the task message sent to workers" and mentions 2 files (ASTWorkerPool.ts, ASTWorker.ts). The actual change spans 4 interfaces/locations within those 2 files:

- `ASTWorkerPool.ts`: `ParseTask` interface (add `relativeFile: string`), `_dispatchNext()` postMessage (include `relativeFile`), `_workerReady()` postMessage (include `relativeFile`), `parseModule()` public API signature
- `ASTWorker.ts`: `ParseMessage` interface (add `relativeFile: string`), `parseModule()` function signature (add `relativeFile` param), `parentPort.on('message')` handler (pass `msg.relativeFile`)

This is not a gap in coverage, but the implementer must be aware of the full scope. The `relativeFile` field must be added consistently in both postMessage calls in ASTWorkerPool (both `_dispatchNext` and `_workerReady`).

### Gap 4 (INFORMATIONAL): ASTWorker method IDs — pre-existing inconsistency not addressed

In `ASTWorker.ts` line 459:
```typescript
const methodId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());
```

After the fix, `scopeTracker.file` will be `relativeFile` (e.g., `src/Orchestrator.ts`), so method IDs will use the relative path. But at line 467:
```typescript
file: filePath,  // still the absolute path
```

This creates an inconsistency between the method's semantic ID (contains relative path) and its `file` field (contains absolute path). This is a **pre-existing inconsistency** that existed before this bug: the old behavior had `scopeTracker.file = basename(filePath)` while `file = filePath` (absolute). The fix improves the ID but doesn't fully close the absolute-vs-relative gap in `file` field for worker-path functions.

The plan does not need to fix this pre-existing issue, but the implementer should note it: **the sequential path (JSASTAnalyzer) will have functions with `file = relative path` while the parallel path (ASTWorker) will have functions with `file = absolute path`.** This inconsistency predates REG-551 and is out of scope here.

---

## Precondition Issues

### Precondition 1: Test plan assertion is too weak

Don proposes:
```javascript
assert.ok(
  classNode.file.includes('/') || classNode.file === 'index.js',
  'file should be a path (not just a basename), got: ' + classNode.file
);
```

The `includes('/')` check would pass for any path with a slash, including the old behavior if the test fixture happened to have a file at root level. The stronger assertion is:
```javascript
assert.strictEqual(classNode.file, 'src/Service.js');
```
The new test case (subdirectory `src/Service.js`) already pins to `'src/Service.js'` — that is strong enough. The weak assertion on the existing test at line 191 is unnecessary to add; the new test is sufficient.

### Precondition 2: Snapshot update guidance is correct

Don correctly says "run `UPDATE_SNAPSHOTS=true` and do not manually predict which nodes change." This is consistent with the MEMORY entry. Confirmed: snapshot CLASS nodes currently store `file: "db.js"` (basename). After fix, they will store `file: "src/db.js"` (relative path). The fixtures already have their files in subdirectories (e.g., `test/fixtures/02-api-service/src/db.js`), confirming the snapshot will change.

---

## Required Before Implementation Can Start

1. **Add `MutationBuilder.ts` to the list of files to modify** (Change 4):
   - Remove `const fileBasename = basename(file)` at line 200
   - Change `c.file === fileBasename` to `c.file === file` at line 201
   - Verify and remove unused `basename` import from `MutationBuilder.ts`

2. **Add `UpdateExpressionBuilder.ts` to the list of files to modify** (Change 5):
   - Remove `const fileBasename = basename(file)` at line 192
   - Change `c.file === fileBasename` to `c.file === file` at line 193-194
   - Verify and remove unused `basename` import from `UpdateExpressionBuilder.ts`

3. **Update the test plan** to include tests for `this`-mutation and update-expression cases, specifically verifying that `FLOWS_INTO` edges are created for `this.property = value` and `FLOWS_INTO`/graph edges for `this.count++` when the class is in a subdirectory.

The core analysis (root cause, fix strategy, primary files) in Don's plan is correct. Only the downstream consumer coverage is incomplete.
