# Don Melton - High-Level Plan for REG-290

## Task: Track AssignmentExpression with Compound Operators

**Date**: 2026-02-01
**Author**: Don Melton (Tech Lead)

---

## Executive Summary

REG-290 asks us to track compound assignment operators (`+=`, `-=`, etc.) in the graph. This is currently a **gap in our data flow tracking**. The issue is that compound operators have dual semantics: they both READ the current value and WRITE a new value. Our current architecture handles simple assignments (`x = y`) via ASSIGNED_FROM edges, and increments (`i++`) via MODIFIES edges, but compound assignments fall through the cracks.

**Critical finding**: This is NOT about patching a hole. This is about **exposing a conceptual inconsistency** in how we model mutation vs. assignment.

---

## Current State Analysis

### 1. What We Track Today

| Pattern | Edge Type | Semantics | Location |
|---------|-----------|-----------|----------|
| `const x = y` | ASSIGNED_FROM | Variable initialization | VariableVisitor |
| `x++`, `--x` | MODIFIES (via SCOPE) | In-place mutation | UpdateExpression handler |
| `obj.prop = val` | FLOWS_INTO | Property mutation | detectObjectPropertyAssignment |
| `arr[i] = val` | FLOWS_INTO | Indexed mutation | detectIndexedArrayAssignment |
| `console.log(x)` | WRITES_TO | Output sink | GraphBuilder |

### 2. The Gap

When we encounter `total += item.price`:

**Current behavior**:
- AssignmentExpression handler (JSASTAnalyzer.ts:2630-2650) ONLY calls:
  - `detectIndexedArrayAssignment()` - checks if left is `arr[i]`
  - `detectObjectPropertyAssignment()` - checks if left is `obj.prop`
- If left is simple Identifier (`total`), **nothing happens**
- No edge created, no tracking

**What should happen**:
- READ: `total` (current value)
- WRITE: `total` (new value)
- Data flow from `item.price` to `total`

### 3. Architecture Review

Looking at our edge semantics:

```
ASSIGNED_FROM:  VARIABLE --ASSIGNED_FROM--> SOURCE
                (const x = y)
                Direction: destination points to source

MODIFIES:       SCOPE --MODIFIES--> VARIABLE
                (count++ inside loop)
                Direction: scope points to modified variable

FLOWS_INTO:     SOURCE --FLOWS_INTO--> DESTINATION
                (obj.prop = value, arr.push(x))
                Direction: source points to destination

WRITES_TO:      SOURCE --WRITES_TO--> SINK
                (console.log(x) writes to stdio)
                Direction: source points to sink
```

**Key observation**: We have TWO patterns for tracking variable changes:
1. **Declarative**: ASSIGNED_FROM (variable initialization)
2. **Imperative**: MODIFIES, FLOWS_INTO (mutation after declaration)

Compound assignment is **imperative mutation**, not declarative initialization.

---

## Architectural Decision: Which Pattern?

### Option A: Extend MODIFIES Pattern

**Reasoning**:
- `total += x` is semantically similar to `total++` - both mutate the variable
- MODIFIES already tracks in-place mutations
- Scope-based tracking (SCOPE --MODIFIES--> VARIABLE)

**Problems**:
- MODIFIES is currently SCOPE-to-VARIABLE, not capturing data flow SOURCE
- `total += item.price` needs to track WHERE the value comes from (item.price)
- MODIFIES doesn't capture the READ aspect

### Option B: Use FLOWS_INTO Pattern

**Reasoning**:
- Compound assignment is data flow: value flows from RHS into LHS
- Matches existing pattern: `obj.prop = value` creates FLOWS_INTO edge
- Direction: SOURCE --FLOWS_INTO--> DESTINATION

**Example**:
```javascript
total += item.price;  // item.price --FLOWS_INTO--> total
```

**Problems**:
- FLOWS_INTO currently only for object/array mutations, not simple variables
- Doesn't capture the READ aspect explicitly

### Option C: New Edge Type READS_FROM + WRITES_TO

