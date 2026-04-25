# User Decision on Architectural Mismatch

**Date:** 2026-01-21

## Problem
ImportNode contract used `importKind` but GraphBuilder used `importType` — different concepts.

## Decision
Both fields are needed:

| Field | Type | Meaning |
|-------|------|---------|
| `importType` | `'default' \| 'named' \| 'namespace'` | HOW it's imported (syntax) |
| `importBinding` | `'value' \| 'type' \| 'typeof'` | WHAT is imported (TypeScript semantics) |

## Rationale
- `importKind` was too vague — renamed to `importBinding` for clarity
- Both concepts are orthogonal: `import type { Foo }` is `named` + `type`
- Grafema needs both for accurate TypeScript analysis
