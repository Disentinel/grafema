# REG-226: ExternalCallResolver - Don Melton Plan

## Summary

ExternalCallResolver is an enrichment plugin to handle the remaining unresolved CALL_SITE nodes after FunctionCallResolver runs. It categorizes and annotates calls that cannot be resolved to internal function definitions:

1. **External package calls** (lodash, react, etc.) - create CALLS edge to EXTERNAL_MODULE
2. **JavaScript built-in calls** (parseInt, setTimeout) - add metadata, no edge
3. **Truly unresolved calls** (dynamic, aliased) - add metadata with reason

## Context from Existing Architecture

### Call Resolution Pipeline (Priority Order)
```
90: ImportExportLinker     - creates IMPORTS_FROM edges
80: FunctionCallResolver   - resolves imported internal function calls
70: ExternalCallResolver   - THIS TASK (handles external + built-in + unresolved)
50: MethodCallResolver     - resolves method calls (obj.method())
45: NodejsBuiltinsResolver - resolves Node.js builtin module calls (fs.readFile)
```

### Key Observations

1. **FunctionCallResolver skips external imports** (lines 76-78):
   ```typescript
   const isRelative = imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'));
   if (!isRelative) continue;
   ```
   This is correct - ExternalCallResolver is designed to handle these.

2. **NodejsBuiltinsResolver already handles Node.js builtins** (fs, path, http, etc.):
   - Creates EXTERNAL_MODULE nodes for builtin modules
   - Creates EXTERNAL_FUNCTION nodes for specific builtin function calls
   - Creates CALLS edges from CALL to EXTERNAL_FUNCTION
   - Priority 45, runs AFTER ExternalCallResolver

3. **EXTERNAL_MODULE nodes exist** for external imports via NodeFactory.createExternalModule():
   - ID format: `EXTERNAL_MODULE:{source}` (e.g., `EXTERNAL_MODULE:lodash`)
   - Created during analysis phase by GraphBuilder

4. **CallResolverValidator uses Datalog** to find unresolved calls:
   ```
   violation(X) :- node(X, "CALL"), \+ attr(X, "object", _), \+ edge(X, _, "CALLS").
   ```
   This finds CALL nodes without "object" (not method calls) that have no CALLS edge.

## Design Decisions

### 1. Scope Clarification: JS Built-ins vs Node.js Builtins

**Critical distinction:**
- **JavaScript built-ins** (this task): Global functions like `parseInt`, `setTimeout` - available in any JS runtime
- **Node.js builtins** (REG-218): Module-specific like `fs.readFile`, `path.join` - require import

ExternalCallResolver handles **JavaScript built-ins only**. NodejsBuiltinsResolver handles Node.js builtins.

### 2. Resolution Strategy

For each unresolved CALL_SITE (no CALLS edge, no object attribute):

```
1. Does call name match an IMPORT from external module?
   YES:
     - Find/Create EXTERNAL_MODULE node
     - Create CALLS edge with exportedName metadata
     - Set resolutionType='external' on CALL node

2. NO: Is call name a JavaScript built-in?
   YES:
     - Set resolutionType='builtin' on CALL node
     - NO CALLS edge (built-ins are intrinsic, not callable definitions)

3. NO: Analyze why unresolved
   - Check if name matches aliased variable -> reason='alias'
   - Check if callee is computed/dynamic -> reason='dynamic'
   - Otherwise -> reason='unknown'
   - Set resolutionType='unresolved' with reason metadata
```

### 3. JavaScript Built-ins List

From the ticket + standard JavaScript:

```javascript
const JS_BUILTINS = new Set([
  // Global functions
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (browser & Node.js)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // Environment globals (treated as built-ins, not callable)
  'globalThis', 'window', 'document', 'global',

  // CommonJS (special case)
  'require'
]);
```

**Note:** `require` is included because it's a global in CommonJS, similar to `eval`. It doesn't need a CALLS edge - it's a language feature.

### 4. EXTERNAL_MODULE Linking Strategy

**Key question:** How to link CALL to EXTERNAL_MODULE?

