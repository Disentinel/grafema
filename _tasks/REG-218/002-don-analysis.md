# Don Melton: REG-218 Analysis

## Analysis Summary

Comprehensive analysis of the Grafema codebase to understand how to implement semantic bindings for Node.js built-in modules.

---

## 1. Current Architecture - How It Works

**Import/Module Resolution:**
- `ImportExportVisitor` (AST analysis phase) collects import statements and metadata
- `ImportExportLinker` (enrichment phase) creates `IMPORTS_FROM` edges between IMPORT and EXPORT nodes
- External modules (non-relative imports) create `EXTERNAL_MODULE` nodes via `NodeFactory.createExternalModule()`
- External module ID format: `EXTERNAL_MODULE:{source}` (e.g., `EXTERNAL_MODULE:fs`, `EXTERNAL_MODULE:@tanstack/react-query`)

**Call Resolution:**
- `CALL` nodes are created during AST analysis with call site metadata (line, column, name)
- `MethodCallResolver` (enrichment) tries to link CALL nodes to function/method definitions
- `AliasTracker` (enrichment) handles indirect calls through variables
- `ValueDomainAnalyzer` (enrichment) traces data flow to resolve dynamic method calls
- **Key pattern:** CALL nodes are created, then enrichment plugins add CALLS edges to definitions

**Semantic ID Format:**
- `{file}->{scope_path}->{TYPE}->{name}[#discriminator]`
- Examples: `src/app.js->global->FUNCTION->processData`
- External modules use singleton pattern: `EXTERNAL_MODULE:fs` (no scope)

**Node Types System:**
- Base types: `FUNCTION`, `METHOD`, `CALL`, `VARIABLE`, `IMPORT`, `EXPORT`, etc.
- Namespaced types: `http:route`, `fs:read`, `db:query`, etc.
- Framework-specific: `express:middleware`, `socketio:emit`, etc.

---

## 2. Plugin Architecture - How to Add Bindings

**Plugin Phases:**
1. **INDEXING** (JSModuleIndexer) — finds modules
2. **ANALYSIS** (JSASTAnalyzer, ExpressRouteAnalyzer, FetchAnalyzer) — creates nodes
3. **ENRICHMENT** (MethodCallResolver, ValueDomainAnalyzer, etc.) — creates CALLS edges
4. **VALIDATION** (CallResolverValidator, etc.) — validates graph state

**Existing Pattern - FetchAnalyzer:**
- Phase: `ANALYSIS` (priority 75)
- Creates: `http:request` nodes (for fetch(), axios.get(), etc.)
- Creates edges: `CALLS` → network singleton
- Metadata: method, url, library, staticUrl

**Existing Pattern - ExpressRouteAnalyzer:**
- Phase: `ANALYSIS` (priority 75)
- Creates: `http:route` and `express:middleware` nodes
- Creates edges: `USES_MIDDLEWARE`, `HANDLED_BY`
- Metadata: path, method, routerName

---

## 3. Design Decision: Bound vs. Unbound

**REG-206 Design (implied from code):**
- **Bound** = "bindings that ship out of the box" — built-ins we have semantic definitions for
- **Unbound** = external libraries without built-in support
- For Node.js built-ins: they should be **Bound**, creating proper semantic nodes
- Example: `fs.readFile()` → CALLS → BUILTIN_FUNCTION:fs.readFile (not CALLS_UNBOUND)

---

## 4. Critical Architecture Alignment

**Grafema's Core Thesis:** "AI should query the graph, not read code"

**For Node.js bindings this means:**
- Not just marking imports as "external" (EXTERNAL_MODULE:fs)
- Creating rich semantic nodes for frequently-used functions
- Enabling data flow analysis through pure functions (path.join, Buffer.concat, etc.)
- Distinguishing pure vs. impure operations
- Marking security-sensitive operations (child_process.exec, eval, etc.)

**Current Gap:**
- `EXTERNAL_MODULE:fs` node exists ✓
- But no `BUILTIN_FUNCTION:fs.readFile` nodes ✗
- No semantic distinction between pure/impure operations ✗
- No way to query "what files does this code read?" ✗

---

## 5. Recommended Architecture

### Phase 1: Create Builtin Function Nodes

Node type: `BUILTIN_FUNCTION:{module}.{name}`
- Examples: `BUILTIN_FUNCTION:fs.readFile`, `BUILTIN_FUNCTION:path.join`, `BUILTIN_FUNCTION:crypto.createHash`
- Singleton pattern (no scope) — same as EXTERNAL_MODULE
- Metadata fields:
  - `module`: base module name (fs, path, crypto, etc.)
  - `name`: function/export name
  - `pure`: boolean (is it pure? path.join=true, fs.readFile=false)
  - `async`: boolean (does it return Promise?)
  - `security`: string (none, file-io, exec, crypto, network, etc.)
  - `signature`: parameter info for data flow

### Phase 2: Plugin Architecture

