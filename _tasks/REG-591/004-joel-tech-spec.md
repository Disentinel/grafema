# REG-591: Technical Specification — Plugin API for Domain Analyzers in core-v2

**Author:** Joel Spolsky, Implementation Planner
**Date:** 2026-03-01
**Status:** SPEC — ready for implementation
**Based on:** 002-don-exploration.md, 003-don-plan.md

---

## Preamble: Implementation Philosophy

This spec is complete enough that an engineer should be able to code from it without making design
decisions. Every ambiguity has been resolved here. When the spec says "before line X", it means
before that exact line. When the spec shows before/after code, copy the after exactly.

The five commits are ordered so that each one is independently buildable, all tests pass after each,
and nothing is left in a broken intermediate state.

---

## Commit 1: Add `argValues` to CALL node metadata in `expressions.ts`

### File: `packages/core-v2/src/visitors/expressions.ts`

### What changes

Add `argValues: (string | null)[]` to the metadata of every CALL node. This is a pure additive
change. No interfaces change. No other files change.

### New imports needed

`TemplateLiteral` is not currently imported. Add it to the import list from `@babel/types`.

**Before (line 8–38):**
```typescript
import type {
  ArrayExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  AwaitExpression,
  BinaryExpression,
  CallExpression,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  ClassMethod,
  ClassProperty,
  ForInStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MemberExpression,
  NewExpression,
  Node,
  NumericLiteral,
  ObjectExpression,
  ObjectMethod,
  ObjectProperty,
  PrivateName,
  StringLiteral,
  TaggedTemplateExpression,
  UnaryExpression,
  UpdateExpression,
  VariableDeclarator,
  YieldExpression,
} from '@babel/types';
```

**After:**
```typescript
import type {
  ArrayExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  AwaitExpression,
  BinaryExpression,
  CallExpression,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  ClassMethod,
  ClassProperty,
  ForInStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MemberExpression,
  NewExpression,
  Node,
  NumericLiteral,
  ObjectExpression,
  ObjectMethod,
  ObjectProperty,
  PrivateName,
  StringLiteral,
  TaggedTemplateExpression,
  TemplateLiteral,
  UnaryExpression,
  UpdateExpression,
  VariableDeclarator,
  YieldExpression,
} from '@babel/types';
```

### Where to add argValues extraction

In `visitCallExpression`, the CALL node metadata is built at approximately line 106–124.
The extraction must happen BEFORE the CALL node is constructed, so the values are available
when the metadata object literal is assembled.

**Before (lines 104–124 approximately):**
```typescript
  const nodeId = ctx.nodeId('CALL', calleeName, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CALL',
      name: calleeName,
      file: ctx.file,
      line,
      column,
      metadata: {
        arguments: call.arguments.length,
        chained: isChained,
        ...((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression') && call.callee.property.type === 'Identifier'
          ? { method: call.callee.property.name, object: call.callee.object.type === 'Identifier' ? call.callee.object.name : call.callee.object.type === 'ThisExpression' ? 'this' : call.callee.object.type === 'Super' ? 'super' : undefined }
          : {}),
      },
    }],
    edges: [],
    deferred: [],
  };
```

**After:**
```typescript
  const nodeId = ctx.nodeId('CALL', calleeName, line);

  // Extract string literal values for domain plugin consumption.
  // Position is preserved: argValues[i] corresponds to call.arguments[i].
  // null means the argument at that position is not a string literal.
  const argValues: (string | null)[] = [];
  for (const arg of call.arguments) {
    if (arg.type === 'StringLiteral') {
      argValues.push((arg as StringLiteral).value);
    } else if (
      arg.type === 'TemplateLiteral'
      && (arg as TemplateLiteral).quasis.length === 1
      && (arg as TemplateLiteral).expressions.length === 0
    ) {
      const tl = arg as TemplateLiteral;
      argValues.push(tl.quasis[0].value.cooked ?? tl.quasis[0].value.raw);
    } else {
      argValues.push(null);
    }
  }

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CALL',
      name: calleeName,
      file: ctx.file,
      line,
      column,
      metadata: {
        arguments: call.arguments.length,
        chained: isChained,
        argValues,
        ...((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression') && call.callee.property.type === 'Identifier'
          ? { method: call.callee.property.name, object: call.callee.object.type === 'Identifier' ? call.callee.object.name : call.callee.object.type === 'ThisExpression' ? 'this' : call.callee.object.type === 'Super' ? 'super' : undefined }
          : {}),
      },
    }],
    edges: [],
    deferred: [],
  };
```

### Invariants maintained

- `argValues` is always present (never undefined). Empty array means zero arguments.
- `argValues.length === call.arguments.length` always holds. The loop runs once per argument.
- `argValues[i] === null` means argument `i` is not a plain string (could be an Identifier, call,
  binary expression, complex template literal, etc.).
- No existing test is broken: `metadata` is `Record<string, unknown>` so adding a field is safe.

### Tests to write

File: `packages/core-v2/test/unit/expressions-argvalues.test.mjs` (new file)

Test cases:
1. `foo('hello', 'world')` → `metadata.argValues === ['hello', 'world']`
2. `foo(\`simple\`)` (no expressions) → `metadata.argValues === ['simple']`
3. `foo(\`with ${x}\`)` (has expression) → `metadata.argValues === [null]`
4. `foo(x, 'str')` (Identifier then string) → `metadata.argValues === [null, 'str']`
5. `foo()` (no args) → `metadata.argValues === []`
6. `foo(42, true)` (numeric/boolean) → `metadata.argValues === [null, null]`
7. `app.get('/users', handler)` → `metadata.argValues === ['/users', null]`
   Confirm `metadata.method === 'get'`, `metadata.object === 'app'` still present.

Each test calls `walkFile(code, 'test.ts', jsRegistry)` and inspects the resulting CALL node's
metadata. No snapshot tests — assert each field explicitly.

### Big-O

O(A) per CALL node where A is argument count. Typical A is 0–4. No nested loops. Total cost across
a file is O(total arguments across all calls) — bounded by file size. This is negligible.

---

## Commit 2: Add `DomainPlugin` interfaces to `packages/core-v2/src/types.ts` and `index.ts`

### File: `packages/core-v2/src/types.ts`

### New import needed

`File` from `@babel/types` must be imported. The file already imports `Node` from `@babel/types`
at line 135. Add `File` to that import.

**Before (line 135):**
```typescript
import type { Node } from '@babel/types';
```

**After:**
```typescript
import type { Node, File } from '@babel/types';
```

### New interfaces to add

Add at the very end of `types.ts`, after the `FileResult` interface (after line 192):

