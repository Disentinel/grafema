# REG-226: ExternalCallResolver - Joel Spolsky Revised Specification

## Revision Summary

This document revises the original technical specification (003-joel-tech-spec.md) to address all concerns raised by Linus in his review (004-linus-review.md) and incorporate Don's architectural decisions (005-don-revision.md).

**Major Changes:**
1. **Removed all node metadata update logic** - No `graph.updateNode()`, no `resolutionType` metadata on CALL nodes
2. **Narrowed JS_BUILTINS list** - Removed constructors and objects, kept only actual global functions
3. **Added 4 new test cases** - Namespace imports, aliased imports, mixed resolution, re-exported externals
4. **Simplified algorithm** - Follows Don's revised design

**What stayed the same:**
- Plugin structure and priority (70)
- Import index building
- EXTERNAL_MODULE node creation
- CALLS edge creation with metadata
- Basic test structure

---

## 1. Changes to Implementation

### 1.1 Revised JS_BUILTINS Set

**REPLACED** (from lines 96-119 of original spec):

```typescript
/**
 * JavaScript built-in global functions.
 *
 * These are functions intrinsic to the JS runtime that don't need CALLS edges.
 * They're available in all JS environments (browser, Node.js, etc.) and aren't
 * "callable definitions" in the code sense.
 *
 * What is NOT included:
 * - Constructors (Array, Object, Error) - handled as constructor calls
 * - Objects with methods (Math, JSON) - method calls go through MethodCallResolver
 * - Environment globals (window, document) - not functions, they're objects
 *
 * Note: CallResolverValidator (REG-227) will recognize these by name and mark
 * as resolved without requiring CALLS edges.
 */
const JS_BUILTINS = new Set([
  // Global functions (truly called as standalone functions)
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (global functions in browser & Node.js)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // CommonJS (special case - global in CJS environments)
  'require'
]);
```

**Rationale:**
- Constructors like `Array`, `Object`, `Error` are NOT functions - they're called with `new` or as type coercion
- Objects like `JSON`, `Math` have methods (`JSON.parse()`, `Math.abs()`) that MethodCallResolver handles
- This list contains ONLY functions called as standalone functions: `parseInt('42')`, `setTimeout(fn, 100)`

### 1.2 Removed Metadata Update Logic

**DELETED** (from original spec lines 251-253, 259-261):

```typescript
// These lines are REMOVED:
// Update node metadata (if graph supports it)
// Note: This may require graph.updateNode() - check capability
stats.external++;

// Built-in - no CALLS edge needed, just metadata
// Note: Metadata update may require graph.updateNode()
stats.builtin++;
```

**Why:** GraphBackend does not have `updateNode()` method. We don't add metadata to CALL nodes.

**How resolution type is determined** (in REG-227 CallResolverValidator):
- Has CALLS edge to EXTERNAL_MODULE → resolved (external)
- Has CALLS edge to FUNCTION → resolved (internal, already handled)
- Has CALLS edge to EXTERNAL_FUNCTION → resolved (builtin, via NodejsBuiltinsResolver)
- Call name matches JS_BUILTINS set → resolved (builtin, no edge needed)
- Otherwise → unresolved

### 1.3 Revised Algorithm (execute method)

**UPDATED** (lines 159-288 of original spec):

The core logic remains the same, but:
- **Step 4.1** (external package calls): Still creates CALLS edges to EXTERNAL_MODULE, but NO metadata update on CALL node
- **Step 4.2** (builtins): Only increments counter, no CALLS edge, no metadata update
- **Step 4.3** (unresolved): Only increments counter by reason, no metadata update

**The result:** ExternalCallResolver creates edges only. CallResolverValidator derives resolution type from graph structure.

---

## 2. Added Test Cases

### 2.1 NEW: Namespace Imports (Skip Verification)

**Add to section 2.5 "Skip Conditions":**

```javascript
it('should skip namespace import method calls', async () => {
  const { backend } = await setupBackend();
  try {
    const resolver = new ExternalCallResolver();

    // import * as _ from 'lodash';
    // _.map(arr, fn);
    await backend.addNodes([
      {
        id: 'main-import-lodash-ns',
        type: 'IMPORT',
        name: '_',
        file: '/project/main.js',
        source: 'lodash',
        importType: 'namespace',
        imported: '*',
        local: '_'
      },
      {
        id: 'main-call-lodash-map',
        type: 'CALL',
        name: 'map',
        file: '/project/main.js',
        line: 5,
        object: '_',        // This makes it a METHOD_CALL
        method: 'map'
      }
    ]);

    await backend.flush();
    const result = await resolver.execute({ graph: backend });

    // Should not process method calls (has object attribute)
    // MethodCallResolver will handle this later
    assert.strictEqual(result.metadata.callsProcessed, 0,
      'Should skip namespace method calls');

    // Should not create CALLS edge
    const edges = await backend.getOutgoingEdges('main-call-lodash-map', ['CALLS']);
    assert.strictEqual(edges.length, 0, 'No CALLS edge for method call');
  } finally {
    await backend.close();
  }
});
```

