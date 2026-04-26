# REG-179: CLI: no way to query node by semantic ID

## Problem

When you find a node via `trace` or other command, you get its semantic ID. But there's no way to get more info about that specific node by ID.

```bash
# trace finds it and shows ID
$ grafema trace "response"
[VARIABLE] response
  ID: AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
  ...

# But query by that ID fails!
$ grafema query "AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response"
No results

# And "from X" syntax doesn't work either
$ grafema trace "response from handleDragEnd"
No variable "response" found in handleDragEnd
```

## Expected Behavior

```bash
# Get node by exact ID
$ grafema get "AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response"
[VARIABLE] response
  ID: AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
  Location: apps/frontend/src/pages/AdminSetlist.tsx:671

  Incoming edges:
    <- ASSIGNED_FROM: CALL#authFetch#...

  Outgoing edges:
    -> USED_BY: ...

# Or at least query should support ID lookup
$ grafema query --id "AdminSetlist.tsx->..."
```

## Acceptance Criteria

1. Add `grafema get <id>` command for exact ID lookup
2. OR make `query` support `--id` flag
3. Fix `trace "X from Y"` syntax to actually work
4. Consistent behavior: if you see an ID, you can use it

## Context

This is basic usability. Tools should work together, not against each other.
