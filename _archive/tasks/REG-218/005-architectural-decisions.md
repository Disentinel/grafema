# REG-218: Architectural Decisions

## Decision 1: Node Type Naming

**Decision:** Use `EXTERNAL_FUNCTION` instead of `BUILTIN_FUNCTION`

**Rationale:**
- Future-proofs for AWS SDK, Express, and other npm package bindings
- Metadata flag `isBuiltin: true/false` distinguishes Node.js builtins from third-party packages
- Avoids costly schema migration later

**Impact on plan:**
- Rename all references from `BUILTIN_FUNCTION` to `EXTERNAL_FUNCTION`
- Add `isBuiltin: boolean` to node metadata
- ID format: `EXTERNAL_FUNCTION:fs.readFile`, `EXTERNAL_FUNCTION:path.join`, etc.

## Decision 2: Lazy Node Creation

**Decision:** Create `EXTERNAL_FUNCTION` nodes lazily (on-demand)

**Rationale:**
- Leaner graph — only nodes that matter
- Real codebases use 3-5 functions typically, not all 20
- Aligns with Grafema's "query what exists" philosophy

**Impact on plan:**
- No `NodeJSBuiltinsPlugin` in ANALYSIS phase creating all nodes upfront
- `MethodCallResolver` (ENRICHMENT) creates nodes when it resolves calls
- BuiltinRegistry provides definitions, but doesn't trigger node creation
- Node creation happens in MethodCallResolver when:
  1. Call to `fs.readFile()` detected
  2. Registry lookup confirms `fs.readFile` is a known builtin
  3. EXTERNAL_FUNCTION node created (if not exists)
  4. CALLS edge created

## Updated Architecture

```
ANALYSIS Phase:
- JSASTAnalyzer creates IMPORT, CALL nodes (unchanged)
- BuiltinRegistry loaded (no plugin, just data)

ENRICHMENT Phase:
- MethodCallResolver:
  1. Detects method call (fs.readFile)
  2. Checks BuiltinRegistry.isKnownFunction('fs', 'readFile')
  3. If known → creates EXTERNAL_FUNCTION:fs.readFile (lazy)
  4. Creates CALLS edge from CALL → EXTERNAL_FUNCTION
```

## Tech Debt to Document (v0.2)

- JSON definitions maintenance strategy
- Code generation from @types/node for automatic sync with Node.js releases
