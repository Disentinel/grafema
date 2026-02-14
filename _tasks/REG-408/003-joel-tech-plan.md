# Joel Spolsky — REG-408 Tech Plan: Portable Graphs (Relative Paths)

## Overview

This plan converts Grafema from storing absolute file paths (`/Users/vadimr/project/src/auth.ts`) to relative paths (`src/auth.ts`) in all graph nodes. The graph becomes portable: build on one machine, query on another.

**Total estimated scope:** ~300 lines changed across ~25 files, plus ~40 lines for new utility + ~20 lines for graph metadata storage.

**Breaking change:** Existing graphs require `grafema analyze --force` after upgrade. This is acceptable for v0.1.x.

---

## Dependency Graph

```
Step 1 (utility) ──────────────────────┐
                                        ├── Step 3 (analyzers)
Step 2 (write point: indexers) ────────┤
                                        ├── Step 4 (freshness/incremental)
                                        ├── Step 5 (display layer)
                                        ├── Step 6 (MCP)
                                        └── Step 7 (VSCode)

Step 8 (graph metadata) ── independent, can run in parallel with Steps 1-7
```

Steps 1 and 2 are sequential (utility must exist before write points change).
Steps 3-7 can be parallelized after Step 2 is complete.
Step 8 is independent.

---

## Step 1: Create `resolveNodeFile()` Utility

**Goal:** Single utility function that resolves a node's `file` field to an absolute path. Handles both legacy (absolute) and new (relative) paths for backward compatibility.

**File:** `packages/core/src/utils/resolveNodeFile.ts` (NEW)

**Code:**

```typescript
/**
 * Resolve a node's file path to an absolute path.
 *
 * Handles both legacy absolute paths and new relative paths.
 * After REG-408, node.file stores paths relative to projectPath.
 * This utility resolves them back to absolute for file system access.
 *
 * @param nodeFile - The file field from a graph node (relative or absolute)
 * @param projectPath - The absolute project root path
 * @returns Absolute file path
 */

import { isAbsolute, join } from 'path';

export function resolveNodeFile(nodeFile: string, projectPath: string): string {
  if (isAbsolute(nodeFile)) return nodeFile;  // Legacy absolute path
  return join(projectPath, nodeFile);
}
```

**Big-O:** O(1) per call. `isAbsolute` is a single character check. `join` is string concatenation.

**Test strategy:**
- Unit test in `test/unit/utils/resolveNodeFile.test.ts`
- Test cases:
  1. Relative path + projectPath => absolute
  2. Already absolute path => returned unchanged
  3. Empty projectPath => relative returned as-is (graceful degradation)
  4. Windows-style paths if applicable (future-proofing)

**Also export from core barrel file:**
- **File:** `packages/core/src/utils/index.ts` or wherever utilities are exported
- Add `export { resolveNodeFile } from './resolveNodeFile.js';`

---

## Step 2: Change Primary Write Points to Store Relative Paths

**Goal:** The ONE fundamental change: MODULE nodes store relative paths instead of absolute.