**Reasoning**:
- READS_FROM already defined in types.ts (line 52 in DatabaseAnalyzer.ts)
- Explicitly model dual semantics
- `total += item.price` creates:
  - `total --READS_FROM--> total` (reads current value)
  - `total --WRITES_TO--> total` (writes new value)
  - `item.price --FLOWS_INTO--> total` (data flow)

**Problems**:
- Self-loop READS_FROM/WRITES_TO is weird semantically
- Over-engineering for simple mutation tracking
- READS_FROM is currently used for database operations

---

## Recommended Approach

**Use FLOWS_INTO pattern**, but extend it to simple variable reassignment.

### Why This Is Right

1. **Semantic alignment**: Compound assignment IS data flow
   - `total += x` means "value flows from x into total"
   - Same as `arr.push(x)` means "value flows from x into arr"

2. **Consistency**: One edge type for all mutations after initialization
   - Variable initialization: ASSIGNED_FROM
   - All mutations (simple, compound, property, array): FLOWS_INTO

3. **Query simplicity**: "What flows into this variable?" captures ALL data flow
   - Simple: `total = x` → x --FLOWS_INTO--> total
   - Compound: `total += x` → x --FLOWS_INTO--> total
   - Property: `obj.prop = x` → x --FLOWS_INTO--> obj

4. **Minimal architecture change**: Leverage existing FLOWS_INTO machinery

### What About the READ Aspect?

**Current UpdateExpression pattern** (count++):
- Creates SCOPE --MODIFIES--> VARIABLE edge
- Implicitly captures both read and write (increment reads current value)
- We don't model the read separately

**Proposed for compound operators**:
- Create SOURCE --FLOWS_INTO--> VARIABLE edge
- Implicitly captures both read and write
- Consistent with UpdateExpression philosophy: track mutation, not micro-operations

**Example**:
```javascript
function sumItems(items) {
  let total = 0;           // total ASSIGNED_FROM literal(0)
  for (const item of items) {
    total += item.price;   // item.price --FLOWS_INTO--> total
  }
  return total;
}
```

Query: "What flows into total?" → literal(0), item.price
This is EXACTLY what we want for data flow analysis.

---

## Scope Definition

### In Scope

1. **All compound assignment operators**:
   - Arithmetic: `+=`, `-=`, `*=`, `/=`, `%=`, `**=`
   - Bitwise: `&=`, `|=`, `^=`, `<<=`, `>>=`, `>>>=`
   - Logical: `&&=`, `||=`, `??=`

2. **Simple variable reassignment**:
   - Currently MISSING: `x = y` (when x is already declared)
   - Should create: y --FLOWS_INTO--> x

3. **Edge creation for**:
   - Simple identifiers: `total += x`
   - Member expressions: `total += obj.prop`
   - Call expressions: `total += getPrice()`

### Out of Scope

1. **Complex LHS patterns** (defer to future work):
   - Destructuring: `[a, b] += [1, 2]` (invalid syntax anyway)
   - Chained assignment: `a = b += c` (rare, handle separately)

2. **READ edge modeling**:
   - No separate READS_FROM edge for now
   - Compound operator implicitly reads LHS (like UpdateExpression)

3. **Expression-level tracking**:
   - Don't create EXPRESSION nodes for compound operators
   - Only track variable-to-variable data flow

---

## Implementation Strategy

### Phase 1: Simple Variable Reassignment (Foundation)

**Gap**: `x = y` when x is already declared creates NO edge.

**Fix**:
- In AssignmentExpression handler, check if left is Identifier
- If yes, create VariableAssignmentInfo (like we do for declarations)
- GraphBuilder creates: source --FLOWS_INTO--> destination

**Why first**:
- Compound operators desugar to read + simple assignment
- `x += y` ≈ `x = x + y`
- If simple reassignment works, compound is just RHS extraction

### Phase 2: Compound Operators (Build on Foundation)

**Add to AssignmentExpression handler**:
```javascript
if (assignNode.operator !== '=') {
  // Compound operator: +=, -=, etc.
  // Extract RHS, create FLOWS_INTO edge
}
```

**Metadata**:
- Add `operator` field to VariableAssignmentInfo
- GraphBuilder can optionally attach to edge metadata

### Phase 3: Edge Metadata (Optional Enhancement)

