# Don Melton Analysis: REG-120 Singleton Nodes Not Created

## Problem Statement

Network singleton nodes (`net:request`, `net:stdio`) are expected to be created when code uses `console.log` or `fetch`, but `net:request` is NOT being created while `net:stdio` IS being created.

## Root Cause Analysis

### Why `net:stdio` WORKS

1. **CallExpressionVisitor** in `JSASTAnalyzer` detects `console.log/error` method calls and adds them to `methodCalls` collection
2. **GraphBuilder.bufferStdioNodes()** (line 369-392) checks `methodCalls` for `console.log/error` patterns
3. When found, it creates the `net:stdio` singleton via `NodeFactory.createExternalStdio()`

The flow is:
```
CallExpressionVisitor detects console.log
-> methodCalls collection populated
-> GraphBuilder.bufferStdioNodes()
-> net:stdio singleton created
```

### Why `net:request` FAILS

The `httpRequests` collection is:
1. **Declared** in JSASTAnalyzer (line 767): `const httpRequests: HttpRequestInfo[] = [];`
2. **Passed** to allCollections (line 838)
3. **Passed** to GraphBuilder.build() (line 1079)
4. **Checked** by GraphBuilder.bufferHttpRequests() (line 645-687)

**BUT: Nothing ever populates `httpRequests`!**

I searched the entire codebase:
- `grep -r "httpRequests.push" packages/core/src/plugins/analysis/` returns **ONLY FetchAnalyzer.ts** results
- JSASTAnalyzer's visitors (CallExpressionVisitor, VariableVisitor, etc.) **never push to httpRequests**

The `httpRequests` array arrives at GraphBuilder **always empty**, so `bufferHttpRequests()` never creates the `net:request` singleton.

### The Architectural Gap

There are TWO separate detection mechanisms that don't connect:

1. **JSASTAnalyzer path** (synchronous, per-module):
   - Uses visitors: CallExpressionVisitor, VariableVisitor, etc.
   - Creates `methodCalls` collection for `console.log` detection
   - `httpRequests` collection exists but is NEVER populated
   - GraphBuilder.bufferStdioNodes() works for console.log

2. **FetchAnalyzer path** (async plugin, separate phase):
   - Runs as a separate plugin AFTER JSASTAnalyzer
   - Re-parses files and detects `fetch()`, `axios`, etc.
   - Creates its OWN `http:request` nodes with type `'http:request'` (lowercase)
   - Does NOT create the `net:request` singleton!
   - Creates EXTERNAL nodes for APIs but no singleton

3. **ExpressAnalyzer path**:
   - DOES create `net:request` singleton (line 85): `const networkNode = NetworkRequestNode.create(); await graph.addNode(networkNode);`
   - But this only runs for Express.js projects

### The Missing Link

**For general JavaScript projects without Express:**
- `fetch()` calls ARE detected by FetchAnalyzer
- FetchAnalyzer creates `http:request` nodes (call sites)
- But NO ONE creates the `net:request` singleton for non-Express projects
- GraphBuilder.bufferHttpRequests() would create it IF httpRequests had data

## Summary: Two Bugs

### Bug 1: JSASTAnalyzer doesn't populate httpRequests
The `httpRequests` collection in JSASTAnalyzer is never populated. CallExpressionVisitor detects method calls like `console.log` but doesn't have logic to detect `fetch()` calls and add them to `httpRequests`.

### Bug 2: FetchAnalyzer doesn't create net:request singleton
FetchAnalyzer detects HTTP requests but doesn't create the `net:request` singleton node. It only creates individual `http:request` call site nodes.

## Alignment with Project Vision

> "AI should query the graph, not read code."

This bug breaks that vision because:
1. An AI querying "what network requests does this code make?" won't find the `net:request` singleton
2. The HTTP_REQUEST -> net:request graph structure is incomplete
3. Inconsistency: `net:stdio` works perfectly, but `net:request` doesn't

The singleton pattern is correct:
- `net:stdio` = system resource (console I/O)
- `net:request` = system resource (network I/O)

All I/O should flow through these singletons so AI can answer: "What external resources does this code touch?"

## Recommended Fix Options

### Option A: Fix JSASTAnalyzer (add httpRequests population)

Add fetch detection to CallExpressionVisitor:
- When `fetch(url)` or `axios.get(url)` detected, push to `httpRequests`
- GraphBuilder.bufferHttpRequests() already handles the rest
- This keeps everything in one pass, no duplicate parsing

**Pros:** Single-pass analysis, consistent with console.log pattern
**Cons:** Duplicates FetchAnalyzer's detection logic

### Option B: Fix FetchAnalyzer (add singleton creation)

Add singleton creation to FetchAnalyzer.execute():
```typescript
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);

// Then connect all http:request nodes to it
for (const request of httpRequests) {
  await graph.addEdge({ type: 'CALLS', src: request.id, dst: networkNode.id });
}
```

**Pros:** Uses existing fetch detection, no duplicated code
**Cons:** FetchAnalyzer may not be registered in all test orchestrators

### Option C: Hybrid - Move singleton creation to both paths

1. JSASTAnalyzer path: Add httpRequests population for basic fetch() calls
2. FetchAnalyzer: Also ensure singleton exists (idempotent via _createdSingletons or graph dedup)

**Recommendation: Option B**

FetchAnalyzer already does the heavy lifting of detecting fetch/axios patterns. It just needs to:
1. Create the `net:request` singleton (like ExpressAnalyzer does)
2. Connect `http:request` nodes to it via CALLS edges

This matches how ExpressAnalyzer works (line 85-86, 309-314).

## Test Requirements

Existing tests in `test/unit/NetworkRequestNodeMigration.test.js` verify:
- `net:request` singleton created when analyzing fetch calls
- HTTP_REQUEST connects to `net:request` via CALLS edges
- Only ONE `net:request` node (singleton deduplication)

The tests are currently failing due to the bug described above.

## Files to Modify

1. `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`
   - Import `NetworkRequestNode`
   - Create singleton at start of execute()
   - Add CALLS edges from http:request to net:request

2. Optionally update test orchestrator or ensure FetchAnalyzer is registered for tests

## Priority

HIGH - This is a fundamental graph completeness issue that breaks the AI-queryable graph vision.