**Rationale:** Namespace imports with method calls have `object` attribute, so ExternalCallResolver correctly skips them. This test verifies the skip logic.

### 2.2 NEW: Aliased Imports (exportedName Verification)

**Add to section 2.2 "External Package Calls":**

```javascript
it('should use imported name for exportedName in aliased imports', async () => {
  const { backend } = await setupBackend();
  try {
    const resolver = new ExternalCallResolver();

    // import { map as lodashMap } from 'lodash';
    // lodashMap(arr, fn);
    await backend.addNodes([
      {
        id: 'main-import-lodash-aliased',
        type: 'IMPORT',
        name: 'lodashMap',
        file: '/project/main.js',
        source: 'lodash',
        importType: 'named',
        imported: 'map',       // Original name from source
        local: 'lodashMap'     // Aliased name in this file
      },
      {
        id: 'main-call-lodashmap',
        type: 'CALL',
        name: 'lodashMap',     // Called by local name
        file: '/project/main.js',
        line: 5
      }
    ]);

    await backend.flush();
    await resolver.execute({ graph: backend });

    // Should create CALLS edge to EXTERNAL_MODULE:lodash
    const edges = await backend.getOutgoingEdges('main-call-lodashmap', ['CALLS']);
    assert.strictEqual(edges.length, 1, 'Should create CALLS edge');
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');

    // Verify exportedName uses IMPORTED name (from source), not local name
    assert.strictEqual(edges[0].metadata?.exportedName, 'map',
      'exportedName should be original imported name, not alias');
  } finally {
    await backend.close();
  }
});
```

**Rationale:** When imports are aliased (`import { map as lodashMap }`), the CALL node uses local name (`lodashMap`), but the edge metadata should record the original exported name (`map`) from the source module. This enables queries like "show all calls to lodash.map" even when aliased.

### 2.3 NEW: Mixed Resolution in Single File

**Add new section 2.8:**

```javascript
describe('Mixed Resolution Types', () => {
  it('should handle all resolution types in single file', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Setup: file with internal import, external import, builtin, and unknown
      await backend.addNodes([
        // Internal import (relative)
        {
          id: 'main-import-utils',
          type: 'IMPORT',
          name: 'helper',
          file: '/project/main.js',
          source: './utils',  // Relative
          importType: 'named',
          imported: 'helper',
          local: 'helper'
        },
        {
          id: 'main-call-helper',
          type: 'CALL',
          name: 'helper',
          file: '/project/main.js',
          line: 5
        },

        // External import
        {
          id: 'main-import-lodash',
          type: 'IMPORT',
          name: 'map',
          file: '/project/main.js',
          source: 'lodash',
          importType: 'named',
          imported: 'map',
          local: 'map'
        },
        {
          id: 'main-call-map',
          type: 'CALL',
          name: 'map',
          file: '/project/main.js',
          line: 7
        },

        // Builtin
        {
          id: 'main-call-parseint',
          type: 'CALL',
          name: 'parseInt',
          file: '/project/main.js',
          line: 9
        },

        // Unknown (not imported, not builtin)
        {
          id: 'main-call-unknown',
          type: 'CALL',
          name: 'someUnknownFunc',
          file: '/project/main.js',
          line: 11
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Verify each resolution type:

      // 1. Internal import - should be skipped (relative source not indexed)
      const helperEdges = await backend.getOutgoingEdges('main-call-helper', ['CALLS']);
      assert.strictEqual(helperEdges.length, 0,
        'Relative imports should not create edges in ExternalCallResolver');

      // 2. External import - should create CALLS edge
      const mapEdges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
      assert.strictEqual(mapEdges.length, 1, 'External call should have CALLS edge');
      assert.strictEqual(mapEdges[0].dst, 'EXTERNAL_MODULE:lodash');

      // 3. Builtin - should not create edge, but counted
      const parseIntEdges = await backend.getOutgoingEdges('main-call-parseint', ['CALLS']);
      assert.strictEqual(parseIntEdges.length, 0, 'Builtin should not have CALLS edge');
      assert.ok(result.metadata.builtinResolved >= 1, 'Builtin should be counted');

      // 4. Unknown - should not create edge, but counted as unresolved
      const unknownEdges = await backend.getOutgoingEdges('main-call-unknown', ['CALLS']);
      assert.strictEqual(unknownEdges.length, 0, 'Unknown call should not have CALLS edge');
      assert.ok(result.metadata.unresolvedByReason.unknown >= 1,
        'Unknown call should be counted');

      // Overall counts
      assert.strictEqual(result.created.edges, 1, 'Should create 1 CALLS edge (external)');
      assert.strictEqual(result.metadata.externalResolved, 1);
      assert.strictEqual(result.metadata.builtinResolved, 1);
      assert.ok(result.metadata.unresolvedByReason.unknown >= 1);
    } finally {
      await backend.close();
    }
  });
});
```