Two approaches:
- **A) Create via IMPORT node lookup** (recommended)
- B) Create fresh EXTERNAL_MODULE nodes

**Approach A is correct because:**
1. IMPORT nodes already have the module source
2. EXTERNAL_MODULE may already exist (created by GraphBuilder/NodejsBuiltinsResolver)
3. Avoids duplicate EXTERNAL_MODULE nodes

**Algorithm:**
```
For CALL with name='useQuery':
1. Find IMPORT in same file where local='useQuery'
2. Get source from IMPORT (e.g., '@tanstack/react-query')
3. Check if EXTERNAL_MODULE:{source} exists
4. If not, create it
5. Create CALLS edge with metadata: { exportedName: 'useQuery' }
```

### 5. Edge Metadata

CALLS edge to EXTERNAL_MODULE should include:
```typescript
{
  type: 'CALLS',
  src: callSite.id,
  dst: externalModule.id,
  metadata: {
    exportedName: string  // The imported name (useQuery, lodash, etc.)
  }
}
```

This allows queries like "what functions from lodash are called?"

### 6. Resolution Type Metadata

Add to CALL node:
```typescript
{
  resolutionType: 'internal' | 'external' | 'builtin' | 'unresolved',
  // If unresolved:
  unresolvedReason?: 'dynamic' | 'alias' | 'unknown'
}
```

**Integration with CallResolverValidator:**
- REG-227 will update validator to NOT report errors for:
  - `resolutionType='external'` (valid, linked to EXTERNAL_MODULE)
  - `resolutionType='builtin'` (valid, intrinsic function)
- Still report for `resolutionType='unresolved'` (informational warning)

## Architecture Alignment

### Follows Established Patterns

1. **Plugin structure** matches FunctionCallResolver, MethodCallResolver:
   - Build indices for O(1) lookup
   - Process CALL nodes in single pass
   - Use `createSuccessResult` with counts
   - Use `this.log(context)` for structured logging

2. **EXTERNAL_MODULE node reuse** matches NodejsBuiltinsResolver:
   - Check if node exists before creating
   - ID format: `EXTERNAL_MODULE:{normalizedSource}`

