# User Request

## Source
Linear issue REG-201

## Request
Implement ASSIGNED_FROM edges for destructuring assignments.

## Linear Issue Details

**Title:** Missing ASSIGNED_FROM edges for destructuring assignments

**Problem:**
Variables assigned via destructuring don't get ASSIGNED_FROM edges:

```javascript
const { headers } = req;           // No ASSIGNED_FROM edge
const [first, second] = array;     // No ASSIGNED_FROM edge
const { x: renamed } = obj;        // No ASSIGNED_FROM edge
```

**Impact:**
- ~30-40% of modern JavaScript variable declarations use destructuring
- Cannot trace destructured values back to their source objects
- Blocks "where does this variable come from?" queries for destructured vars

**Root Cause:**
JSASTAnalyzer CollectVariableDeclarations visitor doesn't emit assignment edges for destructuring patterns (ObjectPattern, ArrayPattern).

**Solution:**
1. JSASTAnalyzer: detect destructuring in VariableDeclarator
2. For ObjectPattern: create ASSIGNED_FROM edge from each destructured variable → source object
3. For ArrayPattern: create ASSIGNED_FROM edge from each element → source array
4. Handle nested destructuring recursively

**Complexity Note:**
Destructuring is AST-complex. Simple cases first:
- `const {x} = obj` - straightforward
- `const [a, b] = arr` - straightforward
- `const {x: {y}} = obj` - nested, defer to phase 2

**Acceptance Criteria:**
- [ ] `const { headers } = req` creates ASSIGNED_FROM edge
- [ ] `const [first, second] = arr` creates ASSIGNED_FROM edges
- [ ] Works for object and array destructuring
- [ ] Tests pass
- [ ] Demo: "trace destructured variables" works