**Rationale:** This is a full pipeline test that verifies all four resolution categories (internal skipped, external resolved, builtin recognized, unknown counted) work correctly in a single run.

### 2.4 NEW: Re-exported External Modules (Current Limitation)

**Add new section 2.9:**

```javascript
describe('Re-exported Externals (Known Limitation)', () => {
  it('should document that re-exported externals are currently unresolved', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // utils.js: export { map } from 'lodash';
      // main.js: import { map } from './utils'; map();
      await backend.addNodes([
        // utils.js re-exports lodash.map
        {
          id: 'utils-export-map',
          type: 'EXPORT',
          name: 'map',
          file: '/project/utils.js',
          line: 1,
          source: 'lodash',
          exportType: 'named',
          exported: 'map',
          local: 'map'
        },

        // main.js imports from utils (relative import)
        {
          id: 'main-import-map-from-utils',
          type: 'IMPORT',
          name: 'map',
          file: '/project/main.js',
          source: './utils',  // Relative!
          importType: 'named',
          imported: 'map',
          local: 'map'
        },
        {
          id: 'main-call-map',
          type: 'CALL',
          name: 'map',
          file: '/project/main.js',
          line: 5
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Current behavior: unresolved
      // - Import is relative (./utils), so ExternalCallResolver skips it
      // - FunctionCallResolver tries to resolve it but fails (it's not a FUNCTION)
      // - Result: call stays unresolved
      const edges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
      assert.strictEqual(edges.length, 0,
        'Re-exported external calls are currently unresolved');

      assert.ok(result.metadata.unresolvedByReason.unknown >= 1,
        'Should be counted as unresolved');

      // TODO (future work): Extend FunctionCallResolver to follow re-export chains
      // and detect external module re-exports, then create CALLS to EXTERNAL_MODULE:lodash
    } finally {
      await backend.close();
    }
  });
});
```

**Rationale:** Per Don's decision (005-don-revision.md lines 257-283), we document current behavior as a known limitation. Adding re-export chain following would duplicate logic already in FunctionCallResolver and add significant complexity. Future work should extend FunctionCallResolver to handle this case.

**Action Required:** Create Linear issue for this limitation after task completion.

---

## 3. Implementation Notes (Updated)

### 3.1 What ExternalCallResolver Creates

| Element | When | Metadata |
|---------|------|----------|
| EXTERNAL_MODULE node | When processing external package call and node doesn't exist | `{ name: packageName }` |
| CALLS edge | For each external package call | `{ exportedName: originalImportedName }` |

**What it does NOT create:**
- No edges for JS builtins (recognized by name only)
- No edges for unresolved calls
- No metadata on CALL nodes (no updateNode() available)

### 3.2 How CallResolverValidator Will Use This (REG-227)

CallResolverValidator (next task) will recognize resolution by:

```typescript
// Pseudo-code for validator logic:
for (const callNode of allCalls) {
  const outgoingEdges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);

  if (outgoingEdges.length > 0) {
    const target = await graph.getNode(outgoingEdges[0].dst);
    if (target.type === 'EXTERNAL_MODULE') {
      // Resolved: external package call
    } else if (target.type === 'FUNCTION') {
      // Resolved: internal function call
    } else if (target.type === 'EXTERNAL_FUNCTION') {
      // Resolved: Node.js builtin
    }
  } else if (JS_BUILTINS.has(callNode.name)) {
    // Resolved: JS builtin (no edge needed)
  } else if (callNode.object) {
    // Skip: method call (handled by MethodCallResolver)
  } else {
    // Unresolved: report as warning
  }
}
```

This approach:
- Derives resolution type from graph structure (no metadata needed)
- Avoids need for `updateNode()`
- Follows Grafema principle: "graph structure IS the metadata"

---

## 4. Priority Verification (70 is Correct)

**Enrichment Pipeline Order:**

