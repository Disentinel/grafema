# TRIZ Analysis: Computed Property Keys Resolution

**Author:** Genrich Altshuller (TRIZ Expert)
**Date:** 2025-01-22
**Context:** REG-114 Object Property Mutations - computed keys limitation

---

## 1. Problem Statement

When analyzing JavaScript code:
```javascript
const key = 'handler';
obj[key] = value;
```

Grafema sees `obj[key]` but does not know that `propertyName` = `'handler'` because:
- At analysis phase, we only see the AST node `obj[key]`
- The value of `key` requires dataflow analysis
- Dataflow analysis is computationally expensive
- Current implementation uses `'<computed>'` as placeholder

---

## 2. Contradiction Formulation

### 2.1 Administrative Contradiction (AC)

**Goal:** Know the exact property name for computed property access (`obj[key]`)

**Obstacles:**
- Variable values are not known at parse time
- Computing values requires expensive dataflow analysis
- Target environment is massive legacy codebases where performance matters

**AC:** We want to know property names BUT this requires expensive computation that slows down analysis.

### 2.2 Technical Contradiction (TC)

**TC-1:** If we compute variable values (IMPROVE accuracy) THEN analysis becomes slow (WORSEN speed)

**TC-2:** If we skip value computation (IMPROVE speed) THEN we lose property name information (WORSEN accuracy)

**Altshuller Matrix Parameters:**
- Improving: #28 Measurement accuracy (knowing the property name)
- Worsening: #25 Loss of time (slower analysis)

or

- Improving: #25 Loss of time (faster analysis)
- Worsening: #28 Measurement accuracy (unknown property names)

### 2.3 Physical Contradiction (PC)

**The variable value MUST be computed** (to know the property name)
**AND the variable value MUST NOT be computed** (to keep analysis fast)

**Separation principles available:**
1. Separation in time
2. Separation in space
3. Separation between system and supersystem
4. Separation on condition

---

## 3. TRIZ Principles Application

### 3.1 Principle #1: Segmentation (Separation in Time)

**Idea:** Don't compute ALL values. Compute only values that are NEEDED and SIMPLE.

Current system already has a foundation:
- `VariableAssignmentInfo` tracks `sourceType: 'LITERAL'` with `literalValue`
- `ASSIGNED_FROM` edges connect variables to their sources
- `ValueDomainAnalyzer` can trace value chains

**Application:**
```
const key = 'handler';  // LITERAL assignment -> literalValue: 'handler'
obj[key] = value;       // key is ASSIGNED_FROM LITERAL -> resolve to 'handler'
```

**Only trace simple cases:**
- Direct literal assignment: `const key = 'handler'`
- Constant propagation: `const A = 'x'; const B = A; obj[B]`
- Skip: function calls, user input, complex expressions

### 3.2 Principle #10: Preliminary Action (Do Ahead)

**Idea:** Pre-compute literal values during AST analysis phase, store them.

Already exists:
- `LiteralInfo` stores `value` field
- `VariableDeclarationInfo` stores `value` field for direct literal assignments
- `ASSIGNED_FROM` edges to `LITERAL` nodes

**Missing link:** The `GraphBuilder.bufferObjectMutationEdges()` doesn't look up literal values when creating edges.

**Solution:** During edge creation, if `propertyName === '<computed>'`, check if the key variable has a known literal value via `variableAssignments`.

### 3.3 Principle #2: Taking Out (Extraction)

**Idea:** Extract the "expensive" part (full dataflow) and replace with "cheap" approximation (single-hop lookup).

**Full dataflow (expensive):**
```
const base = getConfig();
const key = base.handler;
obj[key] = value;  // Requires tracing through function calls
```

**Single-hop lookup (cheap):**
```
const key = 'handler';
obj[key] = value;  // key -> LITERAL 'handler' (1 hop)
```

**Implementation:**
- In analysis phase, if computed property is identifier, store the identifier name
- In edge creation phase, look up if that identifier has a direct literal assignment
- If yes: resolve property name
- If no: keep `'<computed>'`

### 3.4 Principle #25: Self-Service

**Idea:** The system should do the work using resources it already has.

**Available Resources:**
1. `variableAssignments` collection - contains `literalValue` for `sourceType: 'LITERAL'`
2. `variableDeclarations` collection - contains `value` for simple initializations
3. `computedPropertyVar` field in `MethodCallInfo` - stores the variable name used in `obj[x]()`
4. `ObjectMutationInfo.propertyName` - currently stores `'<computed>'`

**Self-service solution:**
During `bufferObjectMutationEdges()`:
1. If `propertyName === '<computed>'` and mutation has `computedPropertyVar`
2. Look up `computedPropertyVar` in `variableAssignments`
3. If found with `sourceType: 'LITERAL'`: use `literalValue` as `propertyName`

### 3.5 Principle #17: Moving to Another Dimension

**Idea:** If horizontal analysis is expensive, move to vertical (time dimension).

Current: Synchronous single-pass analysis
Proposed: Two-phase approach

**Phase 1 (Analysis):** Collect all data, mark computed properties with variable name
**Phase 2 (Enrichment):** Resolve simple literal values using already-built graph

This is exactly what `ValueDomainAnalyzer` does! It runs in ENRICHMENT phase and traces values.

---

## 4. Ideal Final Result (IFR)

**IFR Statement:** The property name is known WITHOUT additional computation, because the system automatically resolves simple literal values using data it has already collected.

