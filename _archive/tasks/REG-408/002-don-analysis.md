# Don Melton — REG-408 Analysis: Portable Graphs (Relative Paths)

## Executive Summary

Grafema stores **absolute file paths** in `node.file` throughout the entire graph. This makes graphs non-portable: a graph built on `/Users/vadimr/project` cannot be queried on a CI machine where the project lives at `/app` or `/home/ci/project`. The fix requires changing ONE write point (JSModuleIndexer) and then updating all read points to resolve relative paths back to absolute at query time.

**Key insight:** The `node.file` field is set in exactly ONE primary location, then propagated downstream. But the downstream propagation happens in ~15+ analyzers that all read `module.file` from the MODULE node and copy it into child nodes. The architectural pattern is: **MODULE.file flows to all child nodes**.

---

## 1. Write Points (Where Absolute Paths Enter the Graph)

### 1.1 PRIMARY: JSModuleIndexer (THE source of truth)

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts:376`

```typescript
const moduleNode = {
  id: semanticId,
  type: 'MODULE' as const,
  name: relativePath,
  file: currentFile, // Keep absolute path for file reading in analyzers  <-- THIS LINE
  line: 0,
  contentHash: fileHash || '',
  isTest
};
```

The comment "Keep absolute path for file reading in analyzers" reveals the original design decision. `currentFile` is always an absolute path (resolved from entrypoint traversal).

### 1.2 SECONDARY: Every analyzer copies `module.file` into child nodes

Once MODULE has an absolute path, every analyzer blindly propagates it:

| Analyzer | File | Approx count of `module.file` references |
|----------|------|----------------------------------------|
| **JSASTAnalyzer** | `plugins/analysis/JSASTAnalyzer.ts` | ~120+ (most prolific) |
| **ASTWorker** | `core/ASTWorker.ts` | ~15 (uses `filePath` param directly) |
| **GraphBuilder** | `plugins/analysis/ast/GraphBuilder.ts` | ~8 (uses `module.file` for import/export nodes) |
| **FunctionVisitor** | `plugins/analysis/ast/visitors/FunctionVisitor.ts` | ~15 |
| **CallExpressionVisitor** | `plugins/analysis/ast/visitors/CallExpressionVisitor.ts` | ~30 |
| **ClassVisitor** | `plugins/analysis/ast/visitors/ClassVisitor.ts` | ~20 |
| **VariableVisitor** | `plugins/analysis/ast/visitors/VariableVisitor.ts` | ~12 |
| **TypeScriptVisitor** | `plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | ~3 |
| **PropertyAccessVisitor** | `plugins/analysis/ast/visitors/PropertyAccessVisitor.ts` | ~2 |
| **ExpressAnalyzer** | `plugins/analysis/ExpressAnalyzer.ts` | ~6 |
| **ExpressRouteAnalyzer** | `plugins/analysis/ExpressRouteAnalyzer.ts` | ~8 |
| **ExpressResponseAnalyzer** | `plugins/analysis/ExpressResponseAnalyzer.ts` | ~6 |
| **FetchAnalyzer** | `plugins/analysis/FetchAnalyzer.ts` | ~10 |
| **SocketIOAnalyzer** | `plugins/analysis/SocketIOAnalyzer.ts` | ~6 |
| **DatabaseAnalyzer** | `plugins/analysis/DatabaseAnalyzer.ts` | ~4 |
| **SQLiteAnalyzer** | `plugins/analysis/SQLiteAnalyzer.ts` | ~5 |
| **RustAnalyzer** | `plugins/analysis/RustAnalyzer.ts` | ~10 |
| **ServiceLayerAnalyzer** | `plugins/analysis/ServiceLayerAnalyzer.ts` | ~8 |
| **ReactAnalyzer** | `plugins/analysis/ReactAnalyzer.ts` | ~3 |
| **SystemDbAnalyzer** | `plugins/analysis/SystemDbAnalyzer.ts` | ~5 |

### 1.3 TERTIARY: Legacy IDs embed absolute paths

Many "legacy" node IDs embed `module.file` directly:

