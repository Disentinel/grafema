# Graph Query Utilities

## Graph Structure

### Function Containment

```
FUNCTION -[HAS_SCOPE]-> SCOPE (function_body)
                        SCOPE -[CONTAINS]-> SCOPE (nested blocks: if, for, etc.)
                        SCOPE -[CONTAINS]-> CALL (function call)
                        SCOPE -[CONTAINS]-> METHOD_CALL (method call)
                        SCOPE -[DECLARES]-> VARIABLE
```

**Key Points:**
- FUNCTION nodes do NOT have CONTAINS edges directly
- FUNCTION has exactly one HAS_SCOPE edge to its body SCOPE
- All content (calls, variables, nested scopes) is inside SCOPEs
- Nested functions have their own HAS_SCOPE -> SCOPE hierarchy
- Variables are connected via DECLARES (not CONTAINS)

### Call Resolution

```
CALL/METHOD_CALL -[CALLS]-> FUNCTION (target)
```

- CALLS edge exists only if target function was resolved
- Resolved = we found the function definition in the graph
- Unresolved = external function, dynamic call, or import issue

### Backward Traversal (finding container)

To find the function containing a CALL:

```
CALL <- CONTAINS <- SCOPE <- CONTAINS <- SCOPE <- HAS_SCOPE <- FUNCTION
```

To find the function containing a VARIABLE:

```
VARIABLE <- DECLARES <- SCOPE <- CONTAINS <- SCOPE <- HAS_SCOPE <- FUNCTION
```

Walk up via CONTAINS, DECLARES, and HAS_SCOPE edges.
