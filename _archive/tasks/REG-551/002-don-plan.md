# Don's Plan: REG-551

## Exploration Findings

### CLASS Node Creation

CLASS nodes are created in two code paths:

**1. Sequential analysis path** (`JSASTAnalyzer.analyzeModule`):
- File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`, line 1692
- Code: `const scopeTracker = new ScopeTracker(basename(module.file));`
- The `ClassVisitor` receives this `scopeTracker` and calls `ClassNode.createWithContext(className, scopeTracker.getContext(), ...)`.
- `ClassNode.createWithContext` sets `file: context.file` — which equals `scopeTracker.file` = `basename(module.file)`.
- Result: CLASS node gets `file = "Orchestrator.ts"` (basename only).

**2. Parallel analysis path** (`ASTWorker.ts`):
- File: `packages/core/src/core/ASTWorker.ts`, line 189
- Code: `const scopeTracker = new ScopeTracker(basename(filePath));`
- `filePath` is the full absolute path passed to the worker. `basename(filePath)` strips everything.
- The `ClassDeclaration` handler at line 442 calls `ClassNode.createWithContext(className, scopeTracker.getContext(), ...)`.
- Same result: CLASS node gets `file = "Orchestrator.ts"`.

**What `module.file` / `filePath` contains:**
- `module.file` in JSASTAnalyzer = relative path from workspace root (e.g., `packages/core/src/Orchestrator.ts`).
- `filePath` in ASTWorker = the value of `resolveNodeFile(m.file, projectPath)` which is the **absolute** path.

This means ASTWorker's `filePath` is an absolute path (e.g., `/Users/vadimr/grafema/packages/core/src/Orchestrator.ts`) — not relative. The worker receives it via `ASTWorkerPool` line 530: `file: resolveNodeFile(m.file, projectPath)`.

**Downstream coupling in TypeSystemBuilder:**
- File: `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts`, lines 137-154
- `bufferClassNodes()` explicitly uses `basename(module.file)` to compare against `decl.file` because CLASS nodes store basename. The comment says: "Use basename for comparison because CLASS nodes use scopeTracker.file (basename)".
- This code MUST be updated alongside the fix, or INSTANCE_OF edges will break.

### FUNCTION Node Creation (correct pattern)

FUNCTION nodes are created in `FunctionVisitor.ts` and directly in `ASTWorker.ts`:

**In JSASTAnalyzer path** (`FunctionVisitor.ts`, line 234):
```typescript
(functions as FunctionInfo[]).push({
  id: functionId,
  type: 'FUNCTION',
  name: node.id.name,
  file: module.file,   // <-- uses module.file directly (the relative path)
  ...
});
```

**In ASTWorker.ts** (line 397):
```typescript
collections.functions.push({
  ...
  file: filePath,      // <-- uses filePath directly (the absolute path here)
  ...
});
```

The key difference: FUNCTION nodes use `module.file` (or `filePath`) directly for the `file` field. CLASS nodes route through `ScopeTracker.getContext().file`, which is `basename(module.file)`.

### Root Cause

**Exact diagnosis:** `ScopeTracker` is initialized with `basename(module.file)` in both code paths. The intent behind using `basename` was to generate "shorter, more readable semantic IDs" (per the comments). However, `ClassNode.createWithContext()` also uses `context.file` — which comes from the same `ScopeTracker` — for the `file` field of the node record. This means the `file` field gets the basename, not the relative path.

FUNCTION nodes are not affected because they write `file: module.file` directly, bypassing `ScopeTracker.file` for the `file` field.

The design is internally inconsistent:
- `ScopeTracker.file` serves two purposes: (1) the file portion of semantic IDs, and (2) the `file` field in node records (via `ClassNode.createWithContext`).
- For semantic IDs, basename was acceptable (since IDs also embed class name and scope path, collisions are unlikely).
- For the `file` node record field, basename is wrong — it must be the relative path for querying.

**Note on ASTWorker path:** The `filePath` there is the absolute path. After the fix, CLASS nodes created by ASTWorker would have an absolute path in `file` — which is also wrong. However, looking at the worker integration in `JSASTAnalyzer.analyzeModulesParallel` (line 551-561), the worker results are passed to `GraphBuilder.build(module, ...)` where `module.file` is the original relative path. The `GraphBuilder` calls `TypeSystemBuilder.bufferClassDeclarationNodes`, which stores the CLASS node using the data already in `collections.classDeclarations` — those records carry `file = basename(filePath)`. The `module` object with the correct relative path is passed separately.

### Which path is the primary one?

Both paths exist in production. The sequential path (`analyzeModule`) is used for single-file re-analysis (incremental). The parallel path (`ASTWorkerPool`) is used for bulk analysis. The fix must cover both.

For ASTWorker, the `filePath` received is the absolute path (result of `resolveNodeFile(m.file, projectPath)`). The fix there requires passing the relative `m.file` to the worker OR stripping the `projectPath` prefix. Looking at `ASTWorkerPool`/`ASTWorker`, the worker receives `{ filePath, moduleId, moduleName }` where `filePath = resolveNodeFile(m.file, projectPath)`. We need to also pass `relativeFile: m.file` so the worker can use it for `ScopeTracker`.

## Fix Plan

### Files to Modify

**Primary fixes:**

1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — Fix sequential analysis path
2. `packages/core/src/core/ASTWorker.ts` — Fix parallel worker path
3. `packages/core/src/core/ASTWorkerPool.ts` — Pass relative file path to worker
4. `packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts` — Fix downstream coupling

**Test file:**

5. `test/unit/ClassVisitorClassNode.test.js` — Add assertion that `file` equals relative path, not basename

### Change Description

**Change 1 — `JSASTAnalyzer.ts` line 1692:**

```typescript
// BEFORE:
const scopeTracker = new ScopeTracker(basename(module.file));