Create a `NodeJSBuiltinsPlugin` that:
1. **ANALYSIS phase** (priority 80) — reads `.grafema/builtins.json` (static definitions)
2. Creates BUILTIN_FUNCTION nodes for Tier 1 modules
3. Creates EXTERNAL_MODULE node if not already present
4. Creates CONTAINS edge: EXTERNAL_MODULE → BUILTIN_FUNCTION

### Phase 3: Link Calls to Builtins

Extend `MethodCallResolver` to:
1. Detect calls like `fs.readFile(...)`
2. Look up target in builtin definitions
3. Create CALLS edge from CALL → BUILTIN_FUNCTION node

### Phase 4: Data Flow

For pure functions, annotate with parameter→return data flow:
- `path.join(parts: string[]): string`
- `Buffer.concat(list: Buffer[]): Buffer`

---

## 6. File Structure

```
packages/core/src/
├── core/
│   └── nodes/
│       └── BuiltinFunctionNode.ts        [NEW]
├── plugins/
│   └── analysis/
│       └── NodeJSBuiltinsPlugin.ts       [NEW]
└── data/
    └── builtins/
        ├── fs.json                       [NEW]
        ├── path.json                     [NEW]
        ├── crypto.json                   [NEW]
        ├── http.json                     [NEW]
        ├── child_process.json            [NEW]
        └── index.ts                      [NEW - exports all]

.grafema/
└── builtins.json                         [Static definition file]
```

---

## 7. Key Questions & Concerns

**Q: How to handle fs.promises vs fs?**
A: Both map to same BUILTIN_FUNCTION:fs.readFile, but with `submodule: 'promises'` metadata

**Q: What about optional exports like `fs/promises`?**
A: Create import resolution that recognizes `fs/promises` → redirects to `fs` module with promises flag

**Q: How do we handle overloads? fs.readFile has sync and async variants.**
A: One node per logical function (async handles all variants), metadata shows variants

**Q: Security-sensitive operations metadata — how detailed?**
A: Start simple: `security: 'exec' | 'file-io' | 'network' | 'crypto' | 'none'`
Can extend later with more granular threat model

**Q: Should we create BUILTIN_FUNCTION for every export in fs, path, etc.?**
A: **NO.** MVP: only frequently-used Tier 1 functions (~50-100 total)
Data: use npm trends and code search to identify hot path

---

## 8. MVP Scope (Tier 1 Only)

| Module | Functions | Estimate |
|--------|-----------|----------|
| fs | readFile, writeFile, stat, exists, rm | 5 |
| path | join, resolve, basename, dirname, extname | 5 |
| http | createServer, request, get | 3 |
| crypto | createHash, randomBytes, pbkdf2, sign | 4 |
| child_process | exec, spawn, fork | 3 |
| **Total** | | **20 functions** |

---

## 9. Test Strategy

1. **Unit tests:** BuiltinFunctionNode creation, validation
2. **Integration tests:**
   - Import fs → EXTERNAL_MODULE:fs created
   - Call fs.readFile() → CALLS edge to BUILTIN_FUNCTION:fs.readFile
   - Data flow: parameter tracking for pure functions
3. **Query tests:**
   - Find all file I/O operations
   - Find all child_process calls (security queries)
   - Find pure transformations (path manipulations)

---

## 10. Alignment with Project Vision

✓ **Fills the gap:** Graph becomes superior to code reading
✓ **Enables queries:** "What files does this code touch?" becomes answerable
✓ **Security relevance:** Can mark dangerous operations
✓ **Data flow:** Pure functions enable accurate tracing
✓ **Scalable:** Plugin pattern allows future AWS SDK, Express, etc. bindings
✓ **Backward compatible:** EXTERNAL_MODULE nodes still work; BUILTIN_FUNCTION is enhancement

---

## 11. Concerns & Tradeoffs

**Concern 1:** Static definition file maintenance
- **Mitigation:** Tier 1 only (~20 functions), can be maintained easily
- Future: consider code generation from Node.js source

**Concern 2:** Import aliasing (`const fs = require('fs')`; `fs.readFile()`)
- **Mitigation:** ValueDomainAnalyzer already handles this for regular function calls
- Should work naturally if MethodCallResolver extended properly

**Concern 3:** Optional parameters and overloads
- **Mitigation:** MVP doesn't require perfect param tracking
- Can enhance in v0.2 with better signature support

---

## 12. Recommendation

**✓ PROCEED with planned approach:**

1. Create `BuiltinFunctionNode` class (follows existing pattern)
2. Create `NodeJSBuiltinsPlugin` for ANALYSIS phase
3. Extend `MethodCallResolver` to handle builtin calls
4. Define Tier 1 builtins in JSON (fs, path, http, crypto, child_process)
5. Write comprehensive tests
6. Start with 20 most-used functions

**Risk:** LOW — follows existing patterns, isolated feature, backward compatible
