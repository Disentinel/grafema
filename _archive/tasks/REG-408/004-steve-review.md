# Steve Jobs -- REG-408 Plan Review

## Verdict: APPROVE (with conditions)

## Reasoning

This feature is non-negotiable. Without portable graphs, Grafema is a single-machine toy. You cannot run `grafema analyze` on your laptop and then `grafema context` inside a Docker container, which means every SWE-bench experiment, every CI pipeline, every multi-developer workflow is fundamentally broken. The user already proved this: agents were getting zero source code because `getCodePreview()` returned null. That is an embarrassment.

The plan is architecturally sound. Here is why I approve it.

### 1. The Core Insight Is Correct

The plan correctly identifies that `module.file` is set in ONE place (JSModuleIndexer) and then propagated downstream through all analyzers and GraphBuilder. This means the write-side change is trivial -- swap `currentFile` for `relativePath`, a variable that already exists. Everything downstream that copies `module.file` into child nodes gets relative paths for free.

The hard work is on the read side, and it is purely mechanical: wrap `readFileSync(module.file)` with `resolveNodeFile(module.file, projectPath)`. Joel catalogued every single site (~20 files). No magic, no cleverness, no new abstractions. This is exactly the kind of change that should be simple.

### 2. The `resolveNodeFile()` Backward Compatibility Is Right

The utility function is two lines:
```typescript
if (isAbsolute(nodeFile)) return nodeFile;
return join(projectPath, nodeFile);
```

This handles both legacy (absolute) and new (relative) graphs transparently. It is the CodeQL pattern. No migration tool needed, no schema versioning, no flag day. Old graphs with absolute paths keep working. New graphs store relative paths. This is exactly how you ship a breaking storage change without breaking users.

### 3. Datalog Rules Are NOT Broken

I checked the codebase. The Datalog rules that use `attr(N, "file", X)` are purely for extracting the file field value to bind it to a variable. Example:
```
large_iteration(Loop, Var, File) :- ... attr(Loop, "file", File).
```

This binds whatever string is in the `file` field to `File`. Whether that string is `/Users/vadimr/project/src/auth.ts` or `src/auth.ts`, the rule works identically. The file value is used as an output label, not as a filesystem path inside Datalog. No breakage.

### 4. The Worker Thread Solution Is Correct

The plan identified the subtle problem: ASTWorker receives `filePath` (absolute) and stamps it onto every collection item (`file: filePath`). These collection items flow into GraphBuilder, which uses them for filtering (`v.file === loop.file`).

The proposed fix (Option A -- normalize collection file fields to relative after receiving from worker, before passing to GraphBuilder) is the right call. It keeps the worker protocol unchanged, concentrates the fix in one place, and all the internal comparisons in GraphBuilder (`v.file === loop.file`) continue to work because both sides are now relative. The alternative (Option B, changing the worker protocol) would be more invasive for zero benefit.

### 5. The queryNodes({ file }) Pattern Is Self-Consistent

After migration, ALL nodes store relative paths. All queries by file pass relative paths. RFDB file index is a string-exact-match index. As long as both stored and queried values use the same format (both relative), matching is preserved. This is verified by inspection: `FileNodeManager.clearFileNodesIfNeeded(file)` is called with `module.file` (now relative), and the graph stores `file` (now relative). Match.

### 6. Legacy Node IDs Will Shift -- Acceptable

Legacy IDs like `LITERAL#42:100#/Users/vadimr/project/src/auth.ts` will become `LITERAL#42:100#src/auth.ts`. This is a one-time identity break that forces full re-analysis. For v0.1.x alpha software, requiring `grafema analyze --force` once after upgrade is completely acceptable. The newer semantic ID system (`src/auth.ts->global->FUNCTION->authenticate`) is already relative and unaffected.

### 7. GRAPH_META Node Is the Right Approach

Storing projectPath in a special node inside the graph is pragmatic. No RFDB protocol changes, no sidecar files, no new infrastructure. The data travels with the graph on flush/load. It is extensible for future metadata (version, build timestamp, analysis options). The RFDB storage layer does not validate node types, so `GRAPH_META` will work without Rust changes.

## Concerns

### Concern 1: GRAPH_META Is Step 8 But Should Be Step 1 or 2

The plan orders GRAPH_META as Step 8 (independent, can run in parallel). This is wrong in priority, even if correct in dependency terms.

