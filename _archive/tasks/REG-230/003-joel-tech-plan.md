# Joel Spolsky: REG-230 Technical Implementation Plan

## Overview

Extend `grafema trace` command with `--to` flag to enable sink-based value domain queries. This allows users to ask "what values can reach this sink point?" (e.g., `grafema trace --to "addNode#0.type"`).

## File Changes Summary

| File | Type | Purpose |
|------|------|---------|
| `packages/cli/src/commands/trace.ts` | MODIFY | Add `--to` flag, parse sink specs, integrate sink resolution |
| `packages/cli/src/utils/sinkResolver.ts` | CREATE | Core sink resolution logic (NEW FILE) |
| `packages/cli/test/trace-sink.test.ts` | CREATE | Test suite for sink-based tracing (NEW FILE) |

## Implementation Steps (Detailed)

### Phase 1: Type Definitions & Utilities (Step 1-5)

**Step 1: Define sink spec types** in `packages/cli/src/utils/sinkResolver.ts`

```typescript
interface SinkSpec {
  functionName: string;
  argIndex: number;
  propertyPath: string[];  // e.g., ["type"] for .type, ["config", "options"] for .config.options
  raw: string;             // original "addNode#0.type" for error messages
}

interface SinkResolutionResult {
  sink: SinkSpec;
  resolvedCallSites: CallSiteInfo[];
  possibleValues: Array<{
    value: unknown;
    sources: Array<{
      id: string;
      file: string;
      line: number;
      column?: number;
    }>;
  }>;
  statistics: {
    callSites: number;
    totalSources: number;
    uniqueValues: number;
    unknownElements: boolean;
  };
}

interface CallSiteInfo {
  id: string;
  calleeFunction: string;
  file: string;
  line: number;
  column?: number;
  argumentNodes: Array<{
    index: number;
    nodeId: string;
    nodeType: string;
  }>;
}

interface ValueWithSource {
  value: unknown;
  nodeId: string;
  file: string;
  line: number;
  column?: number;
}
```

**Step 2: Implement sink spec parser**

Function: `parseSinkSpec(spec: string): SinkSpec`

Requirements:
- Parse: `functionName#argIndex.property.nested`
- Extract function name (before `#`)
- Extract argument index (numeric after `#`)
- Extract property path (after index, separated by `.`)
- Validate: function name non-empty, argIndex >= 0, propertyPath non-empty
- Error messages: "Invalid sink spec: {spec}" with specifics

Test cases:
- `"addNode#0.type"` → `{functionName: "addNode", argIndex: 0, propertyPath: ["type"]}`
- `"process#1.config.options"` → `{functionName: "process", argIndex: 1, propertyPath: ["config", "options"]}`
- `"fn#0"` → error (no property)
- `"fn#abc.type"` → error (argIndex not numeric)
- `"#0.type"` → error (no function name)

**Step 3: Implement call site finder**

Function: `findCallSites(backend: RFDBServerBackend, targetFunctionName: string): Promise<CallSiteInfo[]>`

Algorithm:
1. Query all CALL nodes: `graph.queryNodes({ nodeType: 'CALL' })`
2. Filter by `callee === targetFunctionName` (exact match, case-sensitive)
3. For each CALL node:
   - Get outgoing PASSES_ARGUMENT edges
   - Build argument map: `Map<argIndex, argumentNodeId>`
4. Return CallSiteInfo array

**Step 4: Implement argument extractor**

Function: `extractArgument(backend: RFDBServerBackend, callSiteId: string, argIndex: number): Promise<string | null>`

Algorithm:
1. Get PASSES_ARGUMENT edges from call site
2. Filter edges where `metadata.argIndex === argIndex`
3. Return `edge.dst` (the node ID of the argument expression)
4. Return null if no matching argument found

**Step 5: Implement property extractor**

Function: `extractProperty(backend: RFDBServerBackend, argumentNodeId: string, propertyPath: string[]): Promise<string | null>`

Algorithm:
1. Start with current nodeId = argumentNodeId
2. For each property name in propertyPath:
   - If current node is OBJECT_LITERAL:
     - Get outgoing HAS_PROPERTY edges
     - Find edge where `metadata.propertyName === propertyName`
     - Update current nodeId = edge.dst
   - Else if current node is VARIABLE or EXPRESSION:
     - Trace ASSIGNED_FROM edges to find OBJECT_LITERAL
     - Then follow HAS_PROPERTY from that OBJECT_LITERAL
   - Else: Return null
3. Return final current nodeId

### Phase 2: Core Sink Resolution (Step 6-8)

**Step 6: Implement main sink resolver**

Function: `resolveSink(backend: RFDBServerBackend, sink: SinkSpec): Promise<SinkResolutionResult>`

Algorithm:
1. Validate sink spec
2. Find all call sites: `callSites = await findCallSites(backend, sink.functionName)`
3. If no call sites: return result with statistics.callSites = 0
4. For each call site:
   a. Extract argument at argIndex
   b. If argNodeId is null: skip this call site
   c. Extract property
   d. If propNodeId is null: add to unknownElements statistics
   e. Trace value set using getValueSetWithSources()
   f. Merge valueSet into accumulated results
