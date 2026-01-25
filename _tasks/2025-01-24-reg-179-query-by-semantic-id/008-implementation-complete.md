# REG-179: Implementation Complete

**Date:** 2025-01-24
**Status:** Done

## Summary

Implemented `grafema get <semantic-id>` command to retrieve nodes by exact semantic ID.

## What was delivered

### New command: `grafema get`

```bash
grafema get <semantic-id> [--json] [--project <path>]
```

- O(1) lookup by semantic ID
- Shows node details (type, name, location, metadata)
- Shows incoming/outgoing edges grouped by type
- Text mode: limited to 20 edges per direction
- JSON mode: all edges included

### Files created/modified

- `packages/cli/src/commands/get.ts` (new, 266 lines)
- `packages/cli/src/cli.ts` (modified)
- `test/unit/commands/get.test.js` (new)
- `test/integration/cli-get-command.test.js` (new)

## Verified workflow

```bash
$ grafema trace "user"
[VARIABLE] user
  ID: test.js->authenticate->VARIABLE->user
  Location: src/test.js:2

$ grafema get "test.js->authenticate->VARIABLE->user"
[VARIABLE] user
  ID: test.js->authenticate->VARIABLE->user
  Location: src/test.js:2

Metadata:
  exported: false
  originalId: "test.js->authenticate->VARIABLE->user"

Incoming edges (1):
  DECLARES:
    DECLARES#authenticate:body

Outgoing edges (0):
  (none)
```

## Acceptance criteria status

| # | Criteria | Status |
|---|----------|--------|
| 1 | Add `grafema get <id>` command | ✅ Done |
| 2 | OR make `query` support `--id` flag | ❌ Rejected (architectural decision) |
| 3 | Fix `trace "X from Y"` syntax | ⏳ Deferred to REG-187 |
| 4 | Consistent behavior: if you see an ID, you can use it | ✅ Done |

## Related issues

- REG-187: `trace "X from Y"` scope filtering is broken (created, backlog)

## Reviews

- **Kevlin Henney**: Approved with minor suggestions (see 006-kevlin-review.md)
- **Linus Torvalds**: Approved (see 007-linus-review.md)
