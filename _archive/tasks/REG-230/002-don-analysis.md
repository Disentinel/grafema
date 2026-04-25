# Don Melton: REG-230 Analysis

## Current State Analysis

### Existing Tracing Capabilities

**Backward tracing (getValueSet):**
- `ValueDomainAnalyzer.getValueSet()` traces variables backward through `ASSIGNED_FROM` and `DERIVES_FROM` edges
- Recursively follows value sources to LITERALs, PARAMETERs, and CALLs
- Handles path constraints and narrowing (truthy/falsy, in/not_in operators)
- Max depth: 10 levels (prevents infinite loops)
- Already returns unique values as `ValueSetResult { values: [], hasUnknown: boolean }`

**Data flow edges in the graph:**
- `ASSIGNED_FROM` - variable gets value from source (most common)
- `DERIVES_FROM` - composite expressions (template literals, etc.)
- `PASSES_ARGUMENT` - CALL node → argument source (exists on CALL nodes)
- `RECEIVES_ARGUMENT` - PARAMETER → argument source (inverse of PASSES_ARGUMENT)
- `FLOWS_INTO` - value flowing into containers (arrays, objects)

**CLI/Query Structure:**
- `grafema trace "<varName>"` - current implementation finds variables and traces backward/forward
- `grafema trace "<varName> from <scopeName>"` - scoped traces
- `grafema query --raw` - Datalog query execution capability exists
- Both commands use `RFDBServerBackend` for graph queries

### Missing Pieces for Sink-based Query

1. **Function call resolution:** Need to find all CALL_SITE nodes for a target function name
2. **Argument extraction:** Current PASSES_ARGUMENT edges exist but not easily queryable from call perspective
3. **Property drilling:** After getting argument expression, need to follow HAS_PROPERTY edges for object property access
4. **No dedicated sink query API:** Current trace is source-based, not sink-based

## Architectural Decision

**Single API approach (not separate command):**

Extend `grafema trace` with a new `--to` flag to create a unified interface:

```bash
# Current (source-based)
grafema trace "userId"

# New (sink-based)
grafema trace --to "addNode#0.type"
grafema trace --to "addNode#1.data"
```

**Why single command:**
- Both forward and backward traces use same tracing engine
- Reuses existing CLI infrastructure, error handling, output formatting
- Consistent mental model: "trace" = show value flow (either direction)
- Simpler for agents to remember and use

**Why NOT a separate query language:**
- Raw Datalog queries exist but are verbose for common case
- A dedicated `TRACE_TO` predicate would require new query compiler support
- Violates "query graph, not code" — this IS a graph query, fits trace command

## High-Level Plan

### Phase 1: Core Sink Tracing (REG-230 acceptance criteria)

1. **Add `--to` flag to trace command:**
   - Parse sink specification: `"functionName#argIndex.property.nested"`
   - Implement `parseSinkSpec()` function

2. **Create sink resolution pipeline:**
   ```
   parseSinkSpec("addNode#0.type")
      ↓
   findCallSites("addNode")  // Find all CALL nodes for this function
      ↓
   extractArgument(callSite, 0)  // Get argument at index 0
      ↓
   extractProperty(argument, "type")  // Follow HAS_PROPERTY edge
      ↓
   traceBackward(value)  // Use existing getValueSet()
      ↓
   collectLiterals()  // Extract all LITERAL sources with locations
   ```

3. **Implement helper functions:**
   - `findCallSites(targetFunctionName): Promise<CallNode[]>`
   - `extractArgument(callNode, argIndex): Promise<ExpressionNode | null>`
   - `extractProperty(expressionNode, propertyName): Promise<ExpressionNode | null>`
   - `collectLiteralsWithSources(valueSet): Promise<Array<{value, sources}>>`

4. **Output format:**
   ```json
   {
     "sink": "addNode#0.type",
     "resolvedTo": ["call_site_1_id", "call_site_2_id"],
     "possibleValues": [
       {
         "value": "FUNCTION",
         "sources": [
           { "file": "src/visitors/FunctionVisitor.ts", "line": 45, "id": "..." }
         ]
       }
     ],
     "statistics": {
       "callSites": 5,
       "uniqueValues": 3,
       "unknownElements": false
     }
   }
   ```

### Phase 2: Advanced Features (backlog)

1. **Spread arguments:** `--to "fn#args[0]"` for rest parameters
2. **Array indexing:** `--to "fn#0[0]"` for array argument elements
3. **Conditional narrowing:** `--to "fn#0.type" --when "hasAttribute"`
4. **Cross-file property tracking:** Follow properties across module boundaries

## Key Questions Needing Clarification

1. **CALL node semantics:** Are CALL nodes created for both direct calls and method calls?

2. **Property tracking:** When an object is passed as argument, do we have HAS_PROPERTY edges between the OBJECT_LITERAL and its property values?

3. **Argument nodes:** Are function arguments represented as EXPRESSION nodes with argIndex metadata?

4. **Semantic IDs for sink specs:** How should sink specs map to semantic IDs?

5. **REG-222 dependency:** Does schema export require full sink tracing or simpler enumeration?

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Property drilling is complex | May not handle computed properties well | Start with static properties only, mark computed as "unknown" |
| Multiple call sites with different arguments | Each call site might have different value sets | Return union of all possible values across all call sites |
| CALL node naming ambiguity | `addNode` might match `obj.addNode()` and `addNode()` | Clarify whether sink spec includes/excludes method calls |

## Why This Approach Aligns with Grafema Vision

**"AI should query the graph, not read code"**

- ✅ Zero code reading: entirely graph-based (CALL nodes, PASSES_ARGUMENT edges, HAS_PROPERTY edges)
- ✅ Composable: reuses existing ValueDomainAnalyzer.getValueSet()
- ✅ Deterministic: graph is the source of truth, no heuristics or pattern matching
- ✅ Complete: handles transitive chains (value A → value B → value C → LITERAL)
- ✅ AI-friendly: simple command, structured JSON output, clear semantics

## Next Steps

1. **Joel:** Create detailed tech plan with exact node/edge formats
2. **Clarify with user:** Sink spec syntax
3. **Verify REG-222 requirements:** Does schema export really need this?