// AFTER:
const scopeTracker = new ScopeTracker(module.file);
```

This is the primary fix. `module.file` is already the relative path (e.g., `packages/core/src/Orchestrator.ts`). The semantic IDs will now contain the full relative path, which is consistent with how FUNCTION node IDs are generated in `IdGenerator.generateV2Simple` (which uses `module.file` directly).

**Change 2 — `ASTWorker.ts` line 189:**

The worker receives `filePath` as the absolute path. We need to use the relative path for `ScopeTracker`. Two sub-options:
- **Option A:** Pass an additional `relativeFile` field from `ASTWorkerPool` to the worker, and use that for `ScopeTracker`.
- **Option B:** Pass `projectPath` to worker and compute `relative(projectPath, filePath)`.

Option A is cleaner. Change requires:
- `ASTWorkerPool.ts`: Add `relativeFile: m.file` to the task message sent to workers.
- `ASTWorker.ts`: Use `relativeFile` for `ScopeTracker` instead of `basename(filePath)`.

```typescript
// ASTWorker.ts - BEFORE:
const scopeTracker = new ScopeTracker(basename(filePath));

// ASTWorker.ts - AFTER:
const scopeTracker = new ScopeTracker(relativeFile);  // relativeFile passed from pool
```

**Change 3 — `TypeSystemBuilder.ts` lines 137-154:**

```typescript
// BEFORE:
const moduleBasename = basename(module.file);
const declarationMap = new Map<string, string>();
for (const decl of classDeclarations) {
  if (decl.file === moduleBasename) {
    declarationMap.set(decl.name, decl.id);
  }
}
// ...
const globalContext = { file: moduleBasename, scopePath: [] as string[] };

// AFTER:
const declarationMap = new Map<string, string>();
for (const decl of classDeclarations) {
  if (decl.file === module.file) {  // direct comparison, no basename
    declarationMap.set(decl.name, decl.id);
  }
}
// ...
const globalContext = { file: module.file, scopePath: [] as string[] };  // use relative path
```

Remove the `basename` import from `TypeSystemBuilder.ts` if it's no longer used after this change.

### Snapshot Impact

The semantic ID format for CLASS nodes will change. The `ScopeTracker` file changes from `"Orchestrator.ts"` to `"packages/core/src/Orchestrator.ts"`, so CLASS node IDs change from:
```
Orchestrator.ts->global->CLASS->Orchestrator
```
to:
```
packages/core/src/Orchestrator.ts->global->CLASS->Orchestrator
```

This matches FUNCTION node IDs which already include the full relative path. Run `UPDATE_SNAPSHOTS=true` to regenerate fixture snapshots — do not manually predict which snapshots change.

### Test Plan

**Existing test to update** (`test/unit/ClassVisitorClassNode.test.js`, line 191):

```javascript
// BEFORE (only checks truthy):
assert.ok(classNode.file, 'should have file');

// AFTER (checks that file matches relative path, not basename):
assert.ok(classNode.file, 'should have file');
assert.ok(
  classNode.file.includes('/') || classNode.file === 'index.js',
  'file should be a path (not just a basename), got: ' + classNode.file
);
```

**New test** — add to `test/unit/ClassVisitorClassNode.test.js` or create `test/unit/ClassNodeFilePath.test.js`:

```javascript
it('should store relative path in file field, not basename', async () => {
  // Create a file in a subdirectory to make basename vs path distinguishable
  const subDir = 'src';
  mkdirSync(join(testDir, subDir), { recursive: true });
  writeFileSync(join(testDir, subDir, 'Service.js'), `
class Service {}
  `);

  // ... run analysis ...

  const classNode = allNodes.find(n => n.name === 'Service' && n.type === 'CLASS');
  assert.ok(classNode, 'CLASS node not found');

  // file should be relative path from project root, not basename
  assert.strictEqual(
    classNode.file,
    'src/Service.js',
    'file should be relative path "src/Service.js", not basename "Service.js"'
  );
  assert.notStrictEqual(
    classNode.file,
    'Service.js',
    'file must NOT be basename-only'
  );
});
```

This test would have caught the bug because it distinguishes `src/Service.js` (correct) from `Service.js` (the broken behavior).

## Complexity Assessment

**Mini-MLA** — the fix is conceptually simple (remove `basename()` in two places + fix downstream coupling), but involves 4 files and has snapshot/ID-stability implications. The ASTWorker path adds a non-trivial protocol change (passing `relativeFile`). The snapshot regeneration needs validation. This warrants Don → Dijkstra (architect review for protocol change) → implementation.

Specifically, the change is not risky in logic but crosses subsystem boundaries:
- Analysis pipeline (JSASTAnalyzer)
- Worker thread communication protocol (ASTWorkerPool + ASTWorker)
- Graph building (TypeSystemBuilder)
- Node ID format (CLASS IDs will change — affects any stored data migrations)

**Estimated LOC changed:** ~15 lines across 4 files + test.
**Risk:** Medium — ID format change affects any persisted graphs (users must re-analyze). No API contract change. Snapshots will need regeneration.