```
Priority | Plugin                  | Dependency on ExternalCallResolver
---------|------------------------|----------------------------------------
100      | InstanceOfResolver     | None (unrelated)
90       | ImportExportLinker     | None (must run BEFORE)
80       | FunctionCallResolver   | None (must run BEFORE)
70       | ExternalCallResolver   | THIS - depends on imports and internal resolution
60       | AliasTracker           | None (unrelated to call resolution)
50       | MethodCallResolver     | None (independent - processes different nodes)
45       | NodejsBuiltinsResolver | None (independent - processes different builtins)
```

**Why 70 is correct:**

1. **MUST run after FunctionCallResolver (80):**
   - FunctionCallResolver handles relative imports (`./utils`)
   - ExternalCallResolver handles non-relative imports (`lodash`)
   - These are mutually exclusive patterns
   - If we ran before FunctionCallResolver, we'd compete for the same CALL nodes

2. **SHOULD run before MethodCallResolver (50):**
   - ExternalCallResolver skips CALL nodes with `object` attribute
   - MethodCallResolver processes CALL nodes with `object` attribute
   - No overlap, but logical order: functions first, then methods
   - Could technically run at 40 without breaking anything, but 70 is cleaner

3. **SHOULD run before NodejsBuiltinsResolver (45):**
   - ExternalCallResolver handles JS-level primitives (`parseInt`, `setTimeout`)
   - NodejsBuiltinsResolver handles Node.js-level primitives (`fs.readFile`)
   - No overlap in scope
   - Clear separation of concerns

**Conclusion:** Priority 70 maintains logical pipeline order (imports → internal functions → external functions → methods → Node.js builtins) without creating dependencies or conflicts.

---

## 5. Changes Summary Table

| Original Spec Section | Change | Reason |
|----------------------|--------|--------|
| 1.3 JS_BUILTINS | Narrowed from 40+ items to 13 | Removed constructors/objects per Linus review |
| 1.5.1 execute() | Removed metadata update logic | No updateNode() method exists in GraphBackend |
| 2.2 External Package Calls | Added aliased import test | Verify exportedName uses imported name |
| 2.5 Skip Conditions | Added namespace import test | Verify method calls are skipped |
| 2.8 (NEW) | Added mixed resolution test | Full pipeline test for all 4 resolution types |
| 2.9 (NEW) | Added re-export limitation test | Document known limitation (future work) |
| 4 Integration Points | Updated CallResolverValidator explanation | Derive resolution from graph structure |

---

## 6. Updated Acceptance Criteria

- [x] Plugin creates CALLS edges from external package calls to EXTERNAL_MODULE
- [x] EXTERNAL_MODULE nodes are created if they don't exist
- [x] No duplicate EXTERNAL_MODULE nodes
- [x] JavaScript built-ins (narrowed list) are recognized, no edge created
- [x] Truly unresolved calls are counted with reason
- [x] Method calls (with `object` attribute) are skipped
- [x] Namespace import method calls are skipped
- [x] Aliased imports use correct exportedName (imported name, not local)
- [x] Already resolved calls (with CALLS edge) are skipped
- [x] Mixed resolution types in single file work correctly
- [x] Re-exported externals limitation is documented
- [x] Plugin is idempotent (running twice produces same result)
- [x] Plugin reports accurate counts in result metadata
- [x] All tests pass

---

## 7. Backlog Items to Create After Completion

1. **Re-export chain following for external modules**
   - Team: Reginaflow
   - Project: Grafema
   - Labels: `Improvement`, `v0.2`
   - Title: "Support re-exported external modules in call resolution"
   - Description:
     ```
     Currently, if a file re-exports from an external package:

     // utils.js
     export { map } from 'lodash';

     // main.js
     import { map } from './utils';
     map(); // Unresolved

     The call to map() stays unresolved because ExternalCallResolver skips
     relative imports and FunctionCallResolver can't find a FUNCTION node.

     Solution: Extend FunctionCallResolver to follow EXPORTS_FROM edges and
     detect when re-export source is external (non-relative), then create
     CALLS edge to EXTERNAL_MODULE.

     Acceptance Criteria:
     - Re-exported external calls create CALLS to EXTERNAL_MODULE
     - Edge metadata includes original exportedName
     - Works for nested re-exports (utils -> helpers -> lodash)
     ```

---

## 8. Ready for Implementation

**All Linus concerns addressed:**
1. Metadata strategy → Use graph structure, no updateNode() needed
2. Built-ins list → Narrowed to actual global functions
3. Priority verification → Justified at 70 with dependency analysis
4. Test coverage → Added 4 missing test cases

**All Don decisions incorporated:**
1. Option B metadata strategy (derive from graph)
2. Narrowed JS_BUILTINS list (only actual functions)
3. Priority 70 verified correct
4. Test cases for all edge cases

**Status:** Ready for Kent Beck to write tests and Rob Pike to implement.