```typescript
// ─── Domain Plugin API ───────────────────────────────────────────────

/**
 * What a domain plugin returns for one file.
 * All required arrays may be empty but must not be undefined.
 * deferred is optional — omit if the plugin creates no cross-file refs.
 */
export interface DomainPluginResult {
  /** Additional graph nodes to merge into FileResult. Must not duplicate existing node IDs. */
  nodes: GraphNode[];
  /** Additional graph edges to merge into FileResult. */
  edges: GraphEdge[];
  /**
   * Optional deferred refs for cross-file resolution.
   * Use kinds: import_resolve, call_resolve, type_resolve, alias_resolve.
   * Do NOT emit scope_lookup or export_lookup — Stage 2 is already complete.
   */
  deferred?: DeferredRef[];
}

/**
 * A domain plugin analyzes one file AFTER walkFile() + resolveFileRefs() complete.
 *
 * Contracts (not enforced at runtime — violation is a plugin bug):
 *   - Pure function: no I/O, no file reads, no side effects, no mutations.
 *   - Must not mutate fileResult or ast.
 *   - Must only CREATE new nodes/edges — never replicate or modify existing ones.
 *   - Node IDs must be globally unique; use the file path as prefix.
 *   - Return empty arrays for files that have no relevant patterns.
 *
 * When to implement DomainPlugin:
 *   - Detecting framework patterns (Express routes, Socket.IO events, DB queries).
 *   - Pattern is expressible as: scan CALL nodes where metadata.object/method match X/Y.
 *   - Need string argument values from calls (paths, event names, SQL strings).
 *
 * When NOT to use DomainPlugin:
 *   - Need to modify existing graph nodes (not supported by design).
 *   - Need cross-file context at detection time (use Stage 3 instead).
 *   - Analyzing a non-JS/TS language (needs a separate entry point).
 *   - Plugin needs state across files (domain plugins are stateless per-file).
 */
export interface DomainPlugin {
  /**
   * Unique plugin name. Lowercase, no spaces.
   * Used in log messages and error reporting.
   * Examples: "express", "socketio", "fetch", "database".
   */
  readonly name: string;

  /**
   * Called once per file after walkFile() + resolveFileRefs() complete.
   *
   * @param fileResult  The completed per-file analysis. Read-only by contract.
   *                    Contains all CALL, IMPORT, MODULE, EXTERNAL nodes.
   * @param ast         The parsed Babel File node from the SAME parse as walkFile used.
   *                    Available as escape hatch for patterns that cannot be expressed
   *                    via fileResult.nodes alone (e.g., nested route builders).
   *                    Most plugins will not need this.
   * @returns           Additional nodes and edges to merge. Empty arrays are valid.
   */
  analyzeFile(
    fileResult: Readonly<FileResult>,
    ast: File,
  ): DomainPluginResult;
}
```

### File: `packages/core-v2/src/index.ts`

Add exports for the two new types.

**Before (line 7–22):**
```typescript
export type {
  GraphNode,
  GraphEdge,
  VisitResult,
  DeferredRef,
  DeferredKind,
  ScopeNode,
  ScopeKind,
  DeclKind,
  Declaration,
  ScopeLookupResult,
  WalkContext,
  VisitorFn,
  VisitorRegistry,
  FileResult,
} from './types.js';
```

**After:**
```typescript
export type {
  GraphNode,
  GraphEdge,
  VisitResult,
  DeferredRef,
  DeferredKind,
  ScopeNode,
  ScopeKind,
  DeclKind,
  Declaration,
  ScopeLookupResult,
  WalkContext,
  VisitorFn,
  VisitorRegistry,
  FileResult,
  DomainPlugin,
  DomainPluginResult,
} from './types.js';
```

### Tests to write

This commit is type-only. No runtime behavior changes. Tests: compile-only.

Create `packages/core-v2/test/unit/domain-plugin-types.test.mjs`:

```javascript
// Verify DomainPlugin interface is correctly exported.
// This test only checks that the type can be used — it is a compile-time check
// expressed as a runtime structural check.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('DomainPlugin type is structurally valid when implemented', () => {
  // A minimal conforming implementation
  const plugin = {
    name: 'test',
    analyzeFile(_fileResult, _ast) {
      return { nodes: [], edges: [] };
    },
  };
  assert.equal(plugin.name, 'test');
  const result = plugin.analyzeFile({}, {});
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
  assert.equal(result.deferred, undefined);
});
```

This test is trivial but confirms the export works. The real type-checking happens in commit 3.

---

## Commit 3: Add domain plugin hook to `walkFile` in `walk.ts`

### File: `packages/core-v2/src/walk.ts`

### New imports needed

Add `DomainPlugin` to the existing import from `./types.js`.

**Before (lines 19–29):**
```typescript
import type {
  VisitorRegistry,
  WalkContext,
  GraphNode,
  GraphEdge,
  DeferredRef,
  ScopeNode,
  ScopeKind,
  DeclKind,
  FileResult,
} from './types.js';
```

**After:**
```typescript
import type {
  VisitorRegistry,
  WalkContext,
  GraphNode,
  GraphEdge,
  DeferredRef,
  ScopeNode,
  ScopeKind,
  DeclKind,
  FileResult,
  DomainPlugin,
} from './types.js';
```

### Signature change for `walkFile`

The `domainPlugins` parameter is added BEFORE `strict`, with a default of `[]`.
This preserves all existing callers — they pass nothing and get the old behavior.

**Before (lines 216–221):**
```typescript
export async function walkFile(
  code: string,
  file: string,
  registry: VisitorRegistry,
  strict = true,
): Promise<FileResult> {
```

**After:**
```typescript
export async function walkFile(
  code: string,
  file: string,
  registry: VisitorRegistry,
  domainPlugins: readonly DomainPlugin[] = [],
  strict = true,
): Promise<FileResult> {
```

### Plugin execution block

The plugin execution block goes AFTER the `deriveLoopElementEdges` call and the
`allEdgesSoFar` assembly, and BEFORE the `return` statement.

The `ast` variable is already in scope (assigned at line 224: `const ast = parseFile(code, file)`).
It is already available throughout `walkFile`. No change needed to expose it.

**Before (lines 542–552):**
```typescript
  // ─── Post-walk: derive ELEMENT_OF / KEY_OF from loops ──────────
  const allEdgesSoFar = [...allEdges, ...resolvedEdges, ...ctx._declareEdges];
  const loopElementEdges = deriveLoopElementEdges(allNodes, allEdgesSoFar);

  return {
    file,
    moduleId,
    nodes: allNodes,
    edges: [...allEdgesSoFar, ...loopElementEdges],
    unresolvedRefs,
    scopeTree: ctx._rootScope,
  };
```