Store operator type on FLOWS_INTO edge:
```javascript
{
  type: 'FLOWS_INTO',
  src: 'item.price',
  dst: 'total',
  operator: '+='  // Optional metadata
}
```

**Use case**: Differentiate additive vs. overwrite flow for taint analysis.

---

## Data Structures

### Extend VariableAssignmentInfo (types.ts)

```typescript
export interface VariableAssignmentInfo {
  variableId: string;
  sourceId?: string | null;
  sourceType: string;
  operator?: string;  // NEW: '=', '+=', '-=', etc.
  // ... existing fields
}
```

### No New Collections

Reuse existing `variableAssignments` collection in ASTCollections.

---

## Testing Strategy

### Test Cases (Kent Beck will expand)

1. **Arithmetic operators**:
   ```javascript
   let total = 0;
   total += item.price;  // FLOWS_INTO edge
   total -= discount;    // FLOWS_INTO edge
   ```

2. **Logical operators**:
   ```javascript
   let flag = true;
   flag &&= condition;   // FLOWS_INTO edge
   flag ||= fallback;    // FLOWS_INTO edge
   ```

3. **Null coalescing**:
   ```javascript
   let config = null;
   config ??= defaultConfig;  // FLOWS_INTO edge
   ```

4. **Member expression RHS**:
   ```javascript
   total += obj.prop;    // obj.prop --FLOWS_INTO--> total
   ```

5. **Call expression RHS**:
   ```javascript
   total += getPrice();  // getPrice() --FLOWS_INTO--> total
   ```

---

## Risk Assessment

### Low Risk

- **Existing machinery**: FLOWS_INTO pattern already proven
- **No new edge types**: Reuse existing infrastructure
- **Isolated change**: AssignmentExpression handler + GraphBuilder

### Medium Risk

- **Variable lookup**: Need to resolve LHS identifier to VARIABLE node
- **Scope resolution**: Ensure we find variable in correct scope
- **Edge duplication**: Don't create duplicate edges for same assignment

### Mitigation

- Follow existing pattern from detectObjectPropertyAssignment
- Reuse variable lookup logic from bufferObjectMutationEdges
- Test with nested scopes (function inside function)

---

## Open Questions for Joel

1. **Variable lookup**: Should we use semantic IDs or position-based lookup?
   - Semantic IDs are more stable across edits
   - Position-based is what current mutation handlers use

2. **Scope resolution**: How to handle shadowed variables?
   ```javascript
   let x = 1;
   function foo() {
     let x = 2;
     x += 3;  // Which x?
   }
   ```

3. **Edge deduplication**: Should multiple `x += y` create multiple edges?
   - Current FLOWS_INTO allows multiple edges (arr.push multiple times)
   - But for variables, single edge with metadata might be cleaner

4. **Operator metadata**: Store on edge or skip?
   - Useful for differentiation (+=, -=, *=)
   - But adds complexity if not needed for queries

---

## Alignment with Vision

**"AI should query the graph, not read code."**

**Before this fix**:
```
Agent: "Where does total get its value from?"
Graph: "literal(0) via ASSIGNED_FROM"
Agent: "But it's also updated in the loop!"
User: "You have to read the code, the graph doesn't track that."
```

**After this fix**:
```
Agent: "Where does total get its value from?"
Graph: "literal(0) via ASSIGNED_FROM, item.price via FLOWS_INTO"
Agent: "Perfect, total accumulates item prices."
```

**This is exactly what Grafema is for**: making data flow queryable, not buried in syntax.

---

## Conclusion

REG-290 is not a feature request - it's a **product gap**. Compound operators are fundamental to data flow analysis. Without them, we can't answer "where does this value come from?" for any code using `+=`, `||=`, etc.

**Recommended path**:
1. Fix simple reassignment first (`x = y` after declaration)
2. Extend to compound operators (`x += y`)
3. Use FLOWS_INTO pattern (consistent, proven, minimal change)

This aligns with our vision: the graph should be the source of truth, not the code.

**Next step**: Joel expands this into detailed technical plan with file-by-file changes.

---

**Don Melton**
Tech Lead, Grafema