3. **Graceful degradation**: If data is missing, skip gracefully (don't crash)

### Graph Vision Alignment

This fills a critical gap: **"What external dependencies does this code use?"**

Before:
```
Query: What does foo.js call?
Answer: [internal FUNCTION nodes only]
```

After:
```
Query: What does foo.js call?
Answer: [FUNCTION nodes] + [EXTERNAL_MODULE:lodash, EXTERNAL_MODULE:react]
```

This enables:
- Dependency analysis: "What npm packages does this service use?"
- Security audits: "What external code paths exist?"
- Dead code detection: "Are all exports actually called?"

## Implementation Structure

### File Location
```
packages/core/src/plugins/enrichment/ExternalCallResolver.ts
```

### Class Structure
```typescript
export class ExternalCallResolver extends Plugin {
  private static JS_BUILTINS: Set<string>;

  get metadata(): PluginMetadata {
    return {
      name: 'ExternalCallResolver',
      phase: 'ENRICHMENT',
      priority: 70,  // After FunctionCallResolver (80), before MethodCallResolver (50)
      creates: {
        nodes: ['EXTERNAL_MODULE'],  // May create if not exists
        edges: ['CALLS']
      },
      dependencies: ['FunctionCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult>;

  // Private methods:
  private buildImportIndex(graph): Promise<Map<string, ImportInfo>>;
  private isJsBuiltin(name: string): boolean;
  private detectUnresolvedReason(callNode): UnresolvedReason;
  private getOrCreateExternalModule(graph, source): Promise<string>;
}
```

### Algorithm Steps

1. **Build Import Index**: Map<`file:localName`> -> ImportInfo
   - Only external imports (non-relative source)
   - Store: source, importType, imported (original name)

2. **Build Existing EXTERNAL_MODULE Index**: Set<moduleId>
   - For idempotency checking

3. **Collect Unresolved CALL_SITE Nodes**:
   - No `object` attribute (not method call)
   - No CALLS edge yet

4. **For Each Unresolved CALL_SITE**:
   ```
   a) Check import index for matching local name
      -> If external import found:
         - Get/create EXTERNAL_MODULE node
         - Create CALLS edge with exportedName metadata
         - Add resolutionType='external' to CALL node

   b) Check if JS builtin
      -> If builtin:
         - Add resolutionType='builtin' to CALL node
         - No edge (builtins are intrinsic)

   c) Otherwise unresolved:
      - Detect reason (alias/dynamic/unknown)
      - Add resolutionType='unresolved', unresolvedReason to CALL node
   ```

5. **Return Summary**:
   - edgesCreated (CALLS to EXTERNAL_MODULE)
   - nodesCreated (new EXTERNAL_MODULE if any)
   - resolvedAsBuiltin count
   - unresolvedWithReason breakdown

## Test Strategy

### Unit Tests (test/unit/ExternalCallResolver.test.js)

1. **External package calls**:
   - `import _ from 'lodash'; _();` -> CALLS to EXTERNAL_MODULE:lodash
   - `import { useQuery } from '@tanstack/react-query'; useQuery();` -> CALLS with exportedName

2. **JavaScript built-ins**:
   - `parseInt('42')` -> resolutionType='builtin', no CALLS edge
   - `setTimeout(fn, 100)` -> resolutionType='builtin'
   - `require('./foo')` -> resolutionType='builtin' (special CommonJS case)

3. **Truly unresolved**:
   - Dynamic: `const fn = arr[0]; fn()` -> resolutionType='unresolved', reason='dynamic'
   - Alias: `const x = someFunc; x()` -> reason='alias'
   - Unknown: bare call to undefined name -> reason='unknown'

4. **Idempotency**:
   - Run twice, verify same result
   - Verify no duplicate EXTERNAL_MODULE nodes

5. **Edge cases**:
   - Already resolved call (has CALLS edge) -> skip
   - Method call (has object) -> skip (let MethodCallResolver handle)
   - Mixed: some resolved, some external, some builtin

### Integration Tests

- Full pipeline: analyze real code with external deps
- Query: "find all EXTERNAL_MODULE nodes and their callers"

## Risks and Mitigations

### Risk 1: Duplicate EXTERNAL_MODULE Nodes
**Mitigation**: Always check if node exists before creating:
```typescript
const nodeId = `EXTERNAL_MODULE:${source}`;
const existing = await graph.getNode(nodeId);
if (!existing) {
  await graph.addNode(ExternalModuleNode.create(source));
}
```

### Risk 2: Dynamic Call Detection Accuracy
**Mitigation**: Start conservative. If callee is not a simple identifier, mark as dynamic. Can refine later with ValueDomainAnalyzer integration.

### Risk 3: Performance with Many External Calls
**Mitigation**: Build indices upfront. O(1) lookups. Same pattern as FunctionCallResolver.

### Risk 4: Node.js Builtins Overlap
**Mitigation**: Clear separation:
- ExternalCallResolver: JS builtins (parseInt, setTimeout) - NO edge
- NodejsBuiltinsResolver: Node module builtins (fs.readFile) - CALLS to EXTERNAL_FUNCTION

NodejsBuiltinsResolver runs AFTER ExternalCallResolver (priority 45 < 70), so it can add more resolution to method calls that ExternalCallResolver didn't handle.

## Dependencies

- **Requires**: FunctionCallResolver to run first (handles internal imports)
- **Blocks**: REG-227 (CallResolverValidator update for new resolution types)

## Estimated Effort

Medium complexity:
- Clear patterns to follow from FunctionCallResolver
- Main complexity: detecting unresolved reasons accurately
- Well-defined test cases

## Conclusion

ExternalCallResolver fills the gap between FunctionCallResolver (internal) and NodejsBuiltinsResolver (Node.js modules) by handling:
1. External package calls (lodash, react, etc.)
2. JavaScript built-in calls (parseInt, setTimeout)
3. Truly unresolved calls (with diagnostic metadata)

This completes the call resolution pipeline and enables queries about external dependencies.

Ready for Joel to create detailed technical specification.
