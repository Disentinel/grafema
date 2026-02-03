# Don Plan - REG-321: MAKES_REQUEST edge to CALL node

## Analysis

### Current Behavior
FetchAnalyzer at lines 359-384 finds the FUNCTION node containing the HTTP request and creates:
```
FUNCTION --MAKES_REQUEST--> http:request
```

### Required Change
Also create edge from the specific CALL node:
```
CALL --MAKES_REQUEST--> http:request
```

### How to Find CALL Node
CALL nodes are created by JSASTAnalyzer/CallExpressionVisitor with:
- `file`: same file path
- `line`: same line number
- `name`: matches the call pattern:
  - `fetch` for fetch() calls
  - `axios.get`, `axios.post`, etc. for axios method calls
  - `axios` for axios config calls
  - Custom wrapper name (e.g., `authFetch`) for custom wrappers

### Implementation

In `FetchAnalyzer.ts`, after creating the http:request node (around line 350), add logic to:
1. Query CALL nodes in same file with same line
2. Match by expected name pattern based on library field
3. Create MAKES_REQUEST edge from CALL → http:request

### Complexity
O(1) lookup per request - querying by file+line is efficient. No new iterations over all nodes.

## Lens
This is a well-defined local change. Mini-MLA: Don → Rob → Linus.