### Step 2a: JSModuleIndexer (Primary Indexer)

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`
**Line:** 376

**Before:**
```typescript
const moduleNode = {
  id: semanticId,
  type: 'MODULE' as const,
  name: relativePath,
  file: currentFile, // Keep absolute path for file reading in analyzers
  line: 0,
  contentHash: fileHash || '',
  isTest
};
```

**After:**
```typescript
const moduleNode = {
  id: semanticId,
  type: 'MODULE' as const,
  name: relativePath,
  file: relativePath, // REG-408: Store relative path for portable graphs
  line: 0,
  contentHash: fileHash || '',
  isTest
};
```

**Explanation:** `relativePath` is already computed on line 365-367 (it's the path relative to `projectPath`, with optional `rootPrefix`). We simply use it for `file` as well. Zero additional computation.

**Big-O:** O(0) additional work. We're replacing one variable reference with another already-computed one.

### Step 2b: IncrementalModuleIndexer (Secondary Indexer)

**File:** `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts`
**Line:** 185

**Before:**
```typescript
const moduleNode: NodeRecord = {
  id: semanticId,
  type: 'MODULE',
  name: relativePath,
  file: file,
  contentHash: fileHash
} as unknown as NodeRecord;
```

**After:**
```typescript
const moduleNode: NodeRecord = {
  id: semanticId,
  type: 'MODULE',
  name: relativePath,
  file: relativePath, // REG-408: Store relative path for portable graphs
  contentHash: fileHash
} as unknown as NodeRecord;
```

### Step 2c: NodeFactory.createModule (Legacy API)

**File:** `packages/core/src/core/NodeFactory.ts`
**Line:** 264

**Before:**
```typescript
return brandNode(ModuleNode.create(filePath, relativePath, contentHash, options));
```

The `ModuleNode.create` signature takes `(file, name, contentHash, options)`. Currently `file` receives absolute `filePath`.

**After:**
```typescript
return brandNode(ModuleNode.create(relativePath, relativePath, contentHash, options));
```

**Note:** This is marked as `LEGACY` in the codebase. The change is simple: pass `relativePath` (which is already computed on line 262) as the `file` parameter too.

### Step 2d: IncrementalReanalyzer Module Re-creation

**File:** `packages/core/src/core/IncrementalReanalyzer.ts`
**Line:** ~93 (where it re-creates MODULE nodes for modified files)

Check how it constructs MODULE nodes after clearing stale ones. The `module.file` from `StaleModule` will be relative (from graph) after migration. The `relativePath` is already computed on line 93 as `relative(this.projectPath, module.file)`.

**Critical insight:** After migration, `module.file` is already relative. So `relative(this.projectPath, module.file)` would produce an incorrect double-relative path. This needs to be:

**Before:**
```typescript
const relativePath = relative(this.projectPath, module.file);
```

**After:**
```typescript
// module.file is already relative after REG-408
// Use resolveNodeFile for backward compatibility with pre-migration graphs
const absoluteFile = resolveNodeFile(module.file, this.projectPath);
const relativePath = relative(this.projectPath, absoluteFile);
```

This handles both legacy (absolute) and new (relative) paths correctly:
- New graph: `resolveNodeFile('src/auth.ts', '/project')` => `/project/src/auth.ts` => `relative()` => `src/auth.ts`
- Legacy graph: `resolveNodeFile('/project/src/auth.ts', '/project')` => `/project/src/auth.ts` => `relative()` => `src/auth.ts`

**Big-O:** O(1) per module node. One extra `isAbsolute()` + `join()` call.

**Test strategy for Step 2:**
- Integration test: Create a graph with JSModuleIndexer, verify MODULE nodes have relative `file` values
- Verify `module.name === module.file` (they should now be identical)
- Verify semantic IDs are unchanged (they were already relative-path-based)

---

## Step 3: Fix Analysis Pipeline (File Reading)

**Goal:** All analyzers that do `readFileSync(module.file!)` must now resolve to absolute first.

**Pattern:** Every `readFileSync(module.file!)` becomes `readFileSync(resolveNodeFile(module.file!, projectPath))`.

### Step 3a: JSASTAnalyzer

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Changes (4 sites):**

1. **Line 319** — `calculateFileHash(module.file)`:
```typescript
// Before
const currentHash = this.calculateFileHash(module.file);
// After
const currentHash = this.calculateFileHash(resolveNodeFile(module.file, projectPath));
```
Note: `projectPath` is already available at this point (line 351: `const projectPath = manifest?.projectPath ?? '';`). However, `shouldAnalyzeModule` is called before `projectPath` is destructured. We need to pass `projectPath` into `shouldAnalyzeModule`.

**Current signature (line 310):**
```typescript
async shouldAnalyzeModule(module: ModuleNode, graph: GraphBackend, forceAnalysis: boolean): Promise<boolean>
```

**New signature:**
```typescript
async shouldAnalyzeModule(module: ModuleNode, graph: GraphBackend, forceAnalysis: boolean, projectPath: string): Promise<boolean>
```

2. **Line 337** — `queryNodes({ type: 'FUNCTION', file: module.file })`:
```typescript
// Before
for await (const _node of graph.queryNodes({ type: 'FUNCTION', file: module.file })) {
// After (module.file is now relative, and nodes also store relative — so this is CORRECT as-is)
// NO CHANGE NEEDED: query matches stored format
```

**Critical insight:** Since ALL nodes now store relative paths, `queryNodes({ file: module.file })` will match correctly because `module.file` is relative and stored `file` fields are also relative. **No change needed for query-by-file patterns.**

3. **Line 1420** — `readFileSync(module.file, 'utf-8')`:
```typescript
// Before
const code = readFileSync(module.file, 'utf-8');
// After
const code = readFileSync(resolveNodeFile(module.file, projectPath), 'utf-8');
```
`projectPath` is passed to `analyzeModule()` (line 1414 signature already has it).

4. **Line 1432** — `basename(module.file)`:
```typescript
// Before
const scopeTracker = new ScopeTracker(basename(module.file));
// After — basename works correctly with relative paths
// basename('src/auth.ts') === 'auth.ts' ✓
// NO CHANGE NEEDED
```

5. **Lines 502-506** — `executeParallel` passes `m.file` to ASTWorkerPool:
```typescript
// Before
const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
  id: m.id,
  file: m.file,  // <-- Now relative
  name: m.name
}));
// After: Must resolve to absolute for worker threads (they need to readFileSync)
const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
  id: m.id,
  file: resolveNodeFile(m.file, projectPath),  // Workers need absolute path to read files
  name: m.name
}));
```

**Critical:** ASTWorker runs in `worker_threads` and calls `readFileSync(filePath)` directly (line 178 of ASTWorker.ts). It has NO access to `projectPath`. The fix is to resolve the path BEFORE sending to the worker. The worker continues to receive absolute paths and works unchanged.

6. **Line 549** — Progress message display:
```typescript
// Before
message: `Processed ${result.module.file.replace(projectPath, '')}`,
// After — module.file is already relative (but moduleInfos has absolute from step above)
// Since we resolved moduleInfos.file to absolute, the replace still works.
// However, cleaner approach:
message: `Processed ${result.module.name}`,  // name is always relative
```

**Import to add at top:**
```typescript
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
```

### Step 3b: All Other Analyzers (Mechanical Pattern)

Each analyzer follows the exact same pattern: add import, wrap `readFileSync` call.

**Every analyzer below needs:**
1. Import: `import { resolveNodeFile } from '../../utils/resolveNodeFile.js';`
2. Resolve `projectPath` from manifest: already done in `execute()` method
3. Wrap: `readFileSync(module.file!, ...)` => `readFileSync(resolveNodeFile(module.file!, projectPath), ...)`

| # | File | Line | Change |
|---|------|------|--------|
| 1 | `ExpressAnalyzer.ts` | 151 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 2 | `ExpressAnalyzer.ts` | 391 | `dirname(resolveNodeFile(module.file!, projectPath))` — for module resolution |
| 3 | `ExpressRouteAnalyzer.ts` | 143 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 4 | `ExpressResponseAnalyzer.ts` | 129 | `readFileSync(resolveNodeFile(handlerNode.file, projectPath))` |
| 5 | `FetchAnalyzer.ts` | 152 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 6 | `SocketIOAnalyzer.ts` | 271 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 7 | `DatabaseAnalyzer.ts` | 142 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 8 | `SQLiteAnalyzer.ts` | 108 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 9 | `RustAnalyzer.ts` | 233 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 10 | `ServiceLayerAnalyzer.ts` | 169 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 11 | `ReactAnalyzer.ts` | 291 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |
| 12 | `SystemDbAnalyzer.ts` | 83 | `readFileSync(resolveNodeFile(module.file!, projectPath))` |

**projectPath availability check per analyzer:**

Each analyzer extends `Plugin` and has `execute(context: PluginContext)`. The context contains `manifest.projectPath`. I need to verify each analyzer extracts projectPath from context.

Searching the codebase confirms: all analyzers get `projectPath` from `context.manifest?.projectPath`. For analyzers whose `analyzeModule()` doesn't currently receive `projectPath`, it needs to be threaded through.

**Specific concern — ExpressAnalyzer line 391:**
```typescript
// Before
const currentDir = dirname(module.file!);
targetModulePath = resolve(currentDir, imp.source);
// After
const currentDir = dirname(resolveNodeFile(module.file!, projectPath));
targetModulePath = resolve(currentDir, imp.source);
```
This is a critical path — it uses `module.file` as a filesystem base to resolve import paths. Must be absolute.

**Specific concern — ExpressAnalyzer lines 400-407 (projectRoot derivation):**
```typescript
// Before
const moduleAbsPath = module.file!;
const moduleRelPath = module.name!;
const projectRoot = moduleAbsPath.endsWith(moduleRelPath)
  ? moduleAbsPath.slice(0, moduleAbsPath.length - moduleRelPath.length)
  : dirname(moduleAbsPath);
