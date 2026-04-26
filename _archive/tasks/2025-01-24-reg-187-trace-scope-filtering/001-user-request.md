# REG-187: trace "X from Y" scope filtering is broken

## Problem

The `trace "X from Y"` syntax in the trace command doesn't work correctly.

```bash
$ grafema trace "response from handleDragEnd"
No variable "response" found in handleDragEnd
```

But the variable exists inside `handleDragEnd`.

## Root Cause

Current implementation (trace.ts line ~156):

```typescript
if (!file.toLowerCase().includes(scopeName.toLowerCase())) continue;
```

This is a **heuristic hack**. It checks if the function name appears in the **file path**, not in the actual scope hierarchy.

Fails for:
- Variables in nested scopes (try/catch blocks)
- Multiple functions with same name in different files
- Any case where function name doesn't appear in file path

## Expected Behavior

```bash
$ grafema trace "response from handleDragEnd"
[VARIABLE] response
  ID: AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
  ...
```

Should use proper scope-based lookup via:
- `DECLARED_IN` edges
- Semantic ID parsing
- Or actual scope hierarchy from graph

## Acceptance Criteria

1. `trace "X from Y"` finds variables/nodes within scope Y
2. Works for nested scopes (try blocks, if blocks, etc.)
3. Works when function name doesn't match file name
4. Error message is clear when scope Y doesn't exist

## Context

Split from REG-179 (query by semantic ID). The `get` command provides the immediate workaround: users can `trace "response"` to find the ID, then `get <id>` for details. But the `from` syntax should work properly.