```typescript
// JSASTAnalyzer.ts
const legacyId = `FUNCTION#${funcName}#${module.file}#${getLine(node)}:${getColumn(node)}:${functionCounterRef.value++}`;
const legacyLoopId = `${module.file}:LOOP:${loopType}:${getLine(node)}:${loopCounter}`;
const legacyBranchId = `${module.file}:BRANCH:switch:${getLine(switchNode)}:${branchCounter}`;
const literalId = `LITERAL#${line}:${initExpression.start}#${module.file}`;
```

**This is a CRITICAL complication.** Node IDs themselves contain absolute paths. Changing `module.file` to relative would change all these IDs, which would:
- Break incremental analysis (all nodes would appear new)
- Break edge references (edges point to node IDs)
- Break Datalog queries that reference node IDs

### 1.4 IncrementalModuleIndexer (secondary indexer)

**File:** `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts`

Creates MODULE nodes with absolute file paths (same pattern as JSModuleIndexer).

### 1.5 NodeFactory.createModule (legacy API)

**File:** `packages/core/src/core/NodeFactory.ts:257-264`

```typescript
static createModule(filePath: string, projectPath: string, options: ModuleOptions = {}) {
  const contentHash = options.contentHash || this._hashFile(filePath);
  const relativePath = relative(projectPath, filePath) || basename(filePath);
  return brandNode(ModuleNode.create(filePath, relativePath, contentHash, options));
}
```

Takes absolute `filePath`, stores it as `file`. Marked as LEGACY in comments.

---

## 2. Read Points (Where Paths Are Consumed)

### 2.1 File Reading (needs absolute path to work)

These locations use `node.file` to **open and read source files**:

| Consumer | File | What it does |
|----------|------|-------------|
| **getCodePreview()** | `packages/cli/src/utils/codePreview.ts:30` | `existsSync(file)` + `readFileSync(file)` |
| **MCP context handler** | `packages/mcp/src/handlers.ts:1164-1166` | `existsSync(node.file)` + `readFileSync(node.file)` |
| **MCP context edges** | `packages/mcp/src/handlers.ts:1254-1256` | Same for connected nodes |
| **GraphFreshnessChecker** | `packages/core/src/core/GraphFreshnessChecker.ts:100-111` | `_fileExists(module.file)` + `calculateFileHashAsync(module.file)` |
| **IncrementalReanalyzer** | `packages/core/src/core/IncrementalReanalyzer.ts:84` | `clearFileNodesIfNeeded(graph, module.file, ...)` |
| **FileNodeManager** | `packages/core/src/core/FileNodeManager.ts:51` | `graph.queryNodes({ file })` |
| **JSASTAnalyzer** | `plugins/analysis/JSASTAnalyzer.ts:319,337,1420` | `calculateFileHash(module.file)` + `readFileSync(module.file)` + `queryNodes({ file: module.file })` |
| **ExpressAnalyzer** | `plugins/analysis/ExpressAnalyzer.ts:151` | `readFileSync(module.file!)` |
| **ExpressRouteAnalyzer** | `plugins/analysis/ExpressRouteAnalyzer.ts:143` | `readFileSync(module.file!)` |
| **ExpressResponseAnalyzer** | `plugins/analysis/ExpressResponseAnalyzer.ts:129` | `readFileSync(handlerNode.file)` |
| **FetchAnalyzer** | `plugins/analysis/FetchAnalyzer.ts:152,350,354` | `readFileSync(module.file!)` + `queryNodes({ file: module.file! })` |
| **SocketIOAnalyzer** | `plugins/analysis/SocketIOAnalyzer.ts:271` | `readFileSync(module.file!)` |
| **DatabaseAnalyzer** | `plugins/analysis/DatabaseAnalyzer.ts:142` | `readFileSync(module.file!)` |
| **SQLiteAnalyzer** | `plugins/analysis/SQLiteAnalyzer.ts:108` | `readFileSync(module.file!)` |
| **RustAnalyzer** | `plugins/analysis/RustAnalyzer.ts:233` | `readFileSync(module.file!)` |
| **ServiceLayerAnalyzer** | `plugins/analysis/ServiceLayerAnalyzer.ts:169` | `readFileSync(module.file!)` |
| **ReactAnalyzer** | `plugins/analysis/ReactAnalyzer.ts:291` | `readFileSync(module.file!)` |
| **SystemDbAnalyzer** | `plugins/analysis/SystemDbAnalyzer.ts:83` | `readFileSync(module.file!)` |
| **PrefixEvaluator** | `plugins/enrichment/PrefixEvaluator.ts:145` | `readFileSync(module.file)` |

### 2.2 Display/Formatting (needs relative path for display)

These locations use `node.file` for **display purposes** and already convert to relative:

| Consumer | File | Pattern |
|----------|------|---------|
| **formatLocation()** | `packages/cli/src/utils/formatNode.ts:126` | `relative(projectPath, file)` |
| **CLI query** | `packages/cli/src/commands/query.ts:834,859,939,1000` | `relative(projectPath, node.file)` |
| **CLI ls** | `packages/cli/src/commands/ls.ts:145` | `relative(projectPath, node.file)` |
| **CLI context** | `packages/cli/src/commands/context.ts:241,305` | `formatLocation(node.file, ...)` |
| **CLI trace** | `packages/cli/src/commands/trace.ts:750-752` | `src.file.startsWith(projectPath) ? src.file.substring(...)` |
| **CLI explain** | `packages/cli/src/commands/explain.ts:169` | `relative(projectPath, node.file)` |
| **CLI check** | `packages/cli/src/commands/check.ts:245,392,492` | Direct display of file paths |
| **CLI schema** | `packages/cli/src/commands/schema.ts:85` | `relative(projectPath, schema.source.file)` |
| **MCP handlers** | `packages/mcp/src/handlers.ts:1212,1247` | `relative(projectPath, node.file)` |
| **MCP handlers** | `packages/mcp/src/handlers.ts:669,975,1025,1067,1075,1096` | Direct display |
| **VSCode extension** | `packages/vscode/src/edgesProvider.ts:181,216,385` | Uses `node.file` directly |
| **VSCode extension** | `packages/vscode/src/extension.ts:84,361,374,416` | `vscode.Uri.file(file)` |
| **GuaranteeManager** | `core/GuaranteeManager.ts:537` | `module.file?.replace(this.projectPath, '')` |

### 2.3 Query/Filtering (uses `file` for node lookup)

| Consumer | File | Pattern |
|----------|------|---------|
| **RFDB queryNodes** | `storage/backends/RFDBServerBackend.ts:542` | `serverQuery.file = query.file` |
| **GraphBuilder** | `plugins/analysis/ast/GraphBuilder.ts` (many) | `v.file === loop.file`, filtering nodes by file |
| **ExpressResponseAnalyzer** | `plugins/analysis/ExpressResponseAnalyzer.ts:419-465` | `node.file === file` |
| **InterfaceSchemaExtractor** | `schema/InterfaceSchemaExtractor.ts:89` | `i.file === fileFilter \|\| i.file.endsWith(fileFilter)` |
| **PathValidator** | `validation/PathValidator.ts:79` | `node.file === file` |
| **FileExplainer** | `core/FileExplainer.ts:130` | `node.file === filePath` |
| **FetchAnalyzer** | `plugins/analysis/FetchAnalyzer.ts:350,354` | `queryNodes({ type: 'FUNCTION', file: module.file! })` |

### 2.4 Datalog (Rust side)

**File:** `packages/rfdb-server/src/datalog/eval.rs:472`

```rust
"file" => node.file.clone(),
```

Datalog rules can access `attr(Node, "file", X)` -- used in rules like:
```datalog
large_iteration(Loop, Var, File) :- node(Loop, "LOOP"), edge(Loop, Var, "ITERATES_OVER"),
  attr_edge(Loop, Var, "ITERATES_OVER", "scale", "nodes"), attr(Loop, "file", File).
