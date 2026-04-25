# User Request: REG-113

**Linear Issue:** [REG-113 - Data Flow: Track array mutations (.push, .unshift, assignment)](https://linear.app/reginaflow/issue/REG-113/data-flow-track-array-mutations-push-unshift-assignment)

## Problem

Current data flow analysis doesn't track array mutations. When code does:

```javascript
const arr = [];
arr.push(obj);  // No edge created!
func(arr);      // We don't know obj flows into func
```

The graph has no edge connecting `obj` to `arr`. This breaks:

* NodeCreationValidator (can't trace objects to addNode)
* Any analysis requiring "where does this value end up?"
* Taint tracking for security analysis

## Why This Matters

Data flow is Grafema's core value proposition for legacy codebases. Without tracking array mutations, we can't answer:

* "What objects are passed to this function?"
* "Where does this user input end up?"
* "Which objects created here reach the database?"

## Proposed Solution

### 1. Detect array mutation calls

```javascript
arr.push(x)      → x FLOWS_INTO arr
arr.unshift(x)   → x FLOWS_INTO arr
arr[i] = x       → x FLOWS_INTO arr
arr.splice(i,0,x)→ x FLOWS_INTO arr
```

### 2. Create FLOWS_INTO edges (or reuse HAS_ELEMENT)

```
OBJECT_LITERAL#123 --FLOWS_INTO--> arr (VARIABLE)
arr --PASSES_ARGUMENT--> func()
```

### 3. Extend transitive analysis

When querying "what reaches addNode?", traverse:

```
addNode() ← PASSES_ARGUMENT ← arr ← FLOWS_INTO ← obj
```

## Implementation

1. In CallExpressionVisitor, detect `.push()` / `.unshift()` patterns
2. Create edge: argument → FLOWS_INTO → receiver object
3. Update ValueDomainAnalyzer to traverse FLOWS_INTO edges
4. Add tests for array mutation tracking

## Acceptance Criteria

- [ ] `arr.push(obj)` creates `obj FLOWS_INTO arr` edge
- [ ] `arr[i] = obj` creates `obj FLOWS_INTO arr` edge
- [ ] Transitive queries work: "what reaches func(arr)?"
- [ ] NodeCreationValidator can trace objects through arrays
- [ ] Tests pass

## Priority

**HIGH** - This is core value. Without data flow through arrays, Grafema can't do meaningful analysis on real codebases.

## Blocks

- REG-98: Refactor: Migrate all node creation to NodeFactory