5. Deduplicate values
6. Sort values for deterministic output
7. Return SinkResolutionResult

**Step 7: Implement value set with sources collector**

Function: `getValueSetWithSources(backend: RFDBServerBackend, nodeId: string): Promise<ValueWithSource[]>`

Algorithm:
1. Call existing `ValueDomainAnalyzer.getValueSet()` to get value set
2. For each value in the result:
   - Trace backward to find all LITERAL nodes
   - Collect source node info: `{id, file, line, column}`
3. Return array of `{value, sources: [...]}`

**Step 8: Integrate with CLI trace command**

Modifications to `packages/cli/src/commands/trace.ts`:

```typescript
interface TraceOptions {
  project: string;
  json?: boolean;
  depth: string;
  to?: string;  // NEW: sink spec for backward tracing
}

export const traceCommand = new Command('trace')
  .description('Trace data flow for a variable')
  .argument('<pattern>', 'Pattern: "varName from functionName" or just "varName"')
  .option('--to <sink>', 'Sink spec: "functionName#argIndex.property"')  // NEW
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --depth <n>', 'Max trace depth', '10')
  .action(async (pattern: string, options: TraceOptions) => {
    if (options.to) {
      return await handleSinkTrace(backend, options.to, options);
    } else {
      return await handleSourceTrace(backend, pattern, options);
    }
  });
```

### Phase 3: Output Formatting (Step 9-10)

**Step 9: Implement sink result formatter**

Output format (JSON):
```json
{
  "sink": "addNode#0.type",
  "resolvedCallSites": 3,
  "possibleValues": [
    {
      "value": "FUNCTION",
      "sources": [
        { "file": "src/visitors/FunctionVisitor.ts", "line": 45 }
      ]
    }
  ],
  "statistics": {
    "callSites": 3,
    "totalSources": 3,
    "uniqueValues": 2,
    "unknownElements": false
  }
}
```

Output format (human):
```
Sink: addNode#0.type

Resolved to 3 call sites

Possible values:
  • "FUNCTION" (2 sources)
    ← src/visitors/FunctionVisitor.ts:45
    ← src/visitors/FunctionVisitor.ts:67
  • "CLASS" (1 source)
    ← src/visitors/ClassVisitor.ts:32

Statistics:
  Call sites: 3
  Unique values: 2
```

**Step 10: Implement error handling**

Error cases:
- Invalid sink spec: `"Invalid sink spec: {spec}. Expected: functionName#argIndex.property"`
- Function not found: `"No call sites found for function '{functionName}'"`
- Invalid argument index: `"Function called with fewer arguments at all call sites"`
- Property doesn't exist: `"Cannot trace property - value is not an object"`

## Test Cases

### Unit Tests: `parseSinkSpec()`
- Valid: `"fn#0.prop"` → correct parsing
- Valid: `"addNode#0.type"` → correct parsing
- Valid: `"fn#10.a.b.c"` → handles multi-level properties
- Invalid: no `#` separator
- Invalid: `#` but no function name
- Invalid: argIndex not numeric
- Invalid: no property path
- Invalid: negative argIndex

### Unit Tests: `findCallSites()`
- Find exact function name (case-sensitive)
- Return empty array for non-existent function
- Include both direct calls and method calls

### Unit Tests: `extractArgument()`
- Return node ID for valid argIndex
- Return null when call has fewer arguments

### Unit Tests: `extractProperty()`
- Single level property on OBJECT_LITERAL
- Multi-level property: `a.b.c`
- Return null for non-existent property

### Integration Tests: `resolveSink()`
- Trace from argument through OBJECT_LITERAL to LITERAL values
- Deduplicate same values from different sources
- Return sorted, deterministic output
- Handle multiple call sites

### End-to-end Test Scenario

Code:
```javascript
const config1 = { type: "FUNCTION", name: "add" };
const config2 = { type: "CLASS", name: "Node" };

function registerNode(config) {
  addNode(config);
}

registerNode(config1);
registerNode(config2);
```

Query: `grafema trace --to "addNode#0.type"`

Expected output: Values "FUNCTION" and "CLASS" with source locations

## Edge Cases & Mitigations

| Edge Case | Mitigation |
|-----------|-----------|
| Call site has fewer arguments | Skip that call site, note in statistics |
| Computed property access | Mark as unknown |
| Circular reference | Existing cycle detection in getValueSet() |
| PARAMETER node (runtime input) | Mark as unknown in statistics |
| No LITERAL values found | Return `unknownElements: true` |

## Performance Considerations

- **Call site discovery:** O(n) scan of CALL nodes
- **Value tracing:** O(2^b) capped at MAX_DEPTH=10
- Overall: Should complete in <1 second for typical projects

## Backward Compatibility

- Existing `grafema trace "varName"` behavior unchanged
- New `--to` flag is optional
- No breaking changes to graph schema