```

After REG-408, `module.file === module.name` (both relative). This derivation breaks. Fix:
```typescript
// After — projectPath is available in the analyzer
const projectRoot = projectPath;  // No derivation needed, it's passed in context
```

**Specific concern — ExpressResponseAnalyzer line 129:**
This reads `handlerNode.file`, not `module.file`. The `handlerNode` is loaded from the graph via `graph.getNode()`. Its `file` field will be relative. Need to resolve:
```typescript
const code = readFileSync(resolveNodeFile(handlerNode.file, projectPath), 'utf-8');
```

**How does this analyzer get projectPath?** Check its `execute()` signature and context access. It receives `PluginContext` which has `manifest.projectPath`.

### Step 3c: PrefixEvaluator (Enrichment Phase)

**File:** `packages/core/src/plugins/enrichment/PrefixEvaluator.ts`
**Line:** 145

```typescript
// Before
const code = readFileSync(module.file, 'utf-8');
// After
const code = readFileSync(resolveNodeFile(module.file, projectPath), 'utf-8');
```

Need to verify `projectPath` is available in this enricher's scope.

### Step 3d: ASTWorker (Worker Threads) — NO CHANGE NEEDED

**File:** `packages/core/src/core/ASTWorker.ts`

The worker receives `filePath` as a message parameter (line 38). In Step 3a we ensured that `JSASTAnalyzer.executeParallel()` resolves the path to absolute BEFORE sending it to the worker. The worker itself continues to operate on absolute paths and needs NO modification.

The worker also sets `file: filePath` on various node collections (lines 242, 359, 395, 417, 465, 499, 529). These `file` fields need to be relative in the final graph.

**Solution:** The `GraphBuilder.build()` already receives `module` (which has `module.file` = relative). The GraphBuilder uses `module.file` when creating nodes — it does NOT use the worker's `filePath`. Let me verify...

Looking at `GraphBuilder.build()` at line 132: it receives `module: ModuleNode` and `data: ASTCollections`. The worker's collections set `file: filePath` (absolute). But does GraphBuilder use `data.*.file` or `module.file`?

Looking at GraphBuilder code — it accesses `module.file` for some operations (e.g., `basename(module.file)` at line 1165). For node creation, it uses data from the collections directly. The collections from workers contain absolute `filePath` in their `file` fields.

**This is a problem.** Worker-created collection items have `file: absolutePath`. When GraphBuilder writes these to the graph, the nodes will have absolute `file` fields.

**Fix: Two options:**

**Option A (preferred):** In `JSASTAnalyzer.executeParallel()`, after receiving collections from the worker, rewrite all `file` fields to relative before passing to GraphBuilder.

```typescript
// After receiving collections, normalize file paths to relative
const relativeFile = module.file; // already relative after Step 2
for (const fn of collections.functions) fn.file = relativeFile;
for (const param of collections.parameters) param.file = relativeFile;
for (const varDecl of collections.variableDeclarations) varDecl.file = relativeFile;
for (const call of collections.callSites) call.file = relativeFile;
for (const mc of collections.methodCalls) mc.file = relativeFile;
```

This is O(n) where n = items in a single file's collections (typically 10-200 items). This is already happening per-file, so no additional iteration cost in the pipeline.

**Option B:** Pass relative path to the worker and have it use that for `file` fields, while using the separate absolute path for `readFileSync`. This requires changing the worker message protocol. More invasive.

**Decision: Option A.** Simpler, fewer files changed, no worker protocol changes.

**Big-O for Step 3:** O(1) per `readFileSync` call (one extra `isAbsolute()` + `join()`). Total O(n) where n = number of modules analyzed — but this is already the cost of analysis.

**Test strategy for Step 3:**
- Integration test: Analyze a small project, verify ALL node types have relative `file` fields
- Verify `readFileSync` calls succeed (files are actually readable)
- Verify ExpressAnalyzer import resolution works with relative paths
- Verify worker thread parallel path still produces correct results

---

## Step 4: Fix Freshness & Incremental Reanalysis

### Step 4a: GraphFreshnessChecker

**File:** `packages/core/src/core/GraphFreshnessChecker.ts`

**Problem:** `checkFreshness()` reads `module.file` to check if files exist and compute hashes. With relative paths, it needs to resolve them to absolute.

**Current:** No `projectPath` parameter.

**Solution:** Add `projectPath` parameter to `checkFreshness()`.

**Before (line 42):**
```typescript
async checkFreshness(graph: FreshnessGraph): Promise<FreshnessResult> {
```

**After:**
```typescript
async checkFreshness(graph: FreshnessGraph, projectPath: string): Promise<FreshnessResult> {
```

**Line 100 — `_checkModuleFreshness`:**

**Before:**
```typescript
private async _checkModuleFreshness(module: ModuleInfo): Promise<StaleModule | null> {
  const exists = await this._fileExists(module.file);
```

**After:**
```typescript
private async _checkModuleFreshness(module: ModuleInfo, projectPath: string): Promise<StaleModule | null> {
  const absoluteFile = resolveNodeFile(module.file, projectPath);
  const exists = await this._fileExists(absoluteFile);
  // ...use absoluteFile for calculateFileHashAsync too (line 111)
```

**Line 74 — caller:**
```typescript
// Before
batch.map(module => this._checkModuleFreshness(module))
// After
batch.map(module => this._checkModuleFreshness(module, projectPath))
```

**Callers of `checkFreshness()`** need to pass `projectPath`:
- CLI `check` command
- MCP handlers
- Any other places that call this

**Big-O:** O(1) additional per module check (one `isAbsolute` + `join`).

### Step 4b: FileNodeManager

**File:** `packages/core/src/core/FileNodeManager.ts`

**Line 51** — `graph.queryNodes({ file })`:

After migration, the `file` parameter passed to `clearFileNodesIfNeeded` must be the RELATIVE path (matching what's stored in the graph).

**Current callers:**
- `IncrementalReanalyzer.ts:84` — passes `module.file` which will be relative after migration. **OK, no change needed.**

The function's docstring says "@param file - Absolute file path" — update to "@param file - File path (relative to project root)".

**Big-O:** No change.

### Step 4c: IncrementalReanalyzer

**File:** `packages/core/src/core/IncrementalReanalyzer.ts`

The reanalyzer uses `staleModules` from GraphFreshnessChecker. After migration, `module.file` in stale modules is relative.

**Line 84** — `clearFileNodesIfNeeded(this.graph, module.file, touchedFiles)`:
The `module.file` is relative after migration. `clearFileNodesIfNeeded` queries `graph.queryNodes({ file })` which matches the stored relative format. **No change needed.**

**Line 93** — `const relativePath = relative(this.projectPath, module.file)`:
After migration, `module.file` is already relative. `relative('/project', 'src/auth.ts')` would produce something like `../../src/auth.ts` — **WRONG**.

**Fix:**
```typescript
// Before
const relativePath = relative(this.projectPath, module.file);
// After — module.file is already relative after REG-408
// Use resolveNodeFile for backward compat, then re-compute relative
const absoluteFile = resolveNodeFile(module.file, this.projectPath);
const relativePath = relative(this.projectPath, absoluteFile);
```

This handles both:
- Post-migration: `resolveNodeFile('src/auth.ts', '/project')` => `/project/src/auth.ts` => `relative()` => `src/auth.ts`
- Pre-migration: `resolveNodeFile('/project/src/auth.ts', '/project')` => `/project/src/auth.ts` => `relative()` => `src/auth.ts`

**Test strategy for Step 4:**
- Unit test: GraphFreshnessChecker with relative paths in MODULE nodes
- Verify stale detection works (file changed, file deleted)
- Verify IncrementalReanalyzer re-creates MODULE nodes with relative paths

---

## Step 5: Fix CLI Display Layer

**Goal:** CLI commands that do `relative(projectPath, node.file)` should handle relative paths gracefully.

### Step 5a: formatLocation()

**File:** `packages/cli/src/utils/formatNode.ts`
**Line:** 126

**Before:**
```typescript
export function formatLocation(file: string | undefined, line: number | undefined, projectPath: string): string {
  if (!file) return '';
  const relPath = relative(projectPath, file);
  return line ? `${relPath}:${line}` : relPath;
}
```

**After:**
```typescript
export function formatLocation(file: string | undefined, line: number | undefined, projectPath: string): string {
  if (!file) return '';
  // After REG-408, file may already be relative. relative() on a relative path
  // returns the path unchanged if it doesn't start with the base, so this is safe.
  // But for clarity, use isAbsolute check:
  const relPath = isAbsolute(file) ? relative(projectPath, file) : file;
  return line ? `${relPath}:${line}` : relPath;
}
```

Add import: `import { relative, isAbsolute } from 'path';`

**Behavior analysis:** `relative('/project', 'src/auth.ts')` returns `'../../src/auth.ts'` on POSIX (treats second arg as relative to CWD, not to first arg). So we MUST fix this.

**Big-O:** O(1) — one `isAbsolute()` check.

### Step 5b: DisplayableNode Interface

**File:** `packages/cli/src/utils/formatNode.ts`
**Line:** 33

Update the JSDoc comment:
```typescript
/** Source file path (relative to project root, or absolute for legacy graphs) */
file: string;
```

### Step 5c: getCodePreview()

**File:** `packages/cli/src/utils/codePreview.ts`
**Line:** 30

This function receives `file` and does `existsSync(file)` + `readFileSync(file)`. After migration, `file` is relative and won't resolve correctly.

**Callers must resolve path before calling.** Check callers:
- CLI `explore` command
- CLI `context` command

**Option A:** Change callers to pass resolved absolute path.
**Option B:** Add `projectPath` parameter to `getCodePreview`.

**Decision: Option B** — add optional `projectPath` parameter for self-contained resolution.

**Before:**
```typescript
export function getCodePreview(options: CodePreviewOptions): CodePreviewResult | null {
  const { file, line, contextBefore = 2, contextAfter = 12 } = options;
  if (!existsSync(file)) { return null; }
  // ...
```

**After:**
```typescript
export interface CodePreviewOptions {
  file: string;
  line: number;
  projectPath?: string;  // REG-408: resolve relative paths
  contextBefore?: number;
  contextAfter?: number;
}

export function getCodePreview(options: CodePreviewOptions): CodePreviewResult | null {
  const { file, line, projectPath, contextBefore = 2, contextAfter = 12 } = options;
  const absoluteFile = projectPath ? resolveNodeFile(file, projectPath) : file;
  if (!existsSync(absoluteFile)) { return null; }
  const content = readFileSync(absoluteFile, 'utf-8');
  // ...
```

### Step 5d: CLI Commands — `relative()` Calls

Multiple CLI commands do `relative(projectPath, node.file)`. After migration, this needs the same treatment as `formatLocation()`.

| File | Line | Current | Fix |
|------|------|---------|-----|
| `commands/query.ts` | 834, 859 | `relative(projectPath, node.file)` | `isAbsolute(node.file) ? relative(projectPath, node.file) : node.file` |
| `commands/ls.ts` | 145 | `relative(projectPath, node.file)` | Same pattern |
| `commands/context.ts` | 241, 305 | `formatLocation(...)` | Fixed by Step 5a |
| `commands/explain.ts` | 169 | `relative(projectPath, node.file)` | Same pattern |
| `commands/schema.ts` | 85 | `relative(projectPath, schema.source.file)` | Same pattern |
| `commands/check.ts` | 245, 392, 492 | Direct display | Review if paths are displayed |
| `commands/trace.ts` | 750 | `src.file.startsWith(projectPath) ? ...` | `isAbsolute(src.file) ? ... : src.file` |
| `commands/explore.tsx` | 424 | `relative(projectPath, node.file)` | Same pattern |

**Helper suggestion:** Extract a utility used across CLI:

```typescript
// packages/cli/src/utils/pathUtils.ts
import { relative, isAbsolute } from 'path';

export function toRelativeDisplay(file: string, projectPath: string): string {
  return isAbsolute(file) ? relative(projectPath, file) : file;
}
```

Then replace all `relative(projectPath, node.file)` with `toRelativeDisplay(node.file, projectPath)`.

**Big-O:** O(1) per call.

### Step 5e: GuaranteeManager

**File:** `packages/core/src/core/GuaranteeManager.ts`
**Line:** 537

**Before:**
```typescript
const relativePath = module.file?.replace(this.projectPath, '').replace(/^\//, '') || '';
```

**After:**
```typescript
// module.file is already relative after REG-408
const relativePath = module.file && isAbsolute(module.file)
  ? module.file.replace(this.projectPath, '').replace(/^\//, '')
  : (module.file || '');
```

Or simpler:
```typescript
const relativePath = module.file
  ? (isAbsolute(module.file) ? relative(this.projectPath, module.file) : module.file)
  : '';
```

**Big-O:** O(1).

**Test strategy for Step 5:**
- Verify `formatLocation` returns correct relative paths for both relative and absolute inputs
- Verify all CLI commands display paths correctly
- Verify `getCodePreview` reads files when given relative path + projectPath

---

## Step 6: Fix MCP Handlers

**File:** `packages/mcp/src/handlers.ts`

### Step 6a: Source Code Reading (Lines 1163-1178)

**Before:**
```typescript
if (existsSync(node.file)) {
  const content = readFileSync(node.file, 'utf-8');
```

**After:**
```typescript
const absoluteFile = resolveNodeFile(node.file, projectPath);
if (existsSync(absoluteFile)) {
  const content = readFileSync(absoluteFile, 'utf-8');
```

`projectPath` is already available via `getProjectPath()` (line 1161).

### Step 6b: Connected Node Code Context (Lines 1253-1256)

**Before:**
```typescript
if (existsSync(connNode.file)) {
  const content = readFileSync(connNode.file, 'utf-8');
```

**After:**
```typescript
const connAbsFile = resolveNodeFile(connNode.file, projectPath);
if (existsSync(connAbsFile)) {
  const content = readFileSync(connAbsFile, 'utf-8');
```

### Step 6c: Display Paths (Lines 1212, 1247)

**Before:**
```typescript
const relFile = node.file ? relative(projectPath, node.file) : undefined;
// ...
const nFile = connNode.file ? relative(projectPath, connNode.file) : '';
```

**After:**
```typescript
const relFile = node.file ? (isAbsolute(node.file) ? relative(projectPath, node.file) : node.file) : undefined;
// ...
const nFile = connNode.file ? (isAbsolute(connNode.file) ? relative(projectPath, connNode.file) : connNode.file) : '';
```

Or use the same `toRelativeDisplay` pattern from Step 5d.

### Step 6d: Other MCP display paths (Lines 669, 975, 1025, 1067, 1075, 1096)

Review each and apply same pattern where `node.file` is displayed. Many of these just display the file directly (no `relative()` call), which means after migration they'll display relative paths automatically. **Likely no change needed for direct display.**

**Import to add:**
```typescript
import { resolveNodeFile } from '@grafema/core/utils/resolveNodeFile.js';
// or inline the simple logic
```

**Big-O:** O(1) per handler invocation.

**Test strategy for Step 6:**
- MCP integration test: verify `get_context` handler returns source code
- Verify file paths in MCP responses are relative (not absolute)

---

## Step 7: Fix VSCode Extension

**File:** `packages/vscode/src/extension.ts`

### Step 7a: URI Construction

**Lines 84, 361, 374, 416** — `vscode.Uri.file(file)`

After migration, `node.file` is relative. VSCode needs absolute URIs.

**Fix:** Resolve using workspace root:

```typescript
// Before
const uri = vscode.Uri.file(file);
// After
const absoluteFile = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
const uri = vscode.Uri.file(absoluteFile);
```

Where `workspaceRoot` comes from `vscode.workspace.workspaceFolders[0].uri.fsPath`.

### Step 7b: edgesProvider.ts

**Lines 181, 216, 385** — Similar pattern, resolve relative to workspace root.

**Big-O:** O(1) per node display.

**Test strategy for Step 7:**
- Manual test: Open a project in VSCode, verify "Go to Definition" works via edges
- Verify file URIs resolve correctly

---

## Step 8: Store projectPath in Graph Metadata

**Goal:** The graph must know which projectPath it was built with, so query tools can resolve relative paths without external configuration.

### Step 8a: Design Decision — Where to Store

There is no existing metadata/key-value store in RFDB. Options:

1. **Special GRAPH_META node** — Store as a node with `type: 'GRAPH_META'`, `id: '__graph_meta__'`
2. **RFDB server command** — Add `SetMetadata`/`GetMetadata` commands (requires Rust changes)
3. **Filesystem sidecar** — Store as `.grafema/graph.meta.json`

**Decision: Option 1 (GRAPH_META node).** Reasons:
- No RFDB protocol changes needed
- Travels with the graph (flush/load)
- Query-able like any other node
- Can be extended with more metadata later (version, build timestamp, etc.)

### Step 8b: Store During Analysis

**File:** `packages/core/src/Orchestrator.ts` (or wherever analysis completes)

After indexing, before analysis, store the metadata node:

```typescript
await graph.addNode({
  id: '__graph_meta__',
  type: 'GRAPH_META',
  name: 'graph_metadata',
  file: '',
  projectPath: absoluteProjectPath,
  grafemaVersion: packageVersion,
  analyzedAt: new Date().toISOString()
});
```

**Note:** `projectPath` here is stored as metadata on the node, not in the `file` field. The `file` field can be empty string.

### Step 8c: Read During Query

**File:** `packages/mcp/src/state.ts` and `packages/cli/src/commands/*.ts`

When opening a graph for querying, if no explicit `projectPath` is provided, read it from the GRAPH_META node:

```typescript
const metaNode = await graph.getNode('__graph_meta__');
const storedProjectPath = metaNode?.projectPath as string | undefined;
// Use storedProjectPath as fallback if not provided by CLI/MCP args
```

This is a **nice-to-have** for portability. For V1 of this feature, we can require `projectPath` to be explicitly provided (it already is in all current entry points). The GRAPH_META node becomes useful when:
- Opening a graph on a different machine
- CI environments where the project might be at a different path

### Step 8d: Handle Missing GRAPH_META (Backward Compat)

Older graphs won't have this node. Query tools should fall back to the current `projectPath` resolution (from CLI args, env vars, or current directory).

**Big-O:** O(1) — single node write, single node read.

**Test strategy for Step 8:**
- Unit test: Store GRAPH_META, retrieve, verify projectPath
- Verify analysis completes with GRAPH_META node in graph

---

## Step 9: Verification & Migration Guide

### Step 9a: Full Test Suite

After all steps are complete, run the full test suite:
```bash
npm test
```

### Step 9b: End-to-End Test

1. Analyze a project: `grafema analyze --force`
2. Verify all MODULE nodes have relative `file` fields: `grafema query 'MODULE' --limit 5`
3. Verify all child nodes have relative `file` fields
4. Verify `grafema check` still detects stale files
5. Verify MCP `get_context` returns source code
6. Verify CLI `explain` shows correct paths

### Step 9c: Migration Documentation

Add to CHANGELOG or release notes:
```
## Breaking Change: Portable Graphs (REG-408)

Graph nodes now store relative file paths instead of absolute paths.
This makes graphs portable across machines and CI environments.

**Migration:** Run `grafema analyze --force` once after upgrading.
Existing graphs with absolute paths are detected and handled automatically.
```

---

## Summary Table

| Step | Files Changed | Lines Changed | Big-O Impact | Can Parallelize |
|------|--------------|---------------|--------------|-----------------|
| 1. Utility | 1 new + 1 export | ~15 | O(0) | — |
| 2. Write points | 4 files | ~20 | O(0) | After Step 1 |
| 3. Analyzers | ~14 files | ~80 | O(1)/call | After Step 2 |
| 4. Freshness | 3 files | ~30 | O(1)/module | After Step 2 |
| 5. CLI display | ~10 files | ~60 | O(1)/call | After Step 2 |
| 6. MCP | 1 file | ~20 | O(1)/call | After Step 2 |
| 7. VSCode | 2 files | ~15 | O(1)/call | After Step 2 |
| 8. Graph metadata | 2-3 files | ~30 | O(1) | Independent |
| **Total** | **~25 files** | **~270 lines** | **O(1)/node** | |

## Risk Mitigation

1. **`resolveNodeFile()` backward compat** — handles both absolute and relative, so partial migration or mixed graphs work.
2. **Worker threads** — resolve to absolute BEFORE sending to worker; workers never change.
3. **ExpressAnalyzer dirname()** — explicitly resolved to absolute before path resolution.
4. **ASTWorker collections** — file fields normalized to relative after receiving from worker.
5. **queryNodes({ file })** — works because ALL nodes shift to relative simultaneously.
6. **Legacy IDs** — naturally shift to contain relative paths; accepted as one-time breaking change.
7. **RFDB file index** — string-exact-match, works with any format. Since both stored and queried values are relative, matching is preserved.
