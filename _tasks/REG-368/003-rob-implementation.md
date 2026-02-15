## Rob's Implementation Report: REG-368

### Summary

Implemented all 5 planned commits to make `brandNode()` internal and update the `GraphBackend` interface. 7 files modified/created across 5 atomic commits.

### Commits

**Commit 1: `feat: create internal branding helper for node creation`** (9b0619f)
- Created `packages/core/src/core/brandNodeInternal.ts`
- Simple cast function: `return node as BrandedNode<T>`
- JSDoc documents legitimate use sites (NodeFactory, GraphBuilder, RFDBServerBackend)

**Commit 2: `refactor: switch NodeFactory from brandNode to brandNodeInternal`** (b9b218b)
- Replaced import: `brandNode` from `@grafema/types` -> `brandNodeInternal` from `./brandNodeInternal.js`
- Replaced all 35 `brandNode()` calls with `brandNodeInternal()`
- No behavior change, just import source change

**Commit 3: `refactor: add branding in GraphBuilder._flushNodes and RFDBServerBackend._parseNode`** (2b6cff8)
- `GraphBuilder._flushNodes()`: added `brandNodeInternal()` call via `.map()` on the node buffer before flushing to graph backend. Cast through `unknown` to `NodeRecord` since `GraphNode` is a more permissive internal type.
- `RFDBServerBackend._parseNode()`: changed return type from `BaseNodeRecord` to `AnyBrandedNode`, brands the parsed result before returning.

**Build result after commits 1-3: CLEAN (0 errors)**

**Commit 4: `feat!: make brandNode() internal, remove from public API`** (d32819d)
- Removed `brandNode()` function entirely from `packages/types/src/branded.ts` (eslint `no-unused-vars` would reject keeping it as unexported dead code)
- Changed `packages/types/src/index.ts` from `export * from './branded.js'` to selective exports: only `BrandedNode`, `AnyBrandedNode`, `UnbrandedNode` (types) and `isBrandedNode` (type guard)

**Commit 5: `feat!: update GraphBackend interface to require AnyBrandedNode`** (0a760c5)
- Removed `InputNode` interface from `packages/types/src/plugins.ts` (lines 258-266)
- Updated `GraphBackend.addNode()` and `GraphBackend.addNodes()` signatures: `InputNode` -> `AnyBrandedNode`
- Added import for `AnyBrandedNode` from `./branded.js`
- Kept `InputEdge` unchanged (edges don't have branding yet)

### Build Results After Commits 4-5

**31 TypeScript errors** (plan estimated ~50).

Error breakdown:
- 14 errors: `NodeRecord[]` not assignable to `AnyBrandedNode[]` (analyzers using `addNodes`)
- 8 errors: `NodeRecord` not assignable to `AnyBrandedNode` (individual `addNode` calls)
- 5 errors: inline object literals not assignable to `AnyBrandedNode`
- 2 errors: `BaseNodeRecord` not assignable to `AnyBrandedNode`
- 1 error: `NetworkRequestNodeRecord` not assignable to `AnyBrandedNode`
- 1 error: `ModuleForAnalysis` not assignable to `AnyBrandedNode`

Affected areas:
- Orchestrator (2 errors)
- IncrementalReanalyzer (1 error)
- IncrementalAnalysisPlugin (2 errors)
- JSASTAnalyzer, JSModuleIndexer (2 errors)
- Various analyzers: Express, React, Database, Fetch, SocketIO, Socket, Rust, NestJS, SQLite, ServiceLayer, SystemDb (16 errors)
- Various enrichers: FunctionCallResolver, ExternalCallResolver, NodejsBuiltinsResolver, MountPointResolver, ServiceConnectionEnricher (5 errors)
- Discovery: MonorepoServiceDiscovery (1 error)
- Indexing: RustModuleIndexer, IncrementalModuleIndexer (2 errors)

### Deviations from Plan

1. **brandNode() removed entirely** instead of just removing `export`. ESLint `no-unused-vars` rule rejects non-exported unused functions. The function was dead code anyway (fully replaced by `brandNodeInternal` in core). This is a cleaner result.

2. **31 errors instead of ~50**. The estimate was conservative. Actual count is lower because:
   - Many analyzers share patterns (one `addNodes` call per file)
   - RFDBServerBackend uses its own local `InputNode` type, not the one from `@grafema/types`
   - No test file errors yet (tests are in separate compilation, not checked by `pnpm build`)

3. **RFDBServerBackend retains its own local `InputNode` interface**. The backend has its own `InputNode` at line 55-64 which is used by its `addNode()`/`addNodes()` methods. This is separate from the now-removed `InputNode` in `@grafema/types/plugins.ts`. The backend doesn't explicitly `implements GraphBackend`, so there's no type conflict. Downstream tasks will need to address this if the backend should conform to the updated interface.

### Files Changed

| File | Action |
|------|--------|
| `packages/core/src/core/brandNodeInternal.ts` | Created |
| `packages/core/src/core/NodeFactory.ts` | Modified (import + 35 call replacements) |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Modified (import + _flushNodes branding) |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | Modified (import + _parseNode return type + branding) |
| `packages/types/src/branded.ts` | Modified (removed brandNode function) |
| `packages/types/src/index.ts` | Modified (selective exports) |
| `packages/types/src/plugins.ts` | Modified (removed InputNode, updated GraphBackend) |
