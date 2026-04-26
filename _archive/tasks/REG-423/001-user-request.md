# REG-423: Refactor GraphBuilder.ts — Extract Domain Builders

## Request

Decompose GraphBuilder.ts (3,788 lines) — extract `bufferXxx` methods into domain-specific builders.

## Current State

GraphBuilder has a clean pattern: each `bufferXxxEdges/Nodes` method is standalone. Groups by domain:

| Group | Methods | ~lines |
|-------|---------|--------|
| Core edges | functions, scopes, variables, calls | 350 |
| Control flow | loops, branches, cases, try/catch | 410 |
| Data flow | assignments, returns, yields, mutations, updates | 1,250 |
| TypeScript | interfaces, types, enums, decorators | 285 |
| External/IO | imports, exports, HTTP, events, stdio | 280 |
| Orchestration | build() + flush | 378 |

## Plan

1. Uncle Bob review — analyze dependencies, determine split boundaries
2. Extract domain builders (one builder = one commit)
3. Rewrite GraphBuilder as orchestrator (~400 lines)

## Acceptance Criteria

- GraphBuilder.ts < 500 lines (orchestration only)
- Each builder in its own file
- All snapshot tests pass
- `build()` method readable in 30 seconds