The GRAPH_META node is what makes the graph truly portable. Without it, a graph file shipped to another machine has no way to know its original projectPath. The user must manually provide it via CLI flags or env vars. That defeats half the purpose of portable graphs.

GRAPH_META must be implemented alongside the core change, not as a "nice-to-have" afterthought. Joel even admits: "For V1 of this feature, we can require projectPath to be explicitly provided." No. If we are making graphs portable, the graph must carry its own metadata. Otherwise we are shipping half a feature.

**Resolution:** GRAPH_META must be implemented in the same PR, not deferred.

### Concern 2: GraphBuilder Uses BOTH `module.file` AND Collection Item `.file`

Joel's plan correctly handles this for imports/exports (GraphBuilder uses `module.file` directly at lines 1224, 1267, 1321, etc.) -- these will be relative because `module.file` is relative.

But GraphBuilder also uses `.file` from collection items (e.g., `loop.file`, `constructorCall.file`, `branch.file`). These come from the worker which stamps them with absolute `filePath`. The plan's Option A (normalize collections after receiving from worker) handles this.

However, I want to flag that the normalization in Option A must be exhaustive. Joel's example only shows `functions`, `parameters`, `variableDeclarations`, `callSites`, `methodCalls`. But `ASTCollections` also has: `scopes`, `eventListeners`, `classInstantiations`, `classDeclarations`, `methodCallbacks`, `callArguments`, `imports`, `exports`, `httpRequests`, `literals`, `variableAssignments`. ALL of these have `file` fields set by the worker. ALL must be normalized.

**Resolution:** The implementation must normalize ALL collection types, not just the 5 listed in the example. A for-of loop over `Object.values(collections)` would be more robust than listing each one individually.

### Concern 3: `relative()` Behavior With Already-Relative Paths

Joel correctly identifies the danger: `relative('/project', 'src/auth.ts')` produces `../../src/auth.ts` on POSIX, not `src/auth.ts`. Every `relative(projectPath, node.file)` call in the CLI would produce garbage output if not guarded.

The plan handles this with `isAbsolute()` checks. But there are 13+ call sites in the CLI alone that do `relative(projectPath, node.file)`. Missing even ONE means a broken path display.

**Resolution:** The `toRelativeDisplay()` helper must be used everywhere. Do not trust ad-hoc fixes at each call site. Extract the utility, grep for all `relative(projectPath` calls, replace mechanically. Every single one.

### Concern 4: ExpressAnalyzer projectRoot Derivation

Joel correctly spots the broken derivation at lines 400-407:
```typescript
const moduleAbsPath = module.file!;
const moduleRelPath = module.name!;
const projectRoot = moduleAbsPath.endsWith(moduleRelPath)
  ? moduleAbsPath.slice(0, moduleAbsPath.length - moduleRelPath.length)
  : dirname(moduleAbsPath);
```

After REG-408, `module.file === module.name` (both relative). The slice would produce empty string. The fallback `dirname(moduleAbsPath)` would produce `src` (dirname of `src/routes/auth.ts`). Both wrong.

The fix (`const projectRoot = projectPath`) is correct and simpler. Good.

## Conditions (for implementation)

1. **GRAPH_META must ship in the same PR.** No deferring. The graph must carry its own projectPath. Query tools should read it as a fallback when no explicit projectPath is provided.

2. **Collection normalization must be exhaustive.** Use a generic approach (loop over all collections) rather than listing individual fields. If a new collection type is added later, it should be normalized automatically.

3. **`toRelativeDisplay()` must replace ALL `relative(projectPath, node.file)` calls.** Use grep to verify zero remaining instances of the old pattern after implementation. This is the highest risk area for regression.

4. **Test the actual portable graph scenario end-to-end.** Analyze a project at path A, copy `.grafema/` to path B, run `grafema context` at path B. Source code must appear. This is the acceptance test that matters, not just unit tests.

5. **The `resolveNodeFile()` utility must be the ONLY way file paths are resolved from nodes.** No ad-hoc `isAbsolute()` + `join()` in random places. One utility, one import, one pattern. If someone later adds a new analyzer, they import `resolveNodeFile` and the pattern is obvious.

6. **Legacy ID shift must be documented in the commit message.** This is a known breaking change for incremental analysis. Users need to know they must run `--force` once.