**Characteristics of IFR:**
- No new infrastructure needed
- No performance cost for simple cases (majority)
- Graceful degradation for complex cases (keeps `'<computed>'`)
- Uses existing `variableAssignments` data

---

## 5. Available Resources Analysis

### 5.1 Substance Resources (What we have)

| Resource | Where | Contains |
|----------|-------|----------|
| `variableAssignments` | JSASTAnalyzer | `sourceType`, `literalValue`, `sourceName` |
| `ObjectMutationInfo` | JSASTAnalyzer | `propertyName`, `objectName`, `mutationType` |
| `variableDeclarations` | JSASTAnalyzer | `value` field for simple literals |
| `ASSIGNED_FROM` edges | GraphBuilder | Links variables to sources |
| `LITERAL` nodes | GraphBuilder | Contains `value` field |
| `ValueDomainAnalyzer` | Enrichment | `getValueSet()`, `traceValueSet()` |

### 5.2 Field Resources (What's already in motion)

- Analysis phase collects `computedPropertyVar` in `MethodCallInfo` for `obj[x]()`
- Similar pattern exists but NOT YET for property assignments `obj[x] = value`

### 5.3 Time Resources

- Analysis phase (fast) - just collect variable names
- Enrichment phase (can be slower) - resolve values using graph

### 5.4 Information Resources

The information ALREADY EXISTS in the system:
```javascript
const key = 'handler';  // variableAssignment: { sourceType: 'LITERAL', literalValue: 'handler' }
obj[key] = value;       // ObjectMutationInfo: { propertyName: '<computed>', ??? }
```

**Missing:** The bridge between them (storing `computedPropertyVar` in `ObjectMutationInfo`)

---

## 6. Solution Synthesis

### 6.1 Minimal Change Solution (Analysis Phase)

**Step 1:** When detecting computed property assignment `obj[key] = value`:
- Store `computedPropertyVar: 'key'` in `ObjectMutationInfo`
- Keep `propertyName: '<computed>'`

**Step 2:** In `bufferObjectMutationEdges()`:
```typescript
if (propertyName === '<computed>' && mutation.computedPropertyVar) {
  // Look up the variable's literal value
  const varAssignment = variableAssignments.find(
    va => va.sourceName === mutation.computedPropertyVar
      && va.sourceType === 'LITERAL'
  );
  if (varAssignment && varAssignment.literalValue !== undefined) {
    propertyName = String(varAssignment.literalValue);
  }
}
```

**Advantages:**
- No new data structures
- Single lookup per computed property
- Works for majority of real-world cases
- No performance regression for non-computed properties

### 6.2 Enhanced Solution (Enrichment Phase)

Use existing `ValueDomainAnalyzer` infrastructure:

**Step 1:** Store `computedPropertyVar` in the edge metadata
**Step 2:** Create enrichment plugin `ComputedPropertyResolver`:
```typescript
// Finds FLOWS_INTO edges with propertyName: '<computed>'
// Uses ValueDomainAnalyzer.getValueSet() to resolve
// Updates edge metadata with resolved propertyName
```

**Advantages:**
- Handles transitive cases: `const A = 'x'; const B = A; obj[B]`
- Consistent with existing enrichment architecture
- Can be made path-sensitive using existing scope constraints

---

## 7. Recommendations

### 7.1 Immediate (REG-114 scope)

Add `computedPropertyVar` field to `ObjectMutationInfo`:
```typescript
interface ObjectMutationInfo {
  // ... existing fields
  computedPropertyVar?: string;  // Variable name in obj[x] = value
}
```

Store it during detection in `JSASTAnalyzer`:
```typescript
if (node.computed && isIdentifier(node.property)) {
  mutation.computedPropertyVar = node.property.name;
}
```

### 7.2 Short-term (Next iteration)

Implement literal lookup in `bufferObjectMutationEdges()`:
- Look up `computedPropertyVar` in `variableAssignments`
- Resolve if `sourceType === 'LITERAL'`
- Update `propertyName` from `'<computed>'` to actual value

### 7.3 Medium-term (Future enhancement)

Create `ComputedPropertyResolver` enrichment plugin:
- Use `ValueDomainAnalyzer.getValueSet()` for transitive resolution
- Handle conditional assignments: `const key = flag ? 'a' : 'b'`
- Report confidence level in edge metadata

---

## 8. Conclusion

The contradiction is **resolvable** using existing resources:

1. **Physical contradiction resolution:** Separation in TIME
   - Analysis phase: collect variable names (fast)
   - Edge creation: single-hop literal lookup (fast)
   - Enrichment phase: full value tracing (when needed)

2. **Key insight:** The VALUE already exists in the system (in `variableAssignments`). We just need to CONNECT it to where it's needed (in `bufferObjectMutationEdges`).

3. **IFR achieved:** System resolves property names using data it already has, with no additional computation for simple cases.

**Implementation effort:** Small (add one field, one lookup)
**Value delivered:** High (majority of computed properties in real code are simple literal assignments)

---

## Appendix: TRIZ Matrix Lookup

For TC: Improve #28 (Measurement accuracy) without worsening #25 (Loss of time)

Suggested principles: 10, 24, 28, 32

- **#10 Preliminary Action** - Pre-store literal values during analysis
- **#24 Intermediary** - Use variable name as intermediary, resolve later
- **#28 Mechanics Substitution** - Replace expensive dataflow with simple lookup
- **#32 Color Change** - Mark computed vs resolved differently in metadata

All four principles point to the same solution: **pre-collect, defer resolution, use intermediary**.
