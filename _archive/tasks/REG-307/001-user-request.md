# REG-307: Improve query command UX with natural language support

## Problem

The `grafema query` command has poor UX. Users need to know Datalog syntax or semantic ID structure to find nodes effectively.

From REG-177 experience: user spent 15 minutes trying to find a variable that WAS in the graph but couldn't be queried intuitively.

## Proposed Solution

Add natural language query support:

```bash
# Simple name search
grafema query "response"
→ Shows all nodes named "response" across all files

# Scoped search
grafema query "response in fetchData"
→ Shows all "response" nodes inside "fetchData" function scope

# File-scoped search
grafema query "response in src/app.ts"
→ Shows all "response" nodes in that file

# Type-filtered search
grafema query "variable response"
→ Shows only VARIABLE nodes named "response"

# Combined
grafema query "variable response in fetchData in src/app.ts"
→ Precise, readable, discoverable
```

## Why This Matters

From CLAUDE.md vision: "AI should query the graph, not read code."

Currently users must:

1. Run `grafema explain <file>` to discover what exists
2. Copy semantic ID
3. Paste into `grafema query --raw '...'`

This violates the vision. Query should be intuitive enough that `explain` becomes a debug-only tool.

## Acceptance Criteria

1. `grafema query "name"` finds nodes by name
2. `grafema query "name in file"` scopes to file
3. `grafema query "name in scope"` scopes to function/class
4. `grafema query "type name"` filters by node type
5. Results show enough context to understand what was found

## Context

Created as follow-up from REG-177 per Linus review.
