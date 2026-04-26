# REG-179: Query by Semantic ID - Don's Analysis

**Date:** 2025-01-24
**Analyst:** Don Melton (Tech Lead)
**Issue:** Users can see semantic IDs from `trace` output but can't query by them

## The Problem

This is a fundamental usability failure. We show users semantic IDs like:
```
AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
```

But when they try to use that ID, it doesn't work:
```bash
$ grafema query "AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response"
No results
```

This violates a core principle: **If you show it, it must be usable.**

## Root Cause Analysis

After examining the codebase, I've identified the complete architecture:

### How Semantic IDs Work

1. **Creation** (`packages/core/src/core/SemanticId.ts`):
   - Format: `{file}->{scope_path}->{type}->{name}[#discriminator]`
   - Example: `src/app.js->UserService->METHOD->login`
   - Created by `computeSemanticId()` using ScopeContext

2. **Storage** (`packages/core/src/storage/backends/RFDBServerBackend.ts`):
   - Semantic IDs are stored in the `id` field when nodes are added
   - The `originalId` is preserved in metadata
   - `_parseNode()` extracts `originalId` from metadata and returns it as the node's `id`

3. **Retrieval** (`RFDBServerBackend.getNode()`):
   - Calls `this.client.getNode(String(id))`
   - This passes the semantic ID directly to the RFDB server
   - The server looks up nodes by their stored `id` field
   - **This works correctly** - `getNode()` can find nodes by semantic ID

### Where It Breaks

The problem is **NOT** in the storage layer. The problem is in the CLI commands:

1. **`grafema query`** (`packages/cli/src/commands/query.ts`):
   - Only searches by **name pattern matching** (line 174)
   - Never tries direct ID lookup
   - Pattern: `"function authenticate"` or `"class UserService"`
   - When you pass a semantic ID, it treats it as a name pattern and fails

2. **`grafema trace`** (`packages/cli/src/commands/trace.ts`):
   - The "from X" syntax (line 156) does scope filtering via:
     ```typescript
     if (!file.toLowerCase().includes(scopeName.toLowerCase())) continue;
     ```
   - This is a **heuristic hack**, not real scope-based lookup
   - It checks if the function name appears in the file path
   - Fails for variables inside nested scopes

### The Missing Capability

Users need a way to:
1. Get a node by exact semantic ID
2. Show all edges (incoming/outgoing)
3. Show node metadata

This is NOT the same as `query` (which searches by pattern).
This is a **direct lookup** operation.

## Why This Matters

This isn't just a missing feature. It's a **broken promise** to users.

When we show semantic IDs in output, we're implicitly saying:
- "This is the stable identifier for this node"
- "You can use this to refer to it later"
- "This won't change when you add code elsewhere"

But then we don't accept that identifier as input. That's dishonest.

From a product perspective:
- AI agents will copy/paste these IDs
- Humans will try to use them in scripts
- Both will fail and lose trust in Grafema

From an architectural perspective:
- We have the capability (getNode works)
- We just didn't expose it to users
- That's a CLI-level gap, not a storage-level limitation

## The Right Solution

### Design Decision

Add a new command: `grafema get <semantic-id>`

**Why a separate command?**
- Different intent: direct lookup vs search
- Different output format: full node details + edges
- Different performance: O(1) vs O(n) scan
- Clear UX: `query` searches, `get` retrieves

**Why NOT extend `query`?**
- `query` is for pattern matching ("find functions named X")
- Adding `--id` flag would overload the command's purpose
- Two modes (search vs lookup) in one command is confusing
- Pattern matching and ID lookup have nothing in common

### Command Specification

```bash
grafema get <semantic-id>
```

**Input:**
- Semantic ID (exact match)
- Example: `AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response`

**Output:**
```
[VARIABLE] response
  ID: AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
  Location: apps/frontend/src/pages/AdminSetlist.tsx:671
  Type: VARIABLE

Incoming edges (3):
  <- ASSIGNED_FROM: CALL#authFetch#...
  <- USED_BY: EXPRESSION#...
  <- DECLARED_IN: FUNCTION#handleDragEnd

Outgoing edges (2):
  -> FLOWS_TO: VARIABLE#items
  -> USED_IN: CALL#setState#...
```

**Flags:**
- `-j, --json`: JSON output
- `-p, --project <path>`: Project path (default: `.`)

### Implementation Plan

1. **Create `packages/cli/src/commands/get.ts`**
   - Parse semantic ID
   - Validate format
   - Call `backend.getNode(id)`
   - Fetch incoming/outgoing edges
   - Format and display

2. **Register command in `packages/cli/src/index.ts`**
   - Import and add to program

3. **Reuse existing utilities:**
   - `formatNodeDisplay()` for consistent output
   - `exitWithError()` for error handling
   - Database connection boilerplate from other commands

4. **Edge cases:**
   - Node not found → clear error message
   - Invalid semantic ID format → explain format
   - Database not initialized → suggest `grafema analyze`

### What About `trace "X from Y"`?

That's a **separate issue**. The current implementation is a hack:
```typescript
if (!file.toLowerCase().includes(scopeName.toLowerCase())) continue;
```

This needs proper scope-based lookup. But that's a different problem from REG-179.

**Decision:** Fix the immediate usability problem first (add `get` command).
File a separate issue for improving `trace` scope filtering.

## Alignment with Vision

From `CLAUDE.md`:
> **AI-first tool:** Every function must be documented for LLM-based agents.

An AI agent will:
1. Run `grafema trace "response"`
2. See the semantic ID in output
3. Try to use that ID in a follow-up query
4. **Expect it to work**

This is the happy path. We MUST support it.

From the project vision:
> **If reading code gives better results than querying Grafema — that's a product gap.**

Right now, if an AI agent wants node details, it's easier to:
- Read the file at that location
- Parse the code manually

Than to use Grafema's semantic ID. That's embarrassing.

## Risk Analysis

**If we do nothing:**
- Users lose trust ("why show IDs if I can't use them?")
- AI agents will abandon Grafema for direct code reading
- We undermine our own semantic ID investment

**If we patch `query` with `--id`:**
- Command becomes conceptually messy (search OR lookup?)
- Two code paths with different performance characteristics
- Confusing documentation ("when do I use --id vs pattern?")

**If we add `get` command:**
- One more command to learn (minor)
- Clear separation of concerns (major win)
- Foundation for future enhancements (inspect, explain, etc.)

## Technical Debt Considerations

None. This is additive:
- New command, doesn't touch existing code
- Reuses existing backend capabilities
- No changes to storage layer or semantic ID logic

## Next Steps

1. Joel creates detailed technical plan
2. Implementation by Rob
3. Kevlin reviews code quality
4. Linus reviews alignment with vision

## Open Questions for Joel

1. Should `get` show ALL edges, or limit (e.g., first 10 per direction)?
2. JSON output format - match `query` format or something new?
3. Should we support multiple IDs at once? `grafema get id1 id2 id3`
4. Error message when ID not found - suggest `query` for search?

## Acceptance Criteria

1. `grafema get <semantic-id>` returns node details + edges
2. Works for any semantic ID shown by `trace`, `query`, etc.
3. Clear error when node not found
4. JSON output mode for scripting
5. Documentation in `--help` and README

**Success metric:** AI agent can:
```
1. grafema trace "response"
2. Copy semantic ID from output
3. grafema get <that-id>
4. Get full node details
```

Without errors. Without workarounds. Without reading files.

---

**This is the right thing to do.**
Not because it's easy (it is).
Because it's what users expect when we show them an identifier.