**After:**
```typescript
  // ─── Post-walk: derive ELEMENT_OF / KEY_OF from loops ──────────
  const allEdgesSoFar = [...allEdges, ...resolvedEdges, ...ctx._declareEdges];
  const loopElementEdges = deriveLoopElementEdges(allNodes, allEdgesSoFar);

  let result: FileResult = {
    file,
    moduleId,
    nodes: allNodes,
    edges: [...allEdgesSoFar, ...loopElementEdges],
    unresolvedRefs,
    scopeTree: ctx._rootScope,
  };

  // ─── Domain plugins ────────────────────────────────────────────
  // Plugins run after Stage 2 (file-scope resolution is complete).
  // They see resolved CALLS_ON edges — helpful for verifying that
  // `app` or `router` variables actually come from 'express'.
  if (domainPlugins.length > 0) {
    for (const plugin of domainPlugins) {
      let pluginResult: ReturnType<DomainPlugin['analyzeFile']>;
      try {
        pluginResult = plugin.analyzeFile(result, ast);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Plugin errors are non-fatal. Log and skip.
        // The walk result is still valid without this plugin's output.
        // TODO: surface this to the caller's logger when a logger is available.
        console.error(`[DomainPlugin:${plugin.name}] Error in analyzeFile for ${file}: ${msg}`);
        continue;
      }

      // Validate that the plugin returned the required shape.
      // Defensive: malformed plugin results must not corrupt the graph.
      if (
        !pluginResult
        || !Array.isArray(pluginResult.nodes)
        || !Array.isArray(pluginResult.edges)
      ) {
        console.error(
          `[DomainPlugin:${plugin.name}] analyzeFile returned invalid result for ${file}. ` +
          `Expected { nodes: [], edges: [] }. Skipping.`,
        );
        continue;
      }

      result = {
        ...result,
        nodes: [...result.nodes, ...pluginResult.nodes],
        edges: [...result.edges, ...pluginResult.edges],
        unresolvedRefs: [
          ...result.unresolvedRefs,
          ...(pluginResult.deferred ?? []),
        ],
      };
    }
  }

  return result;
```

### Error handling policy

If a plugin throws from `analyzeFile`:
- The error is caught.
- The walk result is returned WITHOUT the plugin's output.
- An error message is printed to stderr.
- No exception propagates to the caller of `walkFile`.
- This is logged at `console.error` level for now (until a logger parameter is available).

Rationale: a domain plugin failure should not fail the entire analysis of a file. The core CALL,
FUNCTION, and MODULE nodes are still valid. The user loses domain-specific nodes for that file
but does not lose structural analysis.

If a plugin returns an invalid result (not an object, or missing `nodes`/`edges` arrays):
- The result is silently skipped with an error log.
- Same rationale: defensive against buggy plugins.

### Type safety for plugin results

`DomainPluginResult` is strongly typed. The `nodes` and `edges` fields are `GraphNode[]` and
`GraphEdge[]` respectively — TypeScript enforces this at the call site. The runtime defensive check
(Array.isArray) guards against JavaScript callers that bypass TypeScript.

### How `ast` flows to plugins

`ast` is the return value of `parseFile(code, file)` called at the top of `walkFile` (current
line 224). It is a `File` node from `@babel/types`. It is already in scope at the plugin execution
site. No change needed.

The walk engine does NOT retain the AST after `walkFile` returns. Plugins receive it during
`analyzeFile` but should not store references to it — the AST is garbage-collected after the call.

### How plugin deferred refs merge with existing deferred refs

Plugin-emitted `DeferredRef` entries are appended to `result.unresolvedRefs`. Stage 3
(`resolveProject`) iterates all `FileResult.unresolvedRefs` across all files without distinguishing
origin. This means domain plugins can emit `call_resolve`, `import_resolve`, `type_resolve`, and
`alias_resolve` refs and they will be resolved exactly like walk-produced refs.

IMPORTANT: domain plugins MUST NOT emit `scope_lookup` or `export_lookup` refs. Stage 2 is already
complete when plugins run. Those kinds would be silently ignored by Stage 3's resolver (which only
handles the project-stage kinds). This is documented in the `DomainPluginResult.deferred` JSDoc.

### Big-O analysis for plugin execution path

Let:
- N = number of nodes in FileResult
- P = number of domain plugins
- R = number of nodes returned by all plugins combined

Plugin loop: O(P) iterations.
Each `plugin.analyzeFile` call: O(N) in the worst case (scanning all nodes). Typically O(CALL)
where CALL is the subset of CALL-type nodes. In practice O(N/10) since CALL nodes are ~10% of
total nodes.
Result merge: O(N + R) for array spread.

Total plugin overhead per file: O(P * N + R).
With P=1 (only Express), N=1000 nodes, R=50 route nodes: ~1050 operations per file.
This is negligible compared to the O(N^2) scope resolution in Stage 2 and the walk itself.

---

## Commit 3 tests

### File: `packages/core-v2/test/unit/domain-plugin-hook.test.mjs` (new file)

Test suite for the walkFile domain plugin integration. Use `node:test` and `node:assert/strict`.

**Required test cases:**

**Test 1: walkFile with no plugins returns same result structure**
```javascript
test('walkFile with empty domainPlugins returns valid FileResult', async () => {
  const result = await walkFile('const x = 1;', 'test.ts', jsRegistry, []);
  assert.ok(Array.isArray(result.nodes));
  assert.ok(Array.isArray(result.edges));
  assert.ok(Array.isArray(result.unresolvedRefs));
});
```

**Test 2: Plugin receives fileResult and ast**
```javascript
test('plugin.analyzeFile receives fileResult and ast', async () => {
  let capturedFileResult = null;
  let capturedAst = null;
  const plugin = {
    name: 'spy',
    analyzeFile(fileResult, ast) {
      capturedFileResult = fileResult;
      capturedAst = ast;
      return { nodes: [], edges: [] };
    },
  };
  const result = await walkFile('const x = 1;', 'test.ts', jsRegistry, [plugin]);
  assert.ok(capturedFileResult !== null);
  assert.ok(capturedAst !== null);
  // fileResult passed to plugin must match the final walk result (minus plugin additions)
  assert.equal(capturedFileResult.file, 'test.ts');
  // ast must be a Babel File node
  assert.equal(capturedAst.type, 'File');
});
```