```

---

## 3. How projectPath Flows Through the System

### 3.1 Entry points

```
CLI command args → resolve(options.project) → projectPath
MCP server args  → state.ts → getProjectPath()
Orchestrator     → run(projectPath) → absoluteProjectPath
```

### 3.2 Flow through analysis pipeline

```
Orchestrator.run(projectPath)
  → DiscoveryManifest { projectPath: absoluteProjectPath }
    → JSModuleIndexer.execute(context)
        context.manifest.projectPath → used for relative path computation
        BUT currentFile is stored as absolute on MODULE node
    → JSASTAnalyzer.execute(context)
        manifest.projectPath → projectPath variable
        module.file → absolute (from MODULE node)
        → GraphBuilder.build(module, graph, projectPath, data)
            module.file used for all child nodes
```

### 3.3 projectPath availability

- **During analysis:** Always available from `manifest.projectPath`
- **During query (CLI):** Available from `options.project` (resolved to absolute)
- **During query (MCP):** Available from `getProjectPath()` (global state)
- **During query (VSCode):** Available from workspace root
- **In RFDB:** NOT stored in the database itself; must be provided externally
- **In graph metadata:** NOT currently stored

**Critical gap:** The graph database does NOT store which projectPath it was built with. This means there's no way to know, from the `.grafema/graph.rfdb` file alone, what the original project root was.

---

## 4. Proposed Approach (High-Level)

### 4.1 The CodeQL Pattern

CodeQL uses the exact pattern we need (from WebSearch):
- Store relative paths from `sourceRoot` in the database
- `--source-root` flag provides the base for resolution
- SARIF output contains relative paths; consuming tools resolve them
- Database is portable because paths are root-relative

### 4.2 Three-Layer Architecture

```
LAYER 1 (Storage): node.file = relative path (e.g., "src/routes/auth.ts")
LAYER 2 (Core):    Analyzers resolve: join(projectPath, node.file) when they need to read files
LAYER 3 (Display): CLI/MCP show relative paths directly (no conversion needed!)
```

### 4.3 Implementation Strategy

**Phase 1: Store relative paths in MODULE nodes**
- Change JSModuleIndexer to store `relativePath` instead of `currentFile` in `file` field
- Change IncrementalModuleIndexer similarly
- Store `projectPath` as graph metadata (new capability needed in RFDB)

**Phase 2: Fix analysis pipeline**
- All analyzers that `readFileSync(module.file!)` need `join(projectPath, module.file!)`
- ASTWorker receives `filePath` (absolute) directly, keeps working
- GraphBuilder receives `projectPath` already, can resolve

**Phase 3: Fix query/display layer**
- CLI: `formatLocation()` already does `relative(projectPath, file)` -- with relative stored, `relative('', 'src/foo.ts')` = `'src/foo.ts'` (no change needed if projectPath handling is adjusted)
- MCP: Same pattern
- VSCode: Needs `join(workspaceRoot, file)` for URI construction

**Phase 4: Fix legacy IDs (DEFERRED)**
- Legacy IDs that embed `module.file` would now contain relative paths
- This changes node identity -- needs migration or versioning
- **This is the hardest part and may need separate task**

### 4.4 CRITICAL: Legacy ID Problem

Many node IDs embed the file path:
```
LITERAL#42:100#/Users/vadimr/project/src/auth.ts
LOOP#/Users/vadimr/project/src/auth.ts:LOOP:for:42:1
SCOPE#if#/Users/vadimr/project/src/auth.ts#42:5:1
```

If we switch `module.file` to relative, these IDs change:
```
LITERAL#42:100#src/auth.ts
LOOP#src/auth.ts:LOOP:for:42:1
SCOPE#if#src/auth.ts#42:5:1
```

**This is actually GOOD** -- it makes IDs portable too. But it means:
1. First analysis after migration produces a completely new graph (no incremental reuse)
2. This is acceptable because `forceAnalysis=true` rebuilds everything anyway

**However**, semantic IDs (the newer system) do NOT embed absolute paths:
```
src/auth.ts->global->FUNCTION->authenticate
```
These are already relative! The semantic ID system was designed correctly.

### 4.5 Alternative: Resolve at Read Time Only (Minimal Change)

Instead of changing what's stored, add a resolution layer:

```typescript
// New utility
function resolveFilePath(nodeFile: string, projectPath: string): string {
  if (path.isAbsolute(nodeFile)) return nodeFile; // backward compat
  return path.join(projectPath, nodeFile);
}
```

Use this everywhere a file needs to be read from disk. This supports BOTH old (absolute) and new (relative) graphs.

**I recommend this hybrid approach for migration safety.**

---

## 5. Risk Assessment

### Low Risk
- Display layer (CLI, MCP formatting) -- already converts to relative
- Datalog queries -- `attr(N, "file", X)` works with any string
- RFDB file index -- works with any string value

### Medium Risk
- Analyzer readFileSync calls (~15 analyzers) -- mechanical change but many sites
- VSCode extension -- needs to resolve paths for file opening
- GraphFreshnessChecker -- needs absolute path to check file existence
- FileNodeManager -- queries by file, needs to match stored format

### High Risk
- **Legacy node IDs** -- changing these breaks incremental analysis identity
- **Edge references to legacy IDs** -- edges pointing to IDs that change
- **Module resolution** (`ExpressAnalyzer.ts:391-410`) -- uses `module.file` as absolute path for `dirname()` + `resolve()` to find referenced modules

### Migration Risk
- Existing graphs with absolute paths will NOT work with new code that expects relative
- Need backward compatibility: detect absolute paths and handle them
- OR: require `grafema analyze --force` after upgrade (acceptable for alpha/v0.1.x)

---

## 6. Big-O Analysis

### Node Count Impact
- **Every node with a `file` field** is affected -- this is nearly ALL nodes in the graph
- For a medium project (1000 files, 50 nodes/file average): ~50,000 nodes
- For a large project: 500,000+ nodes
- The change is O(1) per node (string replacement), applied during indexing/analysis

### Performance Impact
- **Indexing:** Zero overhead -- we already compute `relativePath`, we just store it instead of `currentFile`
- **Analysis:** Small overhead -- each `readFileSync` call adds one `path.join()` O(1) operation
- **Query:** Zero overhead for display (no more `relative()` call needed)
- **Query:** Small overhead for file reading (one `path.join()` per read)

### Migration Cost (one-time)
- Requires full re-analysis (`grafema analyze --force`)
- O(N) where N = total nodes in graph
- For legacy ID nodes, existing edges become dangling -- needs full rebuild
- This is NOT incremental-safe; it's a breaking schema change

---

## 7. RFDB Storage Layer Notes

### v1 Storage (`NodeRecord`)
```rust
pub file_id: u32,      // file path stored in string table
```
The file is an opaque string. Changing absolute to relative is transparent to storage.

### v2 Storage (`NodeRecordV2`)
```rust
/// Source file path (relative).
pub file: String,
```
The v2 storage **already documents** that `file` should be relative! The Rust side is ready for this change.

### File Index
```rust
// engine.rs:896
Candidates::Indexed(self.index_set.find_by_file(query.file.as_ref().unwrap()).to_vec())
```
The file index is a string-exact-match index. It will work with relative paths, but callers querying by file must now pass relative paths. This affects:
- `FileNodeManager.clearFileNodesIfNeeded()` -- queries by absolute path
- `FetchAnalyzer` -- queries by `module.file`
- `JSASTAnalyzer` -- queries by `module.file`

---

## 8. Recommended Plan Sequence

1. **Add `projectPath` to graph metadata** -- store it alongside the graph so query tools know the root
2. **Create `resolveNodeFile(node, projectPath)` utility** -- handles both absolute (legacy) and relative (new) paths
3. **Change JSModuleIndexer to store relative paths** -- the ONE primary write point
4. **Update all analyzers** that read files via `module.file` to use `join(projectPath, module.file)`
5. **Update CLI/MCP display** to handle both formats (backward compat)
6. **Update GraphFreshnessChecker** to resolve paths before file access
7. **Update FileNodeManager** to use relative paths for queries
8. **Update VSCode extension** to resolve paths for URI construction
9. **Document**: after upgrade, run `grafema analyze --force` once

Legacy IDs will naturally shift to relative paths because they're built from `module.file`. This is a one-time break that forces re-analysis -- acceptable for v0.1.x.

---

## 9. Key Architectural Observation

The fact that `module.file` propagates to ALL child nodes means there's really only ONE place to fix the write: the MODULE node creation. All downstream analyzers just copy `module.file` into child node `file` fields. If MODULE stores relative, all children will too.

The work is almost entirely on the **read side** -- adding `path.join(projectPath, ...)` before every `readFileSync()` and `existsSync()` call.

**Estimated scope:** ~250 lines of mechanical changes across ~20 files, plus ~50 lines for the new utility and graph metadata storage.

---

*Sources:*
- [CodeQL source-root SARIF issue](https://github.com/github/codeql-action/issues/1147)
- [CodeQL --source-root documentation](https://github.com/github/codeql/discussions/15698)
- [SARIF support for code scanning](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