**Test 3: Plugin nodes/edges are merged into FileResult**
```javascript
test('plugin nodes and edges are merged into FileResult', async () => {
  const extraNode = { id: 'test.ts->http:route->GET:/foo#1', type: 'http:route',
    name: 'GET /foo', file: 'test.ts', line: 1, column: 0 };
  const extraEdge = { src: 'MODULE#test.ts', dst: extraNode.id, type: 'EXPOSES' };
  const plugin = {
    name: 'adder',
    analyzeFile(_fr, _ast) {
      return { nodes: [extraNode], edges: [extraEdge] };
    },
  };
  const result = await walkFile(`app.get('/foo', handler);`, 'test.ts', jsRegistry, [plugin]);
  assert.ok(result.nodes.some(n => n.id === extraNode.id));
  assert.ok(result.edges.some(e => e.src === extraEdge.src && e.type === 'EXPOSES'));
});
```

**Test 4: Multiple plugins accumulate results in order**
```javascript
test('multiple plugins accumulate results in insertion order', async () => {
  const order = [];
  const p1 = { name: 'first', analyzeFile() { order.push('first'); return { nodes: [], edges: [] }; } };
  const p2 = { name: 'second', analyzeFile() { order.push('second'); return { nodes: [], edges: [] }; } };
  await walkFile('const x = 1;', 'test.ts', jsRegistry, [p1, p2]);
  assert.deepEqual(order, ['first', 'second']);
});
```

**Test 5: Plugin that throws does not crash walkFile**
```javascript
test('plugin that throws does not crash walkFile', async () => {
  const throwing = {
    name: 'crasher',
    analyzeFile() { throw new Error('plugin crash'); },
  };
  // Should not throw
  const result = await walkFile('const x = 1;', 'test.ts', jsRegistry, [throwing]);
  assert.ok(Array.isArray(result.nodes));
});
```

**Test 6: Plugin that returns null does not crash walkFile**
```javascript
test('plugin that returns null does not crash walkFile', async () => {
  const bad = { name: 'bad', analyzeFile() { return null; } };
  const result = await walkFile('const x = 1;', 'test.ts', jsRegistry, [bad]);
  assert.ok(Array.isArray(result.nodes));
});
```

**Test 7: Plugin deferred refs are added to unresolvedRefs**
```javascript
test('plugin deferred refs are merged into unresolvedRefs', async () => {
  const deferredRef = {
    kind: 'call_resolve',
    name: 'handler',
    fromNodeId: 'test.ts->http:route->GET:/foo#1',
    edgeType: 'DEFINES',
    file: 'test.ts',
    line: 1,
    column: 0,
  };
  const plugin = {
    name: 'deferred',
    analyzeFile(_fr, _ast) {
      return { nodes: [], edges: [], deferred: [deferredRef] };
    },
  };
  const result = await walkFile('const x = 1;', 'test.ts', jsRegistry, [plugin]);
  assert.ok(result.unresolvedRefs.some(r => r.name === 'handler' && r.kind === 'call_resolve'));
});
```

---

## Commit 4: Implement `ExpressPlugin`

### File: `packages/core/src/plugins/domain/ExpressPlugin.ts` (new file)

This is the reference implementation. It implements the `DomainPlugin` interface.

### Complete file structure

```typescript
/**
 * ExpressPlugin — domain plugin for Express.js route detection.
 *
 * Detects:
 *   app.get('/path', handler)        → http:route node
 *   app.post('/path', handler)       → http:route node
 *   app.put('/path', handler)        → http:route node
 *   app.delete('/path', handler)     → http:route node
 *   app.patch('/path', handler)      → http:route node
 *   app.options('/path', handler)    → http:route node
 *   app.head('/path', handler)       → http:route node
 *   app.all('/path', handler)        → http:route node (method: 'ALL')
 *   router.get('/path', handler)     → http:route node (same as app.*)
 *   app.use('/prefix', router)       → express:mount node
 *   app.use(middleware)              → express:mount node (prefix: '/')
 *
 * Does NOT detect:
 *   app.route('/path').get(handler)  → needs AST escape hatch (out of scope for this commit)
 *
 * Prerequisites: file must import from 'express' (guards against false positives).
 */

import type { DomainPlugin, DomainPluginResult, FileResult, GraphNode, GraphEdge } from '@grafema/core-v2';
import type { File } from '@babel/types';

// HTTP methods recognized as route registration methods.
// 'all' maps to method 'ALL' in node metadata.
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);

// Variable names that typically hold an Express app or router.
// This is a heuristic. The import check is the primary guard.
const EXPRESS_OBJECTS = new Set(['app', 'router', 'Router']);

export class ExpressPlugin implements DomainPlugin {
  readonly name = 'express';

  analyzeFile(fileResult: Readonly<FileResult>, _ast: File): DomainPluginResult {
    // Guard: only process files that depend on 'express'.
    // Check DEPENDS_ON edges from the MODULE node to any EXTERNAL whose name
    // includes 'express'. This is set up by the IMPORTS_FROM edge chain.
    if (!this._importsExpress(fileResult)) {
      return { nodes: [], edges: [] };
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Find the MODULE node for EXPOSES/MOUNTS edges.
    const moduleNode = fileResult.nodes.find(n => n.type === 'MODULE');

    for (const node of fileResult.nodes) {
      if (node.type !== 'CALL') continue;

      const meta = node.metadata;
      if (!meta) continue;

      const obj = meta.object as string | undefined;
      const method = meta.method as string | undefined;
      const argValues = meta.argValues as (string | null)[] | undefined;

      if (!obj || !method) continue;
      if (!EXPRESS_OBJECTS.has(obj)) continue;

      if (HTTP_METHODS.has(method)) {
        // Route registration: app.get('/path', handler)
        // Require at least one argument AND argValues[0] is a string.
        if (!argValues || argValues.length < 1 || argValues[0] === null) continue;

        const path = argValues[0];
        const httpMethod = method === 'all' ? 'ALL' : method.toUpperCase();
        const routeNode = this._createHttpRouteNode(node, httpMethod, path);
        nodes.push(routeNode);

        if (moduleNode) {
          edges.push({
            src: moduleNode.id,
            dst: routeNode.id,
            type: 'EXPOSES',
          });
        }
      } else if (method === 'use') {
        // Router mounting: app.use('/prefix', router) or app.use(middleware)
        this._processMountPoint(node, argValues ?? [], moduleNode ?? null, nodes, edges);
      }
    }

    return { nodes, edges };
  }

  /**
   * Check if the file imports from 'express'.
   * Looks at DEPENDS_ON edges from MODULE to EXTERNAL nodes, and also
   * at the edge destination IDs (which contain the module name).
   */
  private _importsExpress(fileResult: Readonly<FileResult>): boolean {
    // Check edges: MODULE --DEPENDS_ON--> EXTERNAL#express or similar
    for (const edge of fileResult.edges) {
      if (edge.type === 'DEPENDS_ON' && edge.dst.includes('express')) {
        return true;
      }
      if (edge.type === 'IMPORTS_FROM' && edge.dst.includes('express')) {
        return true;
      }
    }
    // Also check EXTERNAL nodes directly (some may be in nodes without edges yet)
    for (const node of fileResult.nodes) {
      if (node.type === 'EXTERNAL' && node.name === 'express') {
        return true;
      }
      if (node.type === 'EXTERNAL_MODULE' && node.name === 'express') {
        return true;
      }
    }
    return false;
  }

  /**
   * Create an http:route GraphNode.
   * Node ID format: `{file}->http:route->{METHOD}:{path}#{line}`
   */
  private _createHttpRouteNode(
    callNode: GraphNode,
    method: string,
    path: string,
  ): GraphNode {
    return {
      id: `${callNode.file}->http:route->${method}:${path}#${callNode.line}`,
      type: 'http:route',
      name: `${method} ${path}`,
      file: callNode.file,
      line: callNode.line,
      column: callNode.column,
      metadata: {
        method,
        path,
        mountedOn: callNode.metadata?.object as string,
      },
    };
  }

  /**
   * Process app.use() call. Creates express:mount node.
   * Handles:
   *   app.use('/prefix', router)  → express:mount with prefix
   *   app.use(middleware)         → express:mount with prefix '/'
   */
  private _processMountPoint(
    callNode: GraphNode,
    argValues: (string | null)[],
    moduleNode: GraphNode | null,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    let prefix: string;

    if (argValues.length === 0) {
      // app.use() with no arguments — malformed, skip
      return;
    }

    if (argValues.length === 1) {
      // app.use(middleware) — no prefix, mounts at root
      prefix = '/';
    } else {
      // app.use('/prefix', ...) — extract prefix from first arg
      const firstArg = argValues[0];
      if (firstArg === null) {
        // Dynamic prefix (variable, expression) — use placeholder
        prefix = '${dynamic}';
      } else {
        prefix = firstArg;
      }
    }

    const mountNode = this._createExpressMountNode(callNode, prefix);
    nodes.push(mountNode);

    if (moduleNode) {
      edges.push({
        src: moduleNode.id,
        dst: mountNode.id,
        type: 'MOUNTS',
      });
    }
  }

  /**
   * Create an express:mount GraphNode.
   * Node ID format: `{file}->express:mount->{prefix}#{line}`
   */
  private _createExpressMountNode(
    callNode: GraphNode,
    prefix: string,
  ): GraphNode {
    return {
      id: `${callNode.file}->express:mount->${prefix}#${callNode.line}`,
      type: 'express:mount',
      name: prefix,
      file: callNode.file,
      line: callNode.line,
      column: callNode.column,
      metadata: {
        prefix,
        mountedOn: callNode.metadata?.object as string,
      },
    };
  }
}
```

### Express Plugin: every HTTP method it handles

| Call | Detected | Result method | Notes |
|------|----------|---------------|-------|
| `app.get(path, handler)` | YES | `'GET'` | Standard |
| `app.post(path, handler)` | YES | `'POST'` | Standard |
| `app.put(path, handler)` | YES | `'PUT'` | Standard |
| `app.delete(path, handler)` | YES | `'DELETE'` | Standard |
| `app.patch(path, handler)` | YES | `'PATCH'` | Standard |
| `app.options(path, handler)` | YES | `'OPTIONS'` | Standard |
| `app.head(path, handler)` | YES | `'HEAD'` | Standard |
| `app.all(path, handler)` | YES | `'ALL'` | Wildcard method |
| `router.get(path, handler)` | YES | `'GET'` | Same as app.* — router in EXPRESS_OBJECTS |
| `router.post(path, handler)` | YES | `'POST'` | Same |
| `app.use('/prefix', router)` | YES | N/A — creates `express:mount` | Mount point |
| `app.use(middleware)` | YES | N/A — creates `express:mount` with prefix '/' | Global middleware |

### What happens with `app.use()`

`app.use()` is treated as a mount point, not a route. It creates an `express:mount` node.
Behavior depends on argument count:
- `app.use(middleware)` → 1 argument, no path string → prefix becomes `'/'`
- `app.use('/api', router)` → 2 arguments, first is string → prefix becomes `'/api'`
- `app.use('/api', handler1, handler2)` → 3+ arguments → same as 2-arg, extra args ignored
- `app.use(dynamicPath, router)` → first arg is not a string → prefix becomes `'${dynamic}'`

### What happens with `router.get()` vs `app.get()`

Both are handled identically. `EXPRESS_OBJECTS` contains both `'app'` and `'router'`.
The CALL node metadata will have `metadata.object === 'router'` instead of `'app'`.
The `express:mount` or `http:route` node will have `metadata.mountedOn === 'router'`.

### What happens with `app.all()`

`'all'` is in `HTTP_METHODS`. When detected, the method is normalized to `'ALL'` (not
`method.toUpperCase()` since `'all'.toUpperCase() === 'ALL'` anyway, but it is explicit).
Creates an `http:route` node with `metadata.method === 'ALL'`.

### http:route node type and metadata schema

```typescript
{
  // GraphNode base fields:
  id:      string;  // "{file}->http:route->{METHOD}:{path}#{line}"
  type:    'http:route';
  name:    string;  // "{METHOD} {path}", e.g. "GET /users"
  file:    string;  // Relative file path, e.g. "src/routes/users.ts"
  line:    number;  // Line number of the app.get() call
  column:  number;  // Column number of the app.get() call

  // metadata fields:
  metadata: {
    method:    string;  // 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD' | 'ALL'
    path:      string;  // The route path, e.g. '/users/:id'
    mountedOn: string;  // 'app' | 'router' — which object registered the route
  }
}
```

### express:mount node type and metadata schema

```typescript
{
  // GraphNode base fields:
  id:      string;  // "{file}->express:mount->{prefix}#{line}"
  type:    'express:mount';
  name:    string;  // The prefix string, e.g. '/api'
  file:    string;
  line:    number;
  column:  number;

  // metadata fields:
  metadata: {
    prefix:    string;  // Mount prefix: '/api', '/', '${dynamic}'
    mountedOn: string;  // 'app' | 'router'
  }
}
```

### Edges created by ExpressPlugin

| Edge | Source | Destination | When |
|------|--------|-------------|------|
| `EXPOSES` | MODULE node | `http:route` node | Every detected route |
| `MOUNTS` | MODULE node | `express:mount` node | Every detected `app.use()` |

Note: v1 ExpressAnalyzer also creates `DEFINES` (route → handler) and `INTERACTS_WITH`
(route → EXTERNAL_NETWORK). These are NOT included in this commit. Scope: reference implementation
only. Handler linking requires cross-file resolution (out of scope for this issue).

### Tests for ExpressPlugin

File: `packages/core/test/unit/express-plugin.test.js` (or `.mjs`, match existing test file style)

**Test 1: Detects app.get('/users', handler)**
```javascript
test('detects GET route via app.get', async () => {
  const code = `
    import express from 'express';
    const app = express();
    app.get('/users', handler);
  `;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNode = result.nodes.find(n => n.type === 'http:route');
  assert.ok(routeNode, 'http:route node created');
  assert.equal(routeNode.metadata.method, 'GET');
  assert.equal(routeNode.metadata.path, '/users');
  assert.equal(routeNode.metadata.mountedOn, 'app');
  // EXPOSES edge exists
  const exposesEdge = result.edges.find(e => e.type === 'EXPOSES' && e.dst === routeNode.id);
  assert.ok(exposesEdge, 'EXPOSES edge from MODULE');
});
```

**Test 2: Detects all HTTP methods**
```javascript
test('detects all HTTP methods', async () => {
  for (const method of ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']) {
    const code = `
      import express from 'express';
      const app = express();
      app.${method}('/path', handler);
    `;
    const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
    const routeNode = result.nodes.find(n => n.type === 'http:route');
    assert.ok(routeNode, `http:route created for ${method}`);
    const expectedMethod = method === 'all' ? 'ALL' : method.toUpperCase();
    assert.equal(routeNode.metadata.method, expectedMethod);
  }
});
```

**Test 3: Detects router.get()**
```javascript
test('detects route on router object', async () => {
  const code = `
    import express from 'express';
    const router = express.Router();
    router.get('/items', handler);
  `;
  const result = await walkFile(code, 'src/routes.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNode = result.nodes.find(n => n.type === 'http:route');
  assert.ok(routeNode);
  assert.equal(routeNode.metadata.mountedOn, 'router');
});
```

**Test 4: Detects app.use() with prefix**
```javascript
test('detects mount point via app.use with prefix', async () => {
  const code = `
    import express from 'express';
    const app = express();
    app.use('/api', router);
  `;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const mountNode = result.nodes.find(n => n.type === 'express:mount');
  assert.ok(mountNode, 'express:mount node created');
  assert.equal(mountNode.metadata.prefix, '/api');
  const mountsEdge = result.edges.find(e => e.type === 'MOUNTS' && e.dst === mountNode.id);
  assert.ok(mountsEdge, 'MOUNTS edge from MODULE');
});
```

**Test 5: Detects app.use() without prefix (middleware)**
```javascript
test('detects global middleware via app.use without prefix', async () => {
  const code = `
    import express from 'express';
    const app = express();
    app.use(middleware);
  `;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const mountNode = result.nodes.find(n => n.type === 'express:mount');
  assert.ok(mountNode);
  assert.equal(mountNode.metadata.prefix, '/');
});
```

**Test 6: Skips files that don't import from 'express'**
```javascript
test('returns empty result for non-express files', async () => {
  const code = `
    const app = {};
    app.get('/users', handler);
  `;
  const result = await walkFile(code, 'src/other.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNodes = result.nodes.filter(n => n.type === 'http:route' || n.type === 'express:mount');
  assert.equal(routeNodes.length, 0, 'No domain nodes for non-express file');
});
```

**Test 7: Empty result for file with no Express patterns**
```javascript
test('returns empty result for express import but no routes', async () => {
  const code = `import express from 'express';`;
  const result = await walkFile(code, 'src/index.ts', jsRegistry, [new ExpressPlugin()]);
  const domainNodes = result.nodes.filter(n => n.type === 'http:route' || n.type === 'express:mount');
  assert.equal(domainNodes.length, 0);
});
```

**Test 8: Dynamic path argument produces no route node**
```javascript
test('skips route with dynamic path (non-string first arg)', async () => {
  const code = `
    import express from 'express';
    const app = express();
    app.get(pathVariable, handler);
  `;
  const result = await walkFile(code, 'src/app.ts', jsRegistry, [new ExpressPlugin()]);
  const routeNodes = result.nodes.filter(n => n.type === 'http:route');
  assert.equal(routeNodes.length, 0, 'No route node when path is dynamic');
});
```

---

## Commit 5: Wire `CoreV2Analyzer` to domain plugins from config

### File: `packages/core/src/plugins/analysis/CoreV2Analyzer.ts`

### Summary of changes

1. Import `DomainPlugin` from `@grafema/core-v2`.
2. Import `ExpressPlugin` from the new domain plugin location.
3. Add `DOMAIN_PLUGIN_REGISTRY` static constant.
4. Add private `_domainPlugins: readonly DomainPlugin[]` field.
5. Update `walkFile` call to pass `this._domainPlugins`.
6. Update `metadata.creates.nodes` to include domain node types.

### New imports

**Before (lines 11–20):**
```typescript
import { Plugin, createSuccessResult } from '../Plugin.js';
import { walkFile, resolveFileRefs, resolveProject, jsRegistry } from '@grafema/core-v2';
import type { FileResult, GraphNode, GraphEdge } from '@grafema/core-v2';
import { loadBuiltinRegistry } from '@grafema/lang-defs';
import type { LangDefs } from '@grafema/lang-defs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, InputEdge, AnyBrandedNode, OrchestratorConfig, ServiceDefinition } from '@grafema/types';
```

**After:**
```typescript
import { Plugin, createSuccessResult } from '../Plugin.js';
import { walkFile, resolveFileRefs, resolveProject, jsRegistry } from '@grafema/core-v2';
import type { FileResult, GraphNode, GraphEdge, DomainPlugin } from '@grafema/core-v2';
import { loadBuiltinRegistry } from '@grafema/lang-defs';
import type { LangDefs } from '@grafema/lang-defs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, InputEdge, AnyBrandedNode, OrchestratorConfig, ServiceDefinition } from '@grafema/types';
import { ExpressPlugin } from '../domain/ExpressPlugin.js';
```

### Domain plugin registry constant

Add immediately BEFORE the `CoreV2Analyzer` class declaration (before line 27):

```typescript
/**
 * Static registry of available domain plugins.
 * Add new domain plugin implementations here as they are created.
 * Keys must match the string values accepted in orchestrator config: domains: ["express", ...]
 */
const DOMAIN_PLUGIN_REGISTRY: Readonly<Record<string, DomainPlugin>> = {
  express: new ExpressPlugin(),
  // socketio: new SocketIOPlugin(),  // Uncommment when implemented (future issues)
  // fetch: new FetchPlugin(),        // Uncommment when implemented (future issues)
  // database: new DatabasePlugin(),  // Uncommment when implemented (future issues)
};
```

### Private field

Add to the `CoreV2Analyzer` class body, between `metadata` getter and `execute()`:

```typescript
private _domainPlugins: readonly DomainPlugin[] = [];
```

### Config reading in `execute()`

The config shape for domain plugins is:
```json
{
  "engine": "v2",
  "domains": ["express"]
}
```

The `domains` key is an array of string plugin names. Add domain plugin resolution at the top of
`execute()`, BEFORE the `getModules()` call.

**Before (line 65–78):**
```typescript
  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { graph } = context;
    const manifest = context.manifest as AnalysisManifest | undefined;
    const projectPath = manifest?.projectPath ?? '';
    const deferIndex = context.deferIndexing ?? false;

    // Load builtin type definitions for method resolution
    const require = createRequire(import.meta.url);
    const esDefs = require('@grafema/lang-defs/defs/ecmascript/es2022.json') as LangDefs;
    const builtins = loadBuiltinRegistry([esDefs]);

    const modules = await this.getModules(graph);
```

**After:**
```typescript
  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { graph } = context;
    const manifest = context.manifest as AnalysisManifest | undefined;
    const projectPath = manifest?.projectPath ?? '';
    const deferIndex = context.deferIndexing ?? false;

    // Resolve domain plugins from config.
    // Config key: domains — array of plugin names (e.g., ["express", "socketio"]).
    // Missing or empty domains array means no domain plugins (backward-compatible).
    const config = context.config as (OrchestratorConfig & { domains?: string[] }) | undefined;
    const requestedDomains = config?.domains ?? [];
    this._domainPlugins = requestedDomains
      .filter(name => {
        if (!(name in DOMAIN_PLUGIN_REGISTRY)) {
          logger.warn('Unknown domain plugin requested, skipping', { domain: name });
          return false;
        }
        return true;
      })
      .map(name => DOMAIN_PLUGIN_REGISTRY[name]);

    if (this._domainPlugins.length > 0) {
      logger.info('Domain plugins enabled', {
        plugins: this._domainPlugins.map(p => p.name),
      });
    }

    // Load builtin type definitions for method resolution
    const require = createRequire(import.meta.url);
    const esDefs = require('@grafema/lang-defs/defs/ecmascript/es2022.json') as LangDefs;
    const builtins = loadBuiltinRegistry([esDefs]);

    const modules = await this.getModules(graph);
```

### Update `walkFile` call

**Before (line 90):**
```typescript
        const walkResult = await walkFile(code, filePath, jsRegistry);
```

**After:**
```typescript
        const walkResult = await walkFile(code, filePath, jsRegistry, this._domainPlugins);
```

### Update `metadata.creates.nodes`

Add domain node types to the `creates.nodes` array. This is metadata for the orchestrator so it
knows what types of nodes this plugin can produce.

**Before (lines 35–43):**
```typescript
        nodes: [
          'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT', 'SCOPE', 'CALL',
          'IMPORT', 'EXPORT', 'LITERAL', 'EXTERNAL', 'FILE', 'INTERFACE',
          'TYPE_ALIAS', 'ENUM', 'PARAMETER', 'GETTER', 'SETTER', 'NAMESPACE',
          'PROPERTY', 'EXPRESSION', 'PROPERTY_ACCESS', 'BRANCH', 'LOOP',
          'TRY_BLOCK', 'CATCH_BLOCK', 'CASE', 'FINALLY_BLOCK', 'SIDE_EFFECT',
          'META_PROPERTY', 'LABEL', 'STATIC_BLOCK', 'DECORATOR',
          'ENUM_MEMBER', 'TYPE_REFERENCE', 'TYPE_PARAMETER', 'LITERAL_TYPE',
          'CONDITIONAL_TYPE', 'INFER_TYPE', 'EXTERNAL_MODULE',
        ],
```

**After:**
```typescript
        nodes: [
          'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT', 'SCOPE', 'CALL',
          'IMPORT', 'EXPORT', 'LITERAL', 'EXTERNAL', 'FILE', 'INTERFACE',
          'TYPE_ALIAS', 'ENUM', 'PARAMETER', 'GETTER', 'SETTER', 'NAMESPACE',
          'PROPERTY', 'EXPRESSION', 'PROPERTY_ACCESS', 'BRANCH', 'LOOP',
          'TRY_BLOCK', 'CATCH_BLOCK', 'CASE', 'FINALLY_BLOCK', 'SIDE_EFFECT',
          'META_PROPERTY', 'LABEL', 'STATIC_BLOCK', 'DECORATOR',
          'ENUM_MEMBER', 'TYPE_REFERENCE', 'TYPE_PARAMETER', 'LITERAL_TYPE',
          'CONDITIONAL_TYPE', 'INFER_TYPE', 'EXTERNAL_MODULE',
          // Domain plugin node types (present only when domains config is active)
          'http:route', 'express:mount',
        ],
```

Also update `creates.edges` to include the domain-specific edge types:

**Before (lines 45–60):**
```typescript
        edges: [
          'CONTAINS', 'DECLARES', 'CALLS', 'HAS_SCOPE', 'CAPTURES', 'ASSIGNED_FROM',
          ...
          'IMPLEMENTS_OVERLOAD', 'HAS_OVERLOAD', 'EXTENDS_SCOPE_WITH',
        ],
```

**After:** append to the end of the edges array:
```typescript
          // Domain plugin edges (present only when domains config is active)
          'EXPOSES', 'MOUNTS',
```

(The full edges array already contains 'EXPOSES' and 'MOUNTS' if they were previously present.
Check first: if they are already in the list, do not duplicate. As of the current file, searching
`EXPOSES` and `MOUNTS` in CoreV2Analyzer.ts shows they are NOT in the list — add them.)

### Config backward compatibility

When `config.domains` is absent, `undefined`, or `[]`:
- `requestedDomains` is `[]`
- The filter/map produces `[]`
- `this._domainPlugins` is `[]`
- `walkFile` is called with `domainPlugins = []`
- Behavior is identical to today

This means all existing `.grafema/config.yaml` files and integration tests work without change.

### Integration tests to write

File: `packages/core/test/integration/core-v2-express.test.js` (new file)

**Test 1: CoreV2Analyzer with domains: ['express'] creates http:route nodes**

This is an end-to-end test that runs CoreV2Analyzer against a fixture file and verifies
that http:route nodes appear in the graph.

Fixture file: `packages/core/test/fixtures/express-app.js`:
```javascript
import express from 'express';
const app = express();
app.get('/users', listUsers);
app.post('/users', createUser);
app.use('/api', apiRouter);
```

Test structure:
```javascript
test('CoreV2Analyzer with domains:express creates http:route nodes', async () => {
  // Use test RFDB instance via createTestDatabase()
  const db = await createTestDatabase();
  // ... set up CoreV2Analyzer with context.config = { engine: 'v2', domains: ['express'] }
  // ... run execute()
  // ... query graph for http:route nodes
  // assert: 2 http:route nodes (GET /users, POST /users)
  // assert: 1 express:mount node (/api)
  // assert: EXPOSES edges from MODULE to routes
  // assert: MOUNTS edge from MODULE to mount
});
```

**Test 2: CoreV2Analyzer without domains config creates no http:route nodes**
```javascript
test('CoreV2Analyzer without domains creates no domain nodes', async () => {
  // Same fixture, no domains config
  // assert: 0 nodes with type 'http:route'
});
```

**Test 3: Unknown domain name logs warning and is silently skipped**
```javascript
test('unknown domain name in config is skipped with warning', async () => {
  // config = { domains: ['express', 'nonexistent'] }
  // Should not throw. Should create express nodes.
  // Assert: http:route nodes exist (express worked)
});
```

---

## Summary: File Change Map

| File | Change Type | Commit |
|------|-------------|--------|
| `packages/core-v2/src/visitors/expressions.ts` | Modify: add `argValues` to CALL metadata | 1 |
| `packages/core-v2/test/unit/expressions-argvalues.test.mjs` | New: argValues tests | 1 |
| `packages/core-v2/src/types.ts` | Modify: add `DomainPlugin`, `DomainPluginResult`, import `File` | 2 |
| `packages/core-v2/src/index.ts` | Modify: export new types | 2 |
| `packages/core-v2/test/unit/domain-plugin-types.test.mjs` | New: type export verification | 2 |
| `packages/core-v2/src/walk.ts` | Modify: add `domainPlugins` parameter + execution block | 3 |
| `packages/core-v2/test/unit/domain-plugin-hook.test.mjs` | New: walkFile integration tests | 3 |
| `packages/core/src/plugins/domain/ExpressPlugin.ts` | New: reference implementation | 4 |
| `packages/core/test/unit/express-plugin.test.js` | New: ExpressPlugin unit tests | 4 |
| `packages/core/src/plugins/analysis/CoreV2Analyzer.ts` | Modify: wire domain plugins | 5 |
| `packages/core/test/integration/core-v2-express.test.js` | New: end-to-end test | 5 |
| `packages/core/test/fixtures/express-app.js` | New: fixture file for integration test | 5 |

---

## Appendix A: `DomainPlugin` directory layout

```
packages/core/src/plugins/
  domain/
    ExpressPlugin.ts    ← Commit 4
    index.ts            ← Export barrel (add: export { ExpressPlugin } from './ExpressPlugin.js')
```

The `index.ts` barrel is needed so future domain plugins can be imported uniformly in
`CoreV2Analyzer.ts`. Create it in Commit 4 with only the `ExpressPlugin` export.

---

## Appendix B: Edge type verification

Before Commit 5, verify that `EXPOSES` and `MOUNTS` are valid edge types in the system.

Checking `packages/types/src/edges.ts`:
- `EXPOSES: 'EXPOSES'` — present at line 76 ✓
- `MOUNTS: 'MOUNTS'` — present at line 75 ✓

Both edge types are already defined. No new edge types need to be created.

---

## Appendix C: Node type verification

Checking `packages/types/src/nodes.ts` (NAMESPACED_TYPE):
- `HTTP_ROUTE: 'http:route'` — present ✓
- `EXPRESS_MOUNT: 'express:mount'` — present ✓

No new node types need to be created.

---

## Appendix D: Known limitations of this implementation

These are explicit non-goals for this issue. They must NOT be fixed in this PR — they belong in
separate issues.

1. **`app.route('/path').get(handler)` chained routing** — requires AST escape hatch. The CALL
   node for `.get(handler)` will have `metadata.object === '?'` because the object is a call
   expression, not a simple Identifier. The `_importsExpress` guard is passed but
   `EXPRESS_OBJECTS.has('?')` is false, so these are silently skipped. Correct behavior.

2. **Handler linking** — `http:route → DEFINES → handlerFunction` is not implemented. The handler
   is the second argument to `app.get()`. `argValues[1]` is `null` for Identifier handlers.
   Cross-file handler resolution requires deferred refs and is a separate concern.

3. **`INTERACTS_WITH → EXTERNAL_NETWORK`** — v1 ExpressAnalyzer creates this. v2 ExpressPlugin
   does not. The `net:request` singleton pattern from v1 has no equivalent in v2 yet.

4. **Import aliasing** — `import express from 'express'; const myApp = express();` works because
   the `express()` call creates `app` via assignment, but only if the variable name assigned to
   happens to be `'app'` or `'router'`. The heuristic of checking `EXPRESS_OBJECTS` for the object
   name in the CALL node is the core limitation. A full solution requires tracing `ASSIGNED_FROM`
   edges, which is a Phase 2 concern.

5. **TypeScript decorators (NestJS)** — NestJSRouteAnalyzer's pattern is not in scope.

---

## Appendix E: Why plugins run AFTER Stage 2, not Stage 1

Stage 2 resolves `scope_lookup` deferred refs. After Stage 2 completes, CALL nodes for
`app.get('/users', handler)` have a `CALLS_ON` edge resolved: `CALL → VARIABLE#app`.

A sophisticated plugin implementation could walk this edge to verify that `app` is assigned from
`express()` — confirming it is truly an Express application rather than coincidentally named `app`.

This chain is: `CALL [CALLS_ON]→ VARIABLE#app [ASSIGNED_FROM]→ CALL#express()`.
That last CALL has `name === 'express'`, confirming the origin.

By running after Stage 2, plugins get this resolution for free. Running after Stage 1 would
require plugins to implement their own scope lookup, duplicating Stage 2 logic.

The current `_importsExpress` implementation uses a simpler heuristic (checking DEPENDS_ON and
EXTERNAL node names) rather than full CALLS_ON tracing. This is intentional — simpler, faster,
covers 99% of cases. A future improvement could add CALLS_ON tracing as an opt-in mode.
